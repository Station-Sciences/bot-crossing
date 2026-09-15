/**
 * Harness adapter: OpenClaw — the agent gateway this machine itself runs on.
 *
 * Everything that knows the shape of OpenClaw's own files lives in this one module, per the
 * contract in `server/harnesses/README.md`. Sessions are JSONL transcripts under
 * `~/.openclaw/agents/<agentId>/sessions/`, one file per conversation, each opening with a
 * `{"type":"session", …}` header line carrying the id, the start time and the cwd.
 *
 * Beside the plain `<uuid>.jsonl` transcripts the directory holds per-topic continuations
 * (`<uuid>-topic-<ts>.jsonl` — a Slack thread spun out of a session, with the parent's id in
 * its header), trajectory mirrors (`.trajectory.jsonl`), checkpoint snapshots
 * (`.checkpoint.<uuid>.jsonl`), path sidecars, and deleted-file tombstones (`.deleted.<ts>`).
 * Only the conversation transcripts are read here; the topic files are included because they
 * are real conversations, and each carries the session id in its header, so they key cleanly.
 *
 * The head also names the *repo* a session actually worked on. Almost every session starts in
 * the shared workspace, so `cwd` alone would pile every project onto one plot; the repo is
 * voted out of the paths, GitHub refs and command lines the transcript mentions — see
 * `detectProject`.
 *
 * The transcript head is also where the *kind* of a session shows. OpenClaw writes no
 * parent-child metadata, but the openings are distinctive: a webhook arrives as
 * `Task: <source> | Job ID: …` wrapped around an untrusted-content fence, a cron fire as
 * `[cron:<id> <label>]`, a heartbeat poll as its own fixed line, and a spawned sub-agent as a
 * `[Subagent Context]` opener under an agent other than `main`. Cost arrives the same way —
 * `usage.cost.total` on every assistant message — so a session's spend is summed out of the
 * head plus the tail without reading a long transcript whole. All of it is cached against
 * mtime and size, exactly like the rest of the metadata.
 *
 * Read-only, without exception. OpenClaw writes these files while it works; this adapter only
 * ever opens them for reading and never writes one byte back.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
/** Every agent's transcripts live under here: `~/.openclaw/agents/<agentId>/sessions/`. */
const AGENTS = path.join(HOME, '.openclaw', 'agents')

/**
 * The head carries all the metadata there is: the session header, the model/thinking-level
 * changes, the first user message, the runtime-context records that say where the session
 * came from, and the first stretch of assistant usage. 64KB has covered every transcript
 * tried against it, and `readHead` drops a trailing partial line so a file mid-write parses
 * cleanly anyway.
 */
const HEAD_BYTES = 64 * 1024
/**
 * The tail of a long session carries its latest usage records. Cost is summed from the head
 * plus the tail, so a session that ran for hours still reports what it spent — the middle of
 * a very long transcript is knowingly left unread.
 */
const TAIL_BYTES = 64 * 1024
/** Smaller than this is a stub or a truncated write, not a conversation. */
const MIN_SIZE = 100
/** First messages and runtime context are capped before caching — titles only need the start. */
const PROMPT_MAX = 8 * 1024
/** How much runtime-context to keep for classification, per session. */
const CONTEXT_MAX = 8 * 1024
/**
 * How much of a transcript the chat panel reads. All but a handful of sessions on a real
 * machine sit well under this, so it is the whole conversation; the rare giant is read to
 * the cap and honestly truncated at its head, the same trade the scan's windows make.
 */
const TRANSCRIPT_MAX_BYTES = 1024 * 1024
/** A single message is capped before it crosses the wire — the panel clips for display anyway. */
const TRANSCRIPT_MSG_MAX = 4000

/**
 * How recently a transcript must have moved to be worth a live probe. Older than this and the
 * session is simply over; the mtime answers on its own.
 */
const ACTIVE_WINDOW_MS = 2 * 60 * 1000
/**
 * Within this window a session may still be running, and pays for a double-stat probe to
 * find out — see `checkRunning`. Inside it, a file that is not growing can still be
 * *thinking*: input landed moments ago and the model has not begun writing its reply yet,
 * so the tail is read to tell that apart from a session that simply ended.
 */
const FRESH_WINDOW_MS = 60 * 1000
/** The pause between the two stats of `checkRunning`, long enough for a write to land. */
const PROBE_DELAY_MS = 150
/** How much tail `checkRunning` reads to tell "thinking" from "done" — the last record only. */
const THINKING_TAIL_BYTES = 32 * 1024

/**
 * Every id this adapter hands out is prefixed with the harness and the agent, so ids stay
 * unique across harnesses and across agents — two agents never share a session namespace.
 */
