/**
 * Claude spend — how much of a monthly dollar budget the goo canister has burned down.
 *
 * There is no API for "percent of your plan left"; the only local signal is the same one tools
 * like ccusage read: Claude Code's own transcripts at `~/.claude/projects/**​/*.jsonl`, where
 * every assistant turn logs the tokens it spent. This sums that across every project on the
 * machine — the plan is shared account-wide, not per repo — and prices it the same way ccusage
 * does: per-token-type, per model tier, converted to dollars against a budget you set yourself,
 * since neither the real dollar figure nor the real limit is ever actually visible.
 *
 * The window is the calendar month, first day to last — no reset button needed, since a month
 * boundary is a date rather than something to click.
 *
 * Read-only, the same as every harness adapter: nothing here writes to a transcript, only to
 * this feature's own small config file.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'usage.json')

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/** A round number to open on — not a real plan figure, since Anthropic doesn't publish one. */
const DEFAULT_BUDGET_USD = 2000

let config = null

async function loadConfig() {
  if (config) return config
  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'))
    config = { budgetUsd: Number(raw.budgetUsd) > 0 ? Number(raw.budgetUsd) : DEFAULT_BUDGET_USD }
  } catch {
    config = { budgetUsd: DEFAULT_BUDGET_USD }
    await persist()
  }
  return config
}

async function persist() {
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export async function setBudget(budgetUsd) {
  const n = Number(budgetUsd)
  if (!Number.isFinite(n) || n <= 0) throw new Error('budgetUsd must be a positive number')
  await loadConfig()
  config.budgetUsd = n
  await persist()
  return usageSnapshot()
}

/** The calendar month containing `at` (default: now), as `[start, end)` in epoch ms. */
function monthBounds(at = Date.now()) {
  const d = new Date(at)
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return { start, end }
}

/**
 * Dollars per million tokens, by pricing tier. A model's rate has held steady across every
 * Claude generation released so far, so this keys off the tier named in the model id rather
 * than a table that needs a new row on every release. `ccusage` pulls the equivalent table
 * fresh off the network, from LiteLLM's pricing data; this is a frozen copy of Anthropic's
 * published rates at the time it was written, so the canister keeps working offline — and
 * needs revisiting if a future tier's pricing actually moves.
 */
const PRICING = {
  opus: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
}

/** Sonnet is both the middle tier and the safest guess for a model id this table has never
 *  seen — new model, same shape of pricing, far more often than it is an Opus-priced outlier. */
function tierFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return PRICING.opus
  if (m.includes('haiku')) return PRICING.haiku
  return PRICING.sonnet
}

/** `usage` is a transcript line's own `message.usage` block; `model` is that line's `message.model`. */
function costFor(usage, model) {
  if (!usage) return 0
  const price = tierFor(model)
  const perM = (n, rate) => (n / 1_000_000) * rate
  // Newer transcripts split a cache write into its 5-minute and 1-hour TTLs, priced
  // differently; older ones only ever wrote the short-lived kind, so that is the fallback.
  const cache = usage.cache_creation
  const write5m = cache ? cache.ephemeral_5m_input_tokens || 0 : usage.cache_creation_input_tokens || 0
  const write1h = cache ? cache.ephemeral_1h_input_tokens || 0 : 0
  return (
    perM(usage.input_tokens || 0, price.input) +
    perM(usage.output_tokens || 0, price.output) +
    perM(write5m, price.cacheWrite5m) +
    perM(write1h, price.cacheWrite1h) +
    perM(usage.cache_read_input_tokens || 0, price.cacheRead)
  )
}

/**
 * One entry per file: how much of it has been read (`readBytes`, always a whole number of
 * lines) and the `{ ts, usd }` pairs found so far. Re-parsing every transcript on the machine
 * from byte zero every poll would mean a scan that gets slower forever, so a file only ever
 * has its *new* bytes read — the same trick `tail -f` uses.
 */
const fileCache = new Map()

async function* transcriptFiles() {
  let projectDirs
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return // no Claude Code projects directory on this machine
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(PROJECTS_DIR, d.name)
    let files
    try {
      files = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) yield path.join(dir, f.name)
    }
  }
}

/** Read whatever of `filePath` hasn't been read yet, and fold any new spend into the cache.
 *  `added` is just the entries found *this call* — nobody but the burst-detection in
 *  `usageSnapshot` cares about that slice, everyone else wants the full `entries`. */
