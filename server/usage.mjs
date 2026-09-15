/**
 * Claude plan usage — how much of the token budget behind the goo canister has burned down.
 *
 * There is no API for "percent of your plan left"; the only local signal is the same one tools
 * like ccusage read: Claude Code's own transcripts at `~/.claude/projects/**​/*.jsonl`, where
 * every assistant turn logs the tokens it spent. This sums that across every project on the
 * machine — the plan is shared account-wide, not per repo — against a token budget and a reset
 * time you set yourself, since neither is ever actually visible.
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

/**
 * Sized against a real Pro plan's weekly bucket rather than picked out of the air: on one
 * account, summing this same tally (input + output + cache-creation + cache-read tokens) since
 * the weekly window's own reset time landed at roughly 10% of what the account's usage panel
 * reported for that window — implying a limit somewhere around 1.8B by this accounting.
 *
 * That is an order-of-magnitude estimate, not a published number — cache-read tokens almost
 * certainly count for less toward the real limit than they do in this sum, which is also why a
 * *shorter* window (the 5-hour one) implied a limit that does not scale with this one the way
 * constant usage would predict. Good enough to make the canister mean something the moment you
 * turn it on; expect to nudge it once you've watched it drift against your own plan for a week.
 */
const DEFAULT_MAX_TOKENS = 1_800_000_000

let config = null

async function loadConfig() {
  if (config) return config
  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'))
    config = {
      maxTokens: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : DEFAULT_MAX_TOKENS,
      resetAt: Number(raw.resetAt) || Date.now(),
    }
  } catch {
    config = { maxTokens: DEFAULT_MAX_TOKENS, resetAt: Date.now() }
    await persist()
  }
  return config
}

async function persist() {
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export async function setMaxTokens(maxTokens) {
  const n = Number(maxTokens)
  if (!Number.isFinite(n) || n <= 0) throw new Error('maxTokens must be a positive number')
  await loadConfig()
  config.maxTokens = Math.round(n)
  await persist()
  return usageSnapshot()
}

export async function resetUsage() {
  await loadConfig()
  config.resetAt = Date.now()
  await persist()
  return usageSnapshot()
}

/**
 * One entry per file: how much of it has been read (`readBytes`, always a whole number of
 * lines) and the `{ ts, tokens }` pairs found so far. Re-parsing every transcript on the
 * machine from byte zero every poll would mean a scan that gets slower forever, so a file only
 * ever has its *new* bytes read — the same trick `tail -f` uses.
 */
const fileCache = new Map()

function tokensFor(usage) {
  if (!usage) return 0
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  )
}

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

/** Read whatever of `filePath` hasn't been read yet, and fold any new usage into the cache. */
async function readNewEntries(filePath, cached) {
  const stat = await fsp.stat(filePath)
  if (cached && stat.size === cached.size) return cached

  // A file that shrank is not one this cache's byte offset still means anything against — a
  // rotated or truncated transcript, in practice never a session Claude Code is still writing.
  const startAt = cached && cached.readBytes <= stat.size ? cached.readBytes : 0
  const entries = startAt > 0 ? cached.entries : []
  const length = stat.size - startAt
  if (length <= 0) return { size: stat.size, readBytes: startAt, entries }

  const handle = await fsp.open(filePath, 'r')
  let consumed = 0
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, startAt)
    const text = buf.toString('utf8')
    // The last line may be mid-write; leave it for the next scan rather than risk a partial
    // JSON parse silently losing that entry's tokens forever.
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak < 0) return { size: stat.size, readBytes: startAt, entries }
    const complete = text.slice(0, lastBreak)
    consumed = Buffer.byteLength(complete, 'utf8') + 1

    for (const line of complete.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'assistant' || !obj.message?.usage) continue
        const ts = Date.parse(obj.timestamp)
        const tokens = tokensFor(obj.message.usage)
        if (Number.isFinite(ts) && tokens > 0) entries.push({ ts, tokens })
      } catch {
        // A half-flushed or corrupt line. Skipping it costs one entry's tokens, which is
        // nothing next to a scan that throws and takes the whole canister dark with it.
      }
    }
  } finally {
    await handle.close()
  }
  return { size: stat.size, readBytes: startAt + consumed, entries }
}

/** Everything the goo canister needs to draw itself. */
export async function usageSnapshot() {
  const { maxTokens, resetAt } = await loadConfig()

  let usedTokens = 0
  for await (const file of transcriptFiles()) {
    let result
    try {
      result = await readNewEntries(file, fileCache.get(file))
    } catch {
      continue // the session that owned this file ended and cleaned up mid-scan — skip it
    }
    // Entries from before the last reset are dead weight forever, not just this scan, so
    // this is also where the cache is trimmed back down.
    if (result.entries.length && result.entries[0].ts < resetAt) {
      result.entries = result.entries.filter((e) => e.ts >= resetAt)
    }
    fileCache.set(file, result)
    for (const e of result.entries) usedTokens += e.tokens
  }

  const remainingPct = maxTokens > 0 ? Math.max(0, Math.min(1, 1 - usedTokens / maxTokens)) : 1
  return { usedTokens, maxTokens, resetAt, remainingPct, scannedAt: Date.now() }
}