const ID = (agentId, sessionId) => `openclaw:${agentId}:${sessionId}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Session ids are UUIDs and agent ids are directory names; both are pattern-checked before
// they reach the URL builder, because `ref` makes a round trip through the browser.
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isUuid = (v) => typeof v === 'string' && UUID.test(v)
const isAgentId = (v) => typeof v === 'string' && AGENT_ID.test(v)

/** Where the web UI is. The gateway's own port, overridable for a non-default install. */
const webUrl = () =>
  (process.env.OPENCLAW_URL || `http://${process.env.OPENCLAW_HOST || 'localhost'}:${process.env.OPENCLAW_PORT || '18789'}`)

/** Clip to a length, marking the cut with an ellipsis. */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * A transcript file is a `.jsonl` that is none of the sidecars: not a trajectory mirror, not
 * a deleted-file tombstone, and not a `.checkpoint.` snapshot. Checkpoints are recovery
 * artifacts — copies of a conversation at a moment, written beside it — and when the parent
 * transcript has since been pruned the checkpoint is a ghost of a session the gateway itself
 * no longer lists, so it is left out rather than shown as a thread that cannot open.
 */
const isTranscript = (name) =>
  name.endsWith('.jsonl') &&
  !name.includes('.trajectory') &&
  !name.includes('.deleted.') &&
  !name.includes('.checkpoint.')

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

/**
 * Turn a raw first message into what a person would say the thread is about.
 *
 * OpenClaw wraps almost everything it hands the model — webhook payloads inside untrusted-
 * content fences, cron fires in `[cron:<id> <label>]` brackets, Slack origins in
 * `System (untrusted)` prefaces, media instructions in `[media attached: …]` blocks. Each
 * wrapper is stripped in the order the wrappers actually nest, until what is left is the
 * message itself. Pure scaffolding — a sub-agent opener, whose real task lives in the system
 * prompt — comes back empty so the caller can fall back to the first thing the worker said.
 */
function cleanMessage(raw) {
  let s = String(raw || '')
  if (s.startsWith('[OpenClaw heartbeat poll]')) return 'Heartbeat poll'
  // Cron fires open with `[cron:<id> <label>]` — the label is the identity, the rest is machinery.
  s = s.replace(/^\[cron:[0-9a-f-]+ ([^\]]*)\]\s*/, (_m, label) => (label ? `${label}: ` : ''))
  // Webhook/cron envelope: `Task: <source> | Job ID: … | Received: …` — one metadata line.
  if (s.startsWith('Task: ') && s.includes('| Job ID:')) s = s.replace(/^Task:[^\n]*\| Job ID:[^\n]*\n+/, '')
  // The payload itself sits inside an untrusted-content fence behind a `Source: …` header;
  // a fenceless security notice is cut after its last boilerplate bullet instead.
  const fenced = /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT/.exec(s)
  if (fenced) {
    s = fenced[1].replace(/^Source:[^\n]*\n---\n?/, '')
  } else if (s.includes('SECURITY NOTICE:')) {
    s = s.replace(/^[\s\S]*?Send messages to third parties[^\n]*\n+/, '')
  }
  // Slack prefaces: `System (untrusted): [ts] Slack DM from <name>: …` — the message is the rest.
  s = s.replace(/^System \(untrusted\): \[[^\]]*\]\s*/, '')
  s = s.replace(/^(?:Slack DM from [^:\n]+|Slack message in #[^\s:]+ from [^:\n]+):\s*/, '')
  // Inbound metadata blocks trail the message they describe — cut at the first of them.
  for (const marker of ['Conversation info (untrusted metadata)', 'Sender (untrusted metadata)']) {
    const at = s.indexOf(marker)
    if (at >= 0) s = s.slice(0, at)
  }
  s = s.replace(/\n?Current time:[^\n]*$/, '')
  // Media instructions and gateway timestamps lead the message body proper.
  s = s.replace(/^\[media attached:[^\]]*\]\s*/, '')
  s = s.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* \d{4}-\d{2}-\d{2} [\d:]+ [A-Z]{2,5}\]\s*/, '')
  // Sub-agent openers are pure scaffolding: the task is in the system prompt, not here.
  s = s.replace(/^\[Subagent Context\]\s*/, '')
  if (s.startsWith('You are running as a subagent')) return ''
  // A plain `Task: …` opener names a task — keep the task, drop the label.
  s = s.replace(/^Task:\s*/, '')
  // Whatever tag-wrapped noise is left (runtime context, hook payloads), and the whitespace.
  s = s.replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * What kind of session this is, from the shape of its first user message and the agent that
 * ran it. The message-level shapes are tested before the agent, because a heartbeat or a
 * cron that fires on a worker agent is still a heartbeat or a cron, not a sub-agent task:
 *
 *   - `[OpenClaw heartbeat poll]` — the gateway polling an agent
 *   - `[cron:<id> <label>]` — a scheduled fire
 *   - `Task: <source> | Job ID: …` — a webhook (Hook, GitHub, …) or a cron delivery
 *   - the SECURITY NOTICE fence — an external, untrusted payload
 *   - and, failing all of that, an agent other than `main` — or a `[Subagent Context]`
 *     opener under any agent — which is a spawned worker by construction
 */
