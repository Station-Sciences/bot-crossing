/**
 * Shared task scanner and transcript parser for VS Code extension-based coding agents
 * such as Cline (saoudrizwan.claude-dev) and Roo Code (rooveterinaryinc.roo-cline).
 *
 * Both store task sessions in VS Code's globalStorage directory under their respective extension ID:
 *   <globalStorage>/<extDirName>/tasks/<taskId>/
 * Inside each task directory:
 *   - ui_messages.json
 *   - api_conversation_history.json
 *   - task_metadata.json (optional)
 *
 * Read-only, no subprocess during scanning, and safe against malformed/active files.
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, listDirs } from './fsutil.mjs'
import { getHeadBranch } from './github.mjs'

const HOME = os.homedir()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

export function getStorageRoots(envVar, extDirName) {
  const custom = process.env[envVar]
  if (custom) return [path.resolve(custom)]

  const roots = []
  if (process.platform === 'darwin') {
    roots.push(
      path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(HOME, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(HOME, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', extDirName, 'tasks')
    )
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
    roots.push(
      path.join(appData, 'Code', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(appData, 'VSCodium', 'User', 'globalStorage', extDirName, 'tasks')
    )
  } else {
    // Linux and other UNIX
    const config = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
    roots.push(
      path.join(config, 'Code', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(config, 'Code - OSS', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(config, 'Code - Insiders', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(config, 'VSCodium', 'User', 'globalStorage', extDirName, 'tasks'),
      path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage', extDirName, 'tasks')
    )
  }
  return roots
}

export function findGitRoot(startDir) {
  if (!startDir || typeof startDir !== 'string') return ''
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

export function cleanPrompt(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, ' ')
    .replace(/<[a-z_][\w-]*>[\s\S]*?<\/[a-z_][\w-]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract the working directory from environment details or path mentions.
 */
export function extractCwd(text) {
  if (typeof text !== 'string' || !text) return ''

  // 1. Explicit current working directory header
  const envBlock = /<environment_details>([\s\S]*?)<\/environment_details>/i.exec(text)
  const searchIn = envBlock ? envBlock[1] : text

  const cwdMatch =
    /#+\s*Current Working Directory\s*(?:\(([^)\n\r]+)\)|:?\s*([^\n\r]+))/i.exec(searchIn) ||
    /(?:current working directory|working directory|cwd):\s*([^\n\r<]+)/i.exec(searchIn)

  const candidate = cwdMatch ? (cwdMatch[1] || cwdMatch[2] || '').trim() : ''
  if (candidate && (path.isAbsolute(candidate) || /^[a-zA-Z]:[/\\]/.test(candidate))) {
    return candidate
  }

  return ''
}

export async function parseJsonFile(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Cache parsing results against mtime and size so repeated polls don't re-read gigabytes. */
const cache = new Map()

export async function parseTaskFacts(taskDir, taskId) {
  const uiFile = path.join(taskDir, 'ui_messages.json')
  const metaFile = path.join(taskDir, 'task_metadata.json')
  const apiFile = path.join(taskDir, 'api_conversation_history.json')

  let stat
  try {
    stat = await fsp.stat(uiFile)
  } catch {
    try {
      stat = await fsp.stat(apiFile)
    } catch {
      return null
    }
  }

  const hit = cache.get(taskId)
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
    return hit.value
  }

  const [uiMessages, metadata, apiHistory] = await Promise.all([
    parseJsonFile(uiFile),
    parseJsonFile(metaFile),
    parseJsonFile(apiFile),
  ])

  let totalBytes = stat.size
  try {
    if (uiFile && stat) {
      const apiStat = await fsp.stat(apiFile).catch(() => null)
      if (apiStat) totalBytes += apiStat.size
    }
  } catch {}

  let prompt = ''
  let cwd = metadata?.cwd || metadata?.workspace || metadata?.projectPath || ''
  let model = metadata?.model || ''
  let startedAt = 0
  let errored = false
  let unread = false
  let completed = false

  // Analyze ui_messages if available
  if (Array.isArray(uiMessages) && uiMessages.length > 0) {
    // Find initial task prompt
    const initialTask = uiMessages.find((m) => m?.say === 'task' || m?.type === 'task')
    if (initialTask?.text) {
      prompt = cleanPrompt(initialTask.text)
    } else {
      const firstWithText = uiMessages.find((m) => m?.text && typeof m.text === 'string')
      if (firstWithText) prompt = cleanPrompt(firstWithText.text)
    }

    if (uiMessages[0]?.ts) {
      startedAt = Number(uiMessages[0].ts)
    }

    // Inspect last messages for status
    const last = uiMessages[uiMessages.length - 1]
    if (last) {
      if (last.type === 'ask') {
        // An ask waiting on user confirmation/reply (tool approval, question, etc.)
        unread = true
      }
      if (last.say === 'error' || last.ask === 'api_req_failed') {
        errored = true
      }
      if (last.say === 'completion_result' || last.ask === 'completion_result') {
        completed = true
      }
    }

    // Try finding cwd from messages if metadata didn't have it
    if (!cwd) {
      for (const m of uiMessages) {
        if (typeof m?.text === 'string') {
          const found = extractCwd(m.text)
          if (found) {
            cwd = found
            break
          }
        }
      }
    }
  }

  // Fallback to api_conversation_history if prompt or cwd still missing
  if (Array.isArray(apiHistory) && apiHistory.length > 0) {
    if (!prompt) {
      const firstUser = apiHistory.find((m) => m?.role === 'user')
      if (firstUser) {
        const text = Array.isArray(firstUser.content)
          ? firstUser.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
          : String(firstUser.content || '')
        prompt = cleanPrompt(text)
      }
    }
    if (!cwd) {
      for (const m of apiHistory) {
        const text = Array.isArray(m?.content)
          ? m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
          : String(m?.content || '')
        const found = extractCwd(text)
        if (found) {
          cwd = found
          break
        }
      }
    }
  }

  const projectPath = cwd ? findGitRoot(cwd) || cwd : ''
  const project = projectPath ? path.basename(projectPath) || 'unknown' : 'unknown'

  const value = {
    prompt,
    project,
    projectPath,
    cwd: projectPath || cwd,
    model,
    startedAt,
    mtime: stat.mtimeMs,
    born: stat.birthtimeMs,
    sizeBytes: totalBytes,
    unread,
    errored,
    completed,
  }

  cache.set(taskId, { mtime: stat.mtimeMs, size: stat.size, value })
  return value
}