async function readNewEntries(filePath, cached) {
  const stat = await fsp.stat(filePath)
  if (cached && stat.size === cached.size) return { ...cached, added: [] }

  // A file that shrank is not one this cache's byte offset still means anything against — a
  // rotated or truncated transcript, in practice never a session Claude Code is still writing.
  const startAt = cached && cached.readBytes <= stat.size ? cached.readBytes : 0
  const entries = startAt > 0 ? cached.entries : []
  const added = []
  const length = stat.size - startAt
  if (length <= 0) return { size: stat.size, readBytes: startAt, entries, added }

  const handle = await fsp.open(filePath, 'r')
  let consumed = 0
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, startAt)
    const text = buf.toString('utf8')
    // The last line may be mid-write; leave it for the next scan rather than risk a partial
    // JSON parse silently losing that entry's spend forever.
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak < 0) return { size: stat.size, readBytes: startAt, entries, added }
    const complete = text.slice(0, lastBreak)
    consumed = Buffer.byteLength(complete, 'utf8') + 1

    for (const line of complete.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'assistant' || !obj.message?.usage) continue
        const ts = Date.parse(obj.timestamp)
        const usd = costFor(obj.message.usage, obj.message.model)
        if (Number.isFinite(ts) && usd > 0) {
          const entry = { ts, usd }
          entries.push(entry)
          added.push(entry)
        }
      } catch {
        // A half-flushed or corrupt line. Skipping it costs one entry's spend, which is
        // nothing next to a scan that throws and takes the whole canister dark with it.
      }
    }
  } finally {
    await handle.close()
  }
  return { size: stat.size, readBytes: startAt + consumed, entries, added }
}

/** `<sessionId>.jsonl` is the whole filename Claude Code writes; that id is also, prefixed,
 *  the astronaut's own thread id — see `ID` in `harnesses/claude-code.mjs`. */
function threadIdFor(filePath) {
  return `claude-code:${path.basename(filePath, '.jsonl')}`
}

/**
 * Whether `fileCache` has ever been populated. The very first scan reads each transcript's
 * whole month of history in one gulp, which would otherwise look exactly like a burst of new
 * spend on every session at once — so nothing is reported as "new" until the second scan.
 */
let warmedUp = false

/** Below this, a "new" charge is float noise from a cache read, not something worth a burst. */
const MIN_BURST_USD = 0.001

/** Everything the goo canister needs to draw itself. */
export async function usageSnapshot() {
  const { budgetUsd } = await loadConfig()
  const { start: monthStart, end: monthEnd } = monthBounds()

  let usedUsd = 0
  const bursts = []
  for await (const file of transcriptFiles()) {
    let result
    try {
      result = await readNewEntries(file, fileCache.get(file))
    } catch {
      continue // the session that owned this file ended and cleaned up mid-scan — skip it
    }
    // Entries from before this month are dead weight forever, not just this scan, so this is
    // also where the cache is trimmed back down — and, come the 1st, where last month's spend
    // actually falls away, since nothing else ever prunes on a date rather than a byte offset.
    if (result.entries.length && result.entries[0].ts < monthStart) {
      result.entries = result.entries.filter((e) => e.ts >= monthStart)
    }
    fileCache.set(file, result)
    for (const e of result.entries) usedUsd += e.usd

    if (warmedUp && result.added.length) {
      const usd = result.added.reduce((sum, e) => sum + e.usd, 0)
      if (usd >= MIN_BURST_USD) bursts.push({ threadId: threadIdFor(file), usd, count: result.added.length })
    }
  }
  warmedUp = true

  const remainingPct = budgetUsd > 0 ? Math.max(0, Math.min(1, 1 - usedUsd / budgetUsd)) : 1

  /**
   * Burn rate against the calendar, not against the budget: spending half your budget on day 1
   * is not "50% left", it is badly off pace, so the canister's colour is driven by this rather
   * than by `remainingPct`. 1.0 is dead on pace (the share of the budget spent equals the share
   * of the month elapsed); above 1 is spending faster than the month is passing.
   *
   * `pctElapsed` is floored rather than left to approach zero, so a burst of spend in the first
   * few minutes of the month reads as "badly over pace" rather than as a division blowing up to
   * a meaningless, off-the-chart number.
   */
  const pctUsed = budgetUsd > 0 ? usedUsd / budgetUsd : 0
  const pctElapsed = Math.max(0.01, Math.min(1, (Date.now() - monthStart) / Math.max(1, monthEnd - monthStart)))
  const pace = pctUsed / pctElapsed

  return { usedUsd, budgetUsd, monthStart, monthEnd, remainingPct, pace, bursts, scannedAt: Date.now() }
}