function classifySession(agentId, text) {
  if (text.startsWith('[OpenClaw heartbeat poll]')) return { type: 'heartbeat', routine: 'heartbeat' }
  if (text.startsWith('[cron:')) return { type: 'cron', routine: 'cron' }
  const task = /^Task: ([^|\n]+)/.exec(text)
  if (task && text.includes('| Job ID:')) {
    return task[1].trim().toLowerCase() === 'cron'
      ? { type: 'cron', routine: 'cron' }
      : { type: 'webhook', routine: 'webhook' }
  }
  if (text.includes('SECURITY NOTICE: The following content is from an EXTERNAL')) {
    return { type: 'webhook', routine: 'webhook' }
  }
  if (agentId !== 'main' || text.includes('[Subagent Context]')) {
    return { type: 'subagent', routine: 'subagent' }
  }
  return { type: 'conversation', routine: '' }
}

/**
 * Where a Slack-originated session came in from, read off the first message and the
 * runtime-context records beside it — the transcript's own `System (untrusted)` preface says
 * "DM from <name>" or "message in #<channel>", and the inbound metadata block says
 * `"channel": "slack"` when neither spelling shows. That last marker is only trusted in
 * runtime context: the same key appears in tool traffic for messages the agent *sent*,
 * which says nothing about where the session came from.
 */