export async function resolveCodeBinary() {
  const candidates = ['code', 'code-insiders', 'codium', 'code-oss']
  for (const name of candidates) {
    const bin = await findExecutable(name)
    if (bin) return bin
  }
  return null
}

export function createVSCodeAdapter({ id, name, envVar, extDirName }) {
  const detect = async () => {
    const roots = getStorageRoots(envVar, extDirName)
    for (const r of roots) {
      if (await exists(r)) return true
    }
    return false
  }

  const scanThreads = async () => {
    const roots = getStorageRoots(envVar, extDirName)
    const existingRoots = []
    for (const r of roots) {
      if (await exists(r)) existingRoots.push(r)
    }
    if (!existingRoots.length) return []

    const threads = []
    const now = Date.now()

    for (const root of existingRoots) {
      const taskDirs = await listDirs(root)
      for (const taskDir of taskDirs) {
        const taskId = path.basename(taskDir)
        try {
          const f = await parseTaskFacts(taskDir, taskId)
          if (!f) continue

          let gitBranch = ''
          if (f.projectPath) {
            try {
              gitBranch = await getHeadBranch(f.projectPath)
            } catch {}
          }

          const running = !f.completed && !f.unread && now - f.mtime < ACTIVE_WINDOW_MS

          threads.push({
            id: `${id}:${taskId}`,
            title: (f.prompt || 'Untitled task').slice(0, 120),
            preview: (f.prompt || '').slice(0, 240),
            project: f.project,
            projectPath: f.projectPath,
            worktree: '',
            cwd: f.cwd,
            gitBranch,
            model: f.model,
            effort: '',
            createdAt: f.startedAt || f.born || f.mtime,
            lastActivityAt: f.mtime,
            lastFocusedAt: 0,
            running,
            unread: f.unread,
            hasError: f.errored,
            starred: false,
            routine: '',
            prState: '',
            archived: false,
            sizeBytes: f.sizeBytes,
            source: 'extension',
            canOpen: Boolean(f.projectPath),
            ref: { taskId, cwd: f.projectPath },
          })
        } catch {
          /* malformed task folder — skip */
        }
      }
    }

    return threads
  }

  const openThread = async (ref) => {
    const dir = typeof ref === 'string' ? ref : ref?.cwd
    if (!dir || typeof dir !== 'string') {
      return { ok: false, error: `${name} task has no project folder recorded` }
    }
    return newSession(dir)
  }

  const newSession = async (dir) => {
    let abs = String(dir || '').replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(abs)) abs = '/' + abs
    if (!abs.startsWith('/')) {
      return { ok: false, error: 'That folder is not somewhere VS Code can open' }
    }
    const url = `vscode://file${abs.split('/').map(encodeURIComponent).join('/')}`
    let command
    if (process.platform === 'linux') {
      const bin = await resolveCodeBinary()
      if (bin) {
        command = { argv: [bin, abs], cwd: abs, terminal: false }
      }
    }
    return { ok: true, url, command }
  }

  return {
    id,
    name,
    detect,
    scanThreads,
    openThread,
    newSession,
  }
}
