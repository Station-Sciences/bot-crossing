/**
 * Harness adapter: Antigravity (Google) — IDE agent sessions and transcripts.
 *
 * Reads conversation sessions from:
 *   ~/.gemini/antigravity-ide/brain/<uuid>/.system_generated/logs/transcript.jsonl
 *
 * Read-only, without exception. Nothing here writes to Antigravity's files — see the note on
 * archiving in `server/harnesses/README.md`.
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, jsonLines, listDirs, readHead, readTail } from '../lib/fsutil.mjs'
import { getHeadBranch } from '../lib/github.mjs'

const HOME = os.homedir()
const brainDir = () =>
  process.env.BOT_CROSSING_ANTIGRAVITY_DIR ||
  process.env.ANTIGRAVITY_BRAIN_DIR ||
  path.join(HOME, '.gemini', 'antigravity-ide', 'brain')

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const maxAgeMs = () => {
  const envVal = process.env.BOT_CROSSING_ANTIGRAVITY_MAX_DAYS
  if (envVal !== undefined && envVal !== '') {
    const days = Number(envVal)
    return Number.isNaN(days) || days <= 0 ? Infinity : days * 24 * 60 * 60 * 1000
  }
  return 7 * 24 * 60 * 60 * 1000
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isSessionId = (v) => typeof v === 'string' && UUID.test(v)

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `antigravity:${raw}`

function cleanPrompt(raw) {
  if (typeof raw !== 'string') return ''
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw)
  const base = reqMatch ? reqMatch[1] : raw
  return base
    .replace(/<([a-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeToolCall(call) {
  if (!call) return ''
  const name = call.name || 'tool'
  const args = call.args || {}
  const target =
    args.CommandLine ||
    args.TargetFile ||
    args.AbsolutePath ||
    args.DirectoryPath ||
    args.Query ||
    args.Url ||
    ''
  if (target) {
    const cleanTarget = String(target).split('\n')[0].trim()
    const short = cleanTarget.length > 35 ? cleanTarget.slice(0, 32) + '…' : cleanTarget
    return `${name}: ${short}`
  }
  return name
}

function findGitRoot(startDir) {
  let cur = path.resolve(startDir)
  while (cur && cur !== path.dirname(cur)) {
    try {
      if (existsSync(path.join(cur, '.git'))) return cur
    } catch {
      break
    }
    cur = path.dirname(cur)
  }
  return startDir
}

function resolveProject(filePathOrDir) {
  if (!filePathOrDir || typeof filePathOrDir !== 'string') {
    return { projectPath: '', project: 'unknown' }
  }
  const clean = filePathOrDir.replace(/^"|"$/g, '').trim()
  const resolved = path.resolve(clean)
  const gitRoot = findGitRoot(resolved)
  const projectPath = gitRoot || resolved
  const project = path.basename(projectPath) || 'unknown'
  return { projectPath, project }
}

function extractWorkspace(records) {
  const scores = new Map()

  const addVote = (rawPath, weight) => {
    if (!rawPath || typeof rawPath !== 'string') return
    const clean = rawPath.replace(/^"|"$/g, '').trim()
    if (!clean.startsWith('/') && !clean.includes(':\\')) return
    if (
      clean.includes('/.gemini/antigravity-ide/brain') ||
      clean.includes('/.antigravity/brain')
    ) {
      return
    }

    const dir = clean.includes('.') ? path.dirname(clean) : clean
    const { projectPath, project } = resolveProject(dir)
    if (!projectPath || project === 'unknown') return
    const cur = scores.get(projectPath) || { score: 0, project }
    cur.score += weight
    scores.set(projectPath, cur)
  }

  for (const r of records) {
    // 1. Tool calls: direct actions in the file system are the highest-confidence indicator
    if (Array.isArray(r.tool_calls)) {
      for (const call of r.tool_calls) {
        const p =
          call.args?.Cwd ||
          call.args?.TargetFile ||
          call.args?.SearchPath ||
          call.args?.DirectoryPath ||
          call.args?.AbsolutePath
        if (p) addVote(p, 5)
      }
    }

    if (typeof r.content === 'string') {
      // 2. Mentioned files in prompt metadata (@[item] is a [File]: /path)
      const mentionRegex = /is a \[File\]:\s*\n([^\s\n]+)/g
      let m
      while ((m = mentionRegex.exec(r.content)) !== null) {
        addVote(m[1].trim(), 4)
      }

      // 3. (in /path)
      const inDir = /\(in\s+([^\s,)\n]+)/.exec(r.content)
      if (inDir) addVote(inDir[1].trim(), 3)

      // 4. URI workspace mapping: [URI] -> [CorpusName]: \n /path
      const uriMap = /\[URI\] -> \[CorpusName\]:\s*\n([^\s\n\->]+)/.exec(r.content)
      if (uriMap) addVote(uriMap[1].trim(), 2)

      // 5. Active Document (lowest weight — often just an open tab unrelated to prompt)
      const activeDoc = /Active Document:\s*([^\s(\n]+)/.exec(r.content)
      if (activeDoc) addVote(activeDoc[1].trim(), 1)
    }
  }

  if (!scores.size) return { projectPath: '', project: 'unknown' }

  let best = { projectPath: '', project: 'unknown', score: -1 }
  for (const [projectPath, entry] of scores.entries()) {
    if (entry.score > best.score) {
      best = { projectPath, project: entry.project, score: entry.score }
    }
  }
  return { projectPath: best.projectPath, project: best.project }
}

function extractModel(headRecords) {
  for (const r of headRecords) {
    if (typeof r.content === 'string') {
      const m = /setting `Model Selection` from \w+ to ([^\n.]+)/.exec(r.content)
      if (m) return m[1].trim()
    }
  }
  return 'Gemini'
}

async function scanThread(dir) {
  const dirName = path.basename(dir)
  if (!isSessionId(dirName)) return null

  const transcriptPath = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl')
  let stat
  try {
    stat = await fsp.stat(transcriptPath)
  } catch {
    return null
  }

  const maxAge = maxAgeMs()
  if (maxAge !== Infinity && Date.now() - stat.mtimeMs > maxAge) {
    return null
  }

  const [headText, tailText] = await Promise.all([
    readHead(transcriptPath, HEAD_BYTES),
    readTail(transcriptPath, TAIL_BYTES),
  ])

  const headRecords = jsonLines(headText)
  const tailRecords = jsonLines(tailText)
  if (!headRecords.length) return null

  let firstPrompt = ''
  let startedAt = 0

  for (const r of headRecords) {
    if (!startedAt && r.created_at) {
      const t = Date.parse(r.created_at)
      if (!Number.isNaN(t)) startedAt = t
    }
    if (!firstPrompt && (r.type === 'USER_INPUT' || r.type === 'USER_EXPLICIT') && r.content) {
      firstPrompt = cleanPrompt(r.content)
    }
  }

  const allRecords = [...headRecords, ...tailRecords]
  const { project, projectPath } = extractWorkspace(allRecords)
  const model = extractModel(headRecords)

  const lastRecord = tailRecords[tailRecords.length - 1] || headRecords[headRecords.length - 1]
  let lastActivityAt = stat.mtimeMs
  if (lastRecord?.created_at) {
    const t = Date.parse(lastRecord.created_at)
    if (!Number.isNaN(t)) lastActivityAt = t
  }

  const now = Date.now()
  const isRecent = now - lastActivityAt < ACTIVE_WINDOW_MS
  const hasError =
    lastRecord?.status === 'ERROR' ||
    lastRecord?.type === 'ERROR' ||
    (lastRecord?.exit_code !== undefined && lastRecord.exit_code !== 0)

  // Check if agent is currently waiting on user input / action choice:
  // 1. Interactive popup: ask_question tool call without subsequent answer
  let pendingQuestion = false
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const r = tailRecords[i]
    if (r.type === 'USER_INPUT' || r.type === 'USER_EXPLICIT') break
    if (r.type === 'ASK_QUESTION') {
      pendingQuestion = false
      break
    }
    if (Array.isArray(r.tool_calls) && r.tool_calls.some((c) => c?.name === 'ask_question')) {
      pendingQuestion = true
      break
    }
  }

  // 2. Action choice popup: artifact plan review requesting user feedback (Proceed button)
  let pendingFeedback = false
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const r = tailRecords[i]
    if (r.type === 'USER_INPUT' || r.type === 'USER_EXPLICIT') break
    if (Array.isArray(r.tool_calls)) {
      const feedbackCall = r.tool_calls.find((c) => {
        let meta = c?.args?.ArtifactMetadata
        if (typeof meta === 'string') {
          try {
            meta = JSON.parse(meta)
          } catch {}
        }
        return meta?.RequestFeedback === true
      })
      if (feedbackCall) {
        pendingFeedback = true
        break
      }
      if (r.tool_calls.length > 0) break
    }
  }

  const hasPendingToolCalls = Array.isArray(lastRecord?.tool_calls) && lastRecord.tool_calls.length > 0
  const isSuspendedResponse =
    lastRecord?.type === 'PLANNER_RESPONSE' &&
    lastRecord?.status !== 'RUNNING' &&
    !lastRecord?.content &&
    (!Array.isArray(lastRecord?.tool_calls) || lastRecord.tool_calls.length === 0)

  const TOOL_CONFIRM_GRACE_MS = 8000
  // 3. Permission / confirmation modal: tool call waiting for user approval (or suspended turn)
  const pendingPermission =
    isRecent &&
    !hasError &&
    (isSuspendedResponse || (hasPendingToolCalls && now - lastActivityAt >= TOOL_CONFIRM_GRACE_MS))

  const isTurnClosed =
    lastRecord?.type === 'PLANNER_RESPONSE' &&
    lastRecord?.status !== 'RUNNING' &&
    Boolean(lastRecord?.content) &&
    !hasPendingToolCalls

  const isTurnOpen = !isTurnClosed
  const isWaiting = !hasError && (pendingQuestion || pendingFeedback || pendingPermission)
  const running = isRecent && !hasError && !isWaiting && isTurnOpen
  const unread = isWaiting

  const title = firstPrompt
    ? firstPrompt.length > 50
      ? firstPrompt.slice(0, 47) + '...'
      : firstPrompt
    : 'Antigravity Session'

  let activeTool = ''
  const recentLogs = []
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const r = tailRecords[i]
    if (r.type === 'USER_INPUT' || r.type === 'USER_EXPLICIT') {
      const p = cleanPrompt(r.content || '')
      if (p && recentLogs.length < 5) {
        recentLogs.unshift({ type: 'user', text: p.length > 80 ? p.slice(0, 77) + '…' : p, time: r.created_at })
      }
    } else if (Array.isArray(r.tool_calls) && r.tool_calls.length > 0) {
      for (let j = r.tool_calls.length - 1; j >= 0; j--) {
        const tc = r.tool_calls[j]
        const toolStr = summarizeToolCall(tc)
        if (!activeTool) activeTool = toolStr
        if (recentLogs.length < 5) {
          recentLogs.unshift({ type: 'tool', text: toolStr, time: r.created_at })
        }
      }
    } else if (r.type === 'PLANNER_RESPONSE' && r.content) {
      const cleanC = r.content.replace(/\s+/g, ' ').trim()
      if (cleanC && recentLogs.length < 5) {
        recentLogs.unshift({ type: 'assistant', text: cleanC.length > 80 ? cleanC.slice(0, 77) + '…' : cleanC, time: r.created_at })
      }
    }
  }

  let lastAction = ''
  if (isWaiting) {
    if (pendingQuestion) lastAction = 'Waiting for user answer'
    else if (pendingFeedback) lastAction = 'Waiting for plan review'
    else if (pendingPermission) lastAction = 'Waiting for tool approval'
    else lastAction = 'Waiting for user reply'
  } else if (running) {
    lastAction = activeTool || 'Working on task…'
  } else if (hasError) {
    lastAction = 'Error encountered'
  } else {
    lastAction = 'Idle'
  }

  let gitBranch = projectPath ? getHeadBranch(projectPath) : ''
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const r = tailRecords[i]
    if (Array.isArray(r.tool_calls)) {
      for (const c of r.tool_calls) {
        const cmd = c?.args?.CommandLine
        if (typeof cmd === 'string') {
          const m = /git\s+(?:checkout\s+(?:-b\s+)?|switch\s+(?:-c\s+)?|push\s+[\w-]+\s+)([^\s;&|]+)/.exec(cmd)
          if (m && m[1] && !m[1].startsWith('-')) {
            gitBranch = m[1].trim()
            break
          }
        }
      }
    }
    if (gitBranch && gitBranch !== 'master' && gitBranch !== 'main') break
  }

  return {
    id: ID(dirName),
    title,
    preview: firstPrompt,
    project,
    projectPath,
    worktree: '',
    cwd: projectPath,
    gitBranch,
    model,
    createdAt: startedAt || stat.birthtimeMs || stat.mtimeMs,
    lastActivityAt,
    lastFocusedAt: 0,
    running,
    unread,
    hasError,
    lastAction,
    recentLogs,
    starred: false,
    routine: '',
    prState: '',
    archived: false,
    sizeBytes: stat.size,
    source: 'ide',
    canOpen: Boolean(projectPath),
    ref: { sessionId: dirName, cwd: projectPath },
  }
}

export async function detect() {
  return exists(brainDir())
}

export async function scanThreads() {
  const root = brainDir()
  const dirs = await listDirs(root)
  const threads = await Promise.all(dirs.map(scanThread))
  return threads.filter(Boolean)
}

export async function openThread(ref) {
  let dir = typeof ref === 'string' && !isSessionId(ref) ? ref : ref?.cwd
  const sessionId = typeof ref === 'string' && isSessionId(ref) ? ref : ref?.sessionId
  if (!dir && sessionId) {
    const thread = await scanThread(sessionId)
    dir = thread?.cwd
  }
  if (!dir || typeof dir !== 'string') {
    return {
      ok: false,
      error: 'That thread has no project folder recorded',
    }
  }
  return newSession(dir)
}

export async function ideBinary() {
  const candidates = [
    process.env.ANTIGRAVITY_IDE_BIN,
    '/opt/antigravity-ide/Antigravity-IDE/bin/antigravity-ide',
    path.join(HOME, '.local', 'bin', 'antigravity-ide'),
    '/usr/local/bin/antigravity-ide',
    '/usr/bin/antigravity-ide',
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      await fsp.access(c, fsp.constants.X_OK)
      if ((await fsp.stat(c)).isFile()) return c
    } catch {}
  }
  return findExecutable('antigravity-ide')
}

export async function newSession(dir) {
  let abs = String(dir || '').replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(abs)) abs = '/' + abs
  if (!abs.startsWith('/')) {
    return { ok: false, error: 'That folder is not somewhere Antigravity can open' }
  }
  const url = `antigravity-ide://file${abs.split('/').map(encodeURIComponent).join('/')}`
  let command
  if (process.platform === 'linux') {
    const bin = await ideBinary()
    if (bin) {
      command = { argv: [bin, abs], cwd: abs, terminal: false }
    }
  }
  return { ok: true, url, command }
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  scanThreads,
  openThread,
  newSession,
}