function slackTagOf(userText, contextText) {
  const text = `${userText}\n${contextText}`
  if (/Slack message in #[^\s:"\\]+/.test(text)) return 'slack-channel'
  if (/Slack DM from /.test(text)) return 'slack-dm'
  if (contextText.includes('"channel": "slack"')) return 'slack'
  return ''
}

/**
 * The repo a session actually worked on, read out of what its transcript head says rather
 * than where it was launched. Nearly every OpenClaw session starts in the shared workspace,
 * so `cwd` alone would pile every project onto one plot — the head names the real work as
 * file paths in tool calls, GitHub refs in task text, and `cd`/docker/git command lines, and
 * the most-mentioned repo wins the vote. A `cwd` already under `repos/` answers first: a
 * checkout of its own is the one source that cannot be a misread. `gpt-skills` is skipped
 * on the mention count — it holds skills, not a project anyone would want a zone for.
 *
 * Returns `{ project, projectPath }`, or null when nothing names a repo and the caller
 * should keep its cwd-based answer.
 */
const REPO_PATH = /\/repos\/([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/g
const GITHUB_REF = /(?:brightfire|chaitthegreat)\/([a-zA-Z0-9_-]+)/g

function detectProject(records, cwd) {
  const cwdMatch = /\/repos\/([^/]+)/.exec(cwd || '')
  if (cwdMatch) return { project: cwdMatch[1], projectPath: cwd }
  const mentions = new Map()
  const count = (name) => {
    if (!name || name === 'gpt-skills') return
    mentions.set(name, (mentions.get(name) || 0) + 1)
  }
  for (const r of records) {
    // Brute force, but the regexes are specific enough to earn it: one stringify catches
    // repo names in every place a transcript has of writing them — tool-call paths, PR refs
    // in task text, command lines — without walking each record's shape by hand.
    let text
    try {
      text = JSON.stringify(r)
    } catch {
      continue
    }
    for (const m of text.matchAll(REPO_PATH)) count(m[1])
    for (const m of text.matchAll(GITHUB_REF)) count(m[1])
  }
  let best = ''
  let bestCount = 0
  for (const [name, n] of mentions) {
    if (n > bestCount) {
      best = name
      bestCount = n
    }
  }
  if (!best) return null
  return { project: best, projectPath: path.join(HOME, 'repos', best) }
}

/**
 * The pull request a session worked on, when its head says so. Transcripts mention PRs
 * two ways — a GitHub URL (`github.com/<owner>/<repo>/pull/<n>`) or plain text ("PR #123",
 * "pull request 123") — and the *last* mention in the head wins, because a session that
 * opened a PR and then saw it merged tells the story in that order. State is read from the
 * same record as the mention: the words around "PR #123 was merged" are what carry it, and
 * a later record that names the number again can supersede the state. A mention with no
 * state words at all leaves whatever the earlier records said.
 *
 * Deliberately head-only: a merge landing deep in a long transcript is not seen, the same
 * trade every other question here makes about the cost of reading a file whole.
 */
const PR_URL_PATTERN = /github\.com\/([^/\s"']+?)\/([^/\s"']+?)\/pull\/(\d+)/g
const PR_TEXT_PATTERN = /\b(?:PR|pull request)s?\s*#?(\d+)/gi

/** The words a transcript uses to say what happened to a PR, in the order they should win. */
function prStateOf(text) {
  const t = String(text).toLowerCase()
  if (t.includes('merged') || t.includes('gh pr merge')) return 'MERGED'
  if (t.includes('approved')) return 'APPROVED'
  if (t.includes('closed')) return 'CLOSED'
  if (t.includes('draft')) return 'DRAFT'
  return ''
}

function detectPr(records) {
  let pr = null
  for (const r of records) {
    let text
    try {
      text = JSON.stringify(r)
    } catch {
      continue
    }
    let hit = null
    for (const m of text.matchAll(PR_URL_PATTERN)) hit = { number: m[3], repo: m[2] }
    if (!hit) {
      for (const m of text.matchAll(PR_TEXT_PATTERN)) hit = { number: m[1], repo: '' }
    }
    if (!hit) continue
    const state = prStateOf(text)
    pr = {
      number: hit.number,
      repo: hit.repo || pr?.repo || '',
      state: state || (pr?.number === hit.number ? pr.state : '') || '',
    }
  }
  return pr
}

/**
 * Pull whatever a transcript head knows about itself. The session header leads the file and
 * is the only source for the id, the start time and the cwd; the model arrives either as a
 * `model_change` event or on the first assistant message, and the thinking level as a
 * `thinking_level_change` event. Cost rides on every assistant message's `usage`, so the
 * head's messages are summed as they are read. Anything absent stays absent — an adapter
 * reports what is there rather than inventing the rest.
 */
function readTranscriptMeta(records) {
  const meta = {
    sessionId: '',
    startedAt: 0,
    cwd: '',
    firstUserText: '',
    firstAssistantText: '',
    contextText: '',
    model: '',
    effort: '',
    headCost: 0,
    headTokens: 0,
    costIds: [],
  }
  for (const r of records) {
    if (!meta.sessionId && r.type === 'session') {
      if (isUuid(r.id)) meta.sessionId = r.id
      if (r.timestamp) {
        const t = Date.parse(r.timestamp)
        if (!Number.isNaN(t)) meta.startedAt = t
      }
      if (typeof r.cwd === 'string') meta.cwd = r.cwd
    }
    if (!meta.model && r.type === 'model_change' && typeof r.modelId === 'string') {
      meta.model = r.modelId
    }
    if (!meta.effort && r.type === 'thinking_level_change' && typeof r.thinkingLevel === 'string') {
      meta.effort = r.thinkingLevel
    }
    if (!meta.firstUserText && r.type === 'message' && r.message?.role === 'user') {
      const text = firstText(r.message.content)
      if (text) meta.firstUserText = text.slice(0, PROMPT_MAX)
    }
    // Runtime-context records frame what the model is looking at — the Slack DM or channel a
    // message arrived through lives here, ahead of or just behind the first user message.
    if (
      r.type === 'custom_message' &&
      r.customType === 'openclaw.runtime-context' &&
      typeof r.content === 'string' &&
      meta.contextText.length < CONTEXT_MAX
    ) {
      meta.contextText += (meta.contextText ? '\n' : '') + r.content.slice(0, CONTEXT_MAX)
    }
    if (r.type === 'message' && r.message?.role === 'assistant') {
      // The model can also ride on an assistant message when no `model_change` was written —
      // keep looking for one until the model is known.
      if (!meta.model && typeof r.message.model === 'string' && r.message.model) meta.model = r.message.model
      // The first thing the worker *said* — thinking and tool calls skipped — is the best
      // name a sub-agent session has, since its task text never reaches the transcript.
      if (!meta.firstAssistantText) {
        const text = firstText(r.message.content)
        if (text) meta.firstAssistantText = text.slice(0, 1024)
      }
      const usage = r.message.usage
      if (usage && typeof usage === 'object') {
        if (typeof usage.cost?.total === 'number') meta.headCost += usage.cost.total
        if (typeof usage.totalTokens === 'number') meta.headTokens += usage.totalTokens
        // Ids of the records already counted, so the tail pass can skip them.
        if (r.id) meta.costIds.push(r.id)
      }
    }
  }
  // The repo the session actually worked on, when the head names one — kept in the meta
  // cache like everything else here, so the vote is counted once per changed file.
  const detected = detectProject(records, meta.cwd)
  if (detected) {
    meta.project = detected.project
    meta.projectPath = detected.projectPath
  }
  // The PR the session worked on, if the head names one — a merged PR is what turns an
  // astronaut's status to celebrating, so it rides on the meta like the model does.
  meta.pr = detectPr(records)
  return meta
}

/**
 * Whether a voted-for repo is really checked out. Answers are cached per path: the scan
 * asks the same handful of questions thousands of times over, and a repo cloned after the
 * server started is picked up the same way every other cached fact here is — when a
 * transcript next moves.
 */
const repoOnDiskCache = new Map()
async function repoOnDisk(p) {
  let known = repoOnDiskCache.get(p)
  if (known === undefined) {
    known = await exists(p)
    repoOnDiskCache.set(p, known)
  }
  return known
}

/**
 * Head parsing is kept against mtime and size, so an unchanged transcript is read once. With
 * thousands of session files and the scanner on a poll, this is what keeps the colony cheap
 * to leave open — the same trick as `transcriptMeta` in `claude-code.mjs`.
 */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const hit = metaCache.get(entry.file)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.meta
  let meta
  try {
    meta = readTranscriptMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
  } catch {
    /* mid-write, or gone — report nothing rather than half a session */
    meta = readTranscriptMeta([])
  }
  // A vote only counts when the repo is really on the machine — one stray `brightfire/word`
  // in a task text is not a project, and the zones are for repos you can walk to. Cwd-based
  // answers are exempt: the cwd is where the thread ran, present or not.
  if (meta.project && meta.projectPath !== meta.cwd && !(await repoOnDisk(meta.projectPath))) {
    delete meta.project
    delete meta.projectPath
  }
  // A session longer than the head spends most of its tokens after it, and the tail carries
  // the latest usage records. Records already counted in the head are skipped by id, so a
  // file small enough for the two chunks to overlap is never counted twice.
  if (entry.size > HEAD_BYTES) {
    try {
      const seen = new Set(meta.costIds)
      for (const r of jsonLines(await readTail(entry.file, TAIL_BYTES))) {
        if (r.type !== 'message' || r.message?.role !== 'assistant') continue
        const usage = r.message.usage
        if (!usage || typeof usage !== 'object' || (r.id && seen.has(r.id))) continue
        if (typeof usage.cost?.total === 'number') meta.headCost += usage.cost.total
        if (typeof usage.totalTokens === 'number') meta.headTokens += usage.totalTokens
      }
    } catch {
      /* mid-write — the head's numbers stand */
    }
  }
  meta.totalCost = meta.headCost
  meta.totalTokens = meta.headTokens
  delete meta.headCost
  delete meta.headTokens
  delete meta.costIds
  metaCache.set(entry.file, { mtime: entry.mtime, size: entry.size, meta })
  return meta
}

/**
 * Whether a transcript is being written right now. OpenClaw appends as the session runs, so
 * the mtime narrows it and a growing file settles it: two stats a moment apart, and a size
 * that moved means somebody is still typing. The probe only ever touches files that moved
 * seconds ago — never the thousands of quiet ones, or the scan would spend itself waiting.
 *
 * A file that is *not* growing but was touched moments ago can still be live: the model is
 * thinking — the user's message, a tool result, or a tool call is the last thing on disk and
 * nothing has started streaming yet. The tail says which — a record that leaves work in
 * flight means the session is running for all the colony cares; an assistant reply that said
 * its piece and stopped means it is done. Only files inside the fresh window ever reach this
 * far, so on a typical poll the tail read happens for a handful of files at most.
 *
 * "Unread" is deliberately not answered here. File mtimes cannot say whether a person has
 * looked at a conversation, and guessing — anything that stopped growing moments ago must be
 * awaiting a reply — flipped between polls, which showed as ghost "need you" counts that
 * vanished between one click and the next. The thread is either running or it is not; whether
 * you have read it is the colony's own bookkeeping (`viewedAt`), not the file's.
 *
 * "Thinking" is answered here, though, and it is the one thing the fresh-but-not-growing
 * case can say for sure: a user record as the last thing on disk means input landed moments
 * ago and the model has not written anything back yet — it is processing. The colony draws
 * that as its own status (purple trim, thought bubbles) rather than folding it into
 * "running", because watching a model think and watching a tool execute are different
 * things to keep an eye on.
 */
/**
 * Sticky state: once a session is detected as running or thinking, hold that state for
 * at least this long even if subsequent probes say otherwise. Prevents the stat bar from
 * flickering between polls — "1 building" should stay clickable.
 */
const STICKY_MS = 60_000
const stickyCache = new Map()

async function checkRunning(file, mtime) {
  const now = Date.now()
  const cached = stickyCache.get(file)

  // If the file is genuinely stale (older than FRESH_WINDOW), check sticky cache
  if (now - mtime > FRESH_WINDOW_MS) {
    // Honour sticky state if still within its window
    if (cached && now - cached.at < STICKY_MS) return { running: cached.running, thinking: cached.thinking }
    stickyCache.delete(file)
    return { running: false, thinking: false }
  }
  /** Persist a positive detection so the stat bar stays stable between polls. */
  const stick = (result) => {
    if (result.running || result.thinking) stickyCache.set(file, { ...result, at: now })
    else stickyCache.delete(file)
    return result
  }

  try {
    const size1 = (await fsp.stat(file)).size
    await new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS))
    const size2 = (await fsp.stat(file)).size
    if (size2 > size1) return stick({ running: true, thinking: false })
  } catch {
    return stick({ running: false, thinking: false })
  }
  // Fresh but not growing: work can still be in flight. The last message record in the tail
  // says which — a user record means the model is thinking about fresh input; a `toolResult`
  // means the result just landed and the tool round is still open; an assistant record
  // carrying a tool call means the tool is still executing. Only an assistant record that
  // said its piece and stopped means the turn is over. Non-message records in between
  // (model changes, context, customs) are machinery, not turns, and a tail with no message
  // record at all says nothing either way.
  try {
    const records = jsonLines(await readTail(file, THINKING_TAIL_BYTES))
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r.type !== 'message' || !r.message) continue
      const role = r.message.role
      if (role === 'user') return stick({ running: false, thinking: true })
      if (role === 'toolResult') return stick({ running: true, thinking: false })
      if (role === 'assistant') {
        const content = r.message.content
        const inFlight =
          Array.isArray(content) &&
          content.some((p) => p && (p.type === 'toolCall' || p.type === 'tool_use'))
        return stick({ running: inFlight, thinking: false })
      }
      return stick({ running: false, thinking: false })
    }
  } catch {
    /* unreadable tail — the probe's answer stands: not running */
  }
  // No signal from the tail, but if we had a sticky positive state, honour it
  if (cached && now - cached.at < STICKY_MS) return { running: cached.running, thinking: cached.thinking }
  return { running: false, thinking: false }
}

/**
 * The branch a session's cwd sits on, read off the checkout itself — no process is spawned.
 * A worktree's `.git` is a pointer file to the main checkout's worktree metadata, whose
 * `HEAD` names the branch; a plain checkout keeps `HEAD` under `.git/` directly. When
 * neither is there to read, the machine's own naming convention is the last resort:
 * worktrees live at `repos/<repo>-<branch>/`, so the tail of the path names the branch —
 * split at the first dash, which is all the name alone can say. Results are cached per cwd;
 * a branch is not something a session changes often.
 */
const branchCache = new Map()
async function detectGitBranch(cwd) {
  if (!cwd) return { branch: '', worktree: '' }
  const hit = branchCache.get(cwd)
  if (hit) return hit
  let out = { branch: '', worktree: '' }
  const gitPath = path.join(cwd, '.git')
  const stat = await fsp.stat(gitPath).catch(() => null)
  if (stat?.isFile()) {
    // A worktree: `.git` holds a `gitdir: <path>` pointer, and that dir's HEAD the branch.
    const text = await fsp.readFile(gitPath, 'utf8').catch(() => '')
    const m = /^gitdir: (.+)$/m.exec(text.trim())
    if (m) {
      const branch = await branchFromHead(path.join(m[1], 'HEAD'))
      if (branch) out = { branch, worktree: path.basename(m[1]) }
    }
  } else if (stat?.isDirectory()) {
    const branch = await branchFromHead(path.join(gitPath, 'HEAD'))
    if (branch) out = { branch, worktree: '' }
  }
  if (!out.branch) {
    const m = /[\\/]repos[\\/][^-\\/]+-([^\\/]+)[\\/]?$/.exec(cwd)
    if (m) out = { branch: m[1], worktree: m[1] }
  }
  branchCache.set(cwd, out)
  return out
}

/** `ref: refs/heads/<branch>` out of a HEAD file, or '' when detached or unreadable. */
async function branchFromHead(headFile) {
  const text = await fsp.readFile(headFile, 'utf8').catch(() => '')
  const m = /^ref: refs\/heads\/(.+)$/m.exec(text)
  return m ? m[1].trim() : ''
}

/** Every transcript on disk, tagged with the agent it belongs to. */
async function scanTranscripts() {
  const out = []
  for (const agentDir of await listDirs(AGENTS)) {
    const agentId = path.basename(agentDir)
    const sessions = path.join(agentDir, 'sessions')
    for (const file of await listFiles(sessions, isTranscript)) {
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      if (stat.size < MIN_SIZE) continue
      out.push({ agentId, file, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return out
}

function toThread(agentId, entry, meta, live, git) {
  // The first message names the thread; a sub-agent's scaffolding never does, so the first
  // thing the worker said stands in. Neither present — a delivery stub — is honestly untitled.
  const fromUser = cleanMessage(meta.firstUserText)
  const text = fromUser || cleanMessage(meta.firstAssistantText)
  const prompt = text || 'Untitled session'
  const cls = classifySession(agentId, meta.firstUserText)
  const cwd = meta.cwd
  // `source` says who ran it and what started it — `opus/subagent`, `main/webhook` — and a
  // Slack origin rides on the end: `main/conversation/slack-dm`.
  let source = `${agentId}/${cls.type}`
  const slack = slackTagOf(meta.firstUserText, meta.contextText)
  if (slack) source += `/${slack}`
  // Cost rides on the model name so the card shows it with no UI change: an expensive
  // session reads as `claude-opus-4-6 ($0.42)`.
  const model =
    meta.model && meta.totalCost > 0.01 ? `${meta.model} ($${meta.totalCost.toFixed(2)})` : meta.model
  return {
    id: ID(agentId, meta.sessionId),
    title: clip(prompt, 80),
    preview: clip(text, 240),
    // The detected repo when the head named one, the cwd's own name otherwise — `project` is
    // what claims a hex zone, so a workspace session that spent its whole head on c2 gets
    // c2's plot instead of piling onto the shared workspace.
    project: meta.project || path.basename(cwd) || 'unknown',
    projectPath: meta.projectPath || cwd,
    worktree: git.worktree,
    cwd,
    gitBranch: git.branch,
    model,
    effort: meta.effort,
    createdAt: meta.startedAt || entry.mtime,
    lastActivityAt: entry.mtime,
    // No focus history exists outside the gateway's own UI, and no "unread" state either —
    // see `checkRunning`. Whether you have looked at a thread is the colony's own
    // bookkeeping, never this file's to say.
    lastFocusedAt: 0,
    unread: false,
    running: live.running,
    // The model is processing fresh input — nothing has been written back yet. Drawn by the
    // colony as its own status, distinct from the tool-execution `running` above.
    thinking: Boolean(live.thinking),
    hasError: false,
    starred: false,
    routine: cls.routine,
    // The PR the head named, and what it said happened to it — `MERGED` is the one the
    // colony already knows how to celebrate. `''` is a PR with no state words: open, or
    // simply unsaid.
    prState: '',  // PR detection disabled — too noisy (tags webhooks as "shipped")
    archived: false,
    sizeBytes: entry.size,
    // Which agent ran it — `main`, `opus`, a spawned worker — and what kind of session it
    // was, is the one fact no other harness offers.
    source,
    canOpen: true,
    ref: {
      agentId,
      sessionId: meta.sessionId,
      cwd,
      totalCost: meta.totalCost,
      totalTokens: meta.totalTokens,
      // The PR the session worked on, for the card's `#123` tag. Opaque to everything that
      // consumes `ref` other than as a round-tripped token — `openThread` and
      // `getTranscript` read only `agentId` and `sessionId` from it.
      pr: meta.pr || null,
    },
  }
}

/**
 * Two files can carry one session id — a topic continuation next to its parent transcript.
 * The colony keys on `id`, and two threads sharing one would merge into a single astronaut;
 * the fresher file wins and the quieter one is dropped, since they deep-link to the same place.
 */
function freshest(a, b) {
  if (!a) return b
  if (!b) return a
  const keep = (a.lastActivityAt >= b.lastActivityAt ? a : b)
  const other = keep === a ? b : a
  return {
    ...keep,
    title: keep.title === 'Untitled session' ? other.title : keep.title,
    preview: keep.preview || other.preview,
    createdAt: Math.min(a.createdAt || Infinity, b.createdAt || Infinity) || 0,
    sizeBytes: keep.sizeBytes,
  }
}

async function scanThreads() {
  const entries = await scanTranscripts()
  const now = Date.now()
  // Only transcripts that moved in the last two minutes can be running, and only those pay
  // for the double-stat probe — the other few thousand answer from the mtime alone. The
  // probes run together so their settle pauses overlap instead of stacking.
  const probe = new Map()
  await Promise.all(
    entries
      .filter((e) => now - e.mtime <= ACTIVE_WINDOW_MS)
      .map(async (e) => probe.set(e.file, await checkRunning(e.file, e.mtime)))
  )
  const idle = { running: false, thinking: false }
  const branches = new Map()
  const byId = new Map()
  for (const entry of entries) {
    const meta = await transcriptMeta(entry)
    // No session header means no id, and no id means nothing to deep-link or dedupe on —
    // a file still being written is the normal cause. Skip it; the next poll will see it.
    if (!meta.sessionId) continue
    if (!branches.has(meta.cwd)) branches.set(meta.cwd, await detectGitBranch(meta.cwd))
    const id = ID(entry.agentId, meta.sessionId)
    byId.set(id, freshest(byId.get(id), toThread(entry.agentId, entry, meta, probe.get(entry.file) || idle, branches.get(meta.cwd))))
  }
  return [...byId.values()]
}

/**
 * Hands the thread to OpenClaw's own web UI. The session key is the same one the UI addresses
 * its tabs by — `agent:<agentId>:<sessionId>` — so the link lands on the conversation itself.
 * Both halves of the ref are pattern-checked first: `ref` has made a round trip through the
 * browser by the time it gets here, and a malformed one gets an honest refusal over a URL
 * built out of whatever arrived.
 */
function openThread(ref) {
  const { agentId, sessionId } = ref || {}
  if (!isAgentId(agentId) || !isUuid(sessionId)) {
    return { ok: false, error: 'No openable OpenClaw session on that thread' }
  }
  const key = encodeURIComponent(`agent:${agentId}:${sessionId}`)
  return { ok: true, url: `${webUrl()}/chat?session=${key}` }
}

/**
 * The conversation itself, read back out of a session's transcript for the chat panel on its
 * card. Only what a person reading over the astronaut's shoulder would want: the user's
 * messages and the assistant's replies, with the model that answered and whether tools were
 * used along the way. Tool results are the machinery between the lines rather than the lines,
 * and a reply that was nothing but a tool call has nothing to show — its `⚒` badge lands on
 * the next reply that actually says something.
 *
 * The session's own transcript is preferred when both it and a topic continuation exist;
 * otherwise the first continuation is the conversation, same as the scan's dedupe.
 */
async function getTranscript(ref) {
  const { agentId, sessionId } = ref || {}
  if (!isAgentId(agentId) || !isUuid(sessionId)) return { ok: false, error: 'Invalid ref' }

  const sessionsDir = path.join(AGENTS, agentId, 'sessions')
  const files = await listFiles(sessionsDir, (n) => n.startsWith(sessionId) && isTranscript(n))
  if (!files.length) return { ok: false, error: 'Session not found' }
  const file = files.find((f) => path.basename(f) === `${sessionId}.jsonl`) || files[0]

  let text
  try {
    text = await readHead(file, TRANSCRIPT_MAX_BYTES)
  } catch {
    return { ok: false, error: 'Could not read session file' }
  }

  const messages = []
  let pendingToolUse = false
  for (const r of jsonLines(text)) {
    if (r.type !== 'message') continue
    const msg = r.message
    if (!msg) continue
    const role = msg.role
    if (role !== 'user' && role !== 'assistant') continue

    const content = msg.content
    let body = ''
    if (typeof content === 'string') {
      body = content
    } else if (Array.isArray(content)) {
      body = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
    }

    if (role === 'assistant' && Array.isArray(content)) {
      // The transcript writes tool calls as `toolCall` parts (an Anthropic raw stream would
      // spell it `tool_use`); either shape counts.
      if (content.some((p) => p && (p.type === 'toolCall' || p.type === 'tool_use'))) pendingToolUse = true
      // A reply that was only thinking and tool calls — nothing to show, but the badge
      // carries forward to the reply that speaks.
      if (!body.trim()) continue
    }
    if (!body.trim()) continue

    messages.push({
      role,
      text: body.slice(0, TRANSCRIPT_MSG_MAX),
      model: typeof msg.model === 'string' ? msg.model : '',
      timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
      hasToolUse: role === 'assistant' && pendingToolUse,
    })
    if (role === 'assistant') pendingToolUse = false
  }

  return { ok: true, messages }
}

/**
 * OpenClaw sessions begin where a message arrives — Slack, or the web UI — not from a folder
 * on disk. There is no `openclaw` deep link for "new session in this repo", and pretending
 * otherwise would be a button that launches nothing.
 */
function newSession() {
  return { ok: false, error: 'OpenClaw sessions are started through Slack or the web UI' }
}

export default {
  id: 'openclaw',
  name: 'OpenClaw',
  /** Only claim this machine if the agents directory is actually there. */
  detect: async () => exists(AGENTS),
  scanThreads,
  openThread,
  getTranscript,
  newSession,
  paths: { AGENTS },
}