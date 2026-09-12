import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CACHE_MS = 5 * 60 * 1000
const CONCURRENCY = 6
const cache = new Map()

const pathApiFor = (value) => (/^[A-Za-z]:[\\/]/.test(String(value || '')) ? path.win32 : path.posix)
const trimGitSuffix = (value) => value.replace(/\/+$/, '').replace(/\.git$/i, '')

/** One spelling for SSH, HTTPS and git-protocol URLs that name the same remote. */
export function normalizeRemote(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(raw)
  if (scp && !raw.includes('://') && !/^[A-Za-z]:[\\/]/.test(raw)) {
    const host = scp[1].toLowerCase()
    const repoPath = trimGitSuffix(scp[2].replace(/^\/+/, ''))
    return host === 'github.com' ? `${host}/${repoPath.toLowerCase()}` : `${host}/${repoPath}`
  }

  try {
    const url = new URL(raw)
    if (url.protocol === 'file:') return `file:${trimGitSuffix(decodeURIComponent(url.pathname))}`
    const host = url.hostname.toLowerCase()
    const repoPath = trimGitSuffix(decodeURIComponent(url.pathname).replace(/^\/+/, ''))
    if (!host || !repoPath) return ''
    return host === 'github.com' ? `${host}/${repoPath.toLowerCase()}` : `${host}/${repoPath}`
  } catch {
    return ''
  }
}

export function workspaceRoot(workspacePath, home = os.homedir()) {
  if (!workspacePath) return { key: 'other', name: 'Other', path: '' }
  const api = pathApiFor(home)
  const winStyle = api === path.win32
  const workspace = api.resolve(String(workspacePath))
  const homePath = api.resolve(home)
  const relative = api.relative(homePath, workspace)
  if (!relative || relative === '.') {
    return { key: `path:${homePath}`, name: api.basename(homePath) || homePath, path: homePath }
  }
  if (relative.startsWith(`..${api.sep}`) || relative === '..' || api.isAbsolute(relative)) {
    return { key: 'other', name: 'Other', path: '' }
  }
  const first = relative.split(api.sep)[0]
  const rootPath = api.join(homePath, first)
  return { key: `path:${winStyle ? rootPath.toLowerCase() : rootPath}`, name: first, path: rootPath }
}

function labelsForRemote(remote) {
  const segments = remote.split('/').filter(Boolean)
  const name = segments.at(-1) || remote
  return { name, qualified: segments.slice(-2).join('/') || name }
}

function parseRemotes(stdout) {
  const remotes = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^remote\.([^.]+)\.url\s+(.+)$/.exec(line.trim())
    if (match) remotes.push({ name: match[1], url: match[2] })
  }
  return remotes
}

async function gitIdentity(folder) {
  const resolved = path.resolve(folder)
  const cached = cache.get(resolved)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  let real = resolved
  try {
    const stat = await fsp.stat(resolved)
    if (!stat.isDirectory()) throw new Error('not a directory')
    real = await fsp.realpath(resolved)
  } catch {
    const value = { key: `path:${resolved}`, name: path.basename(resolved) || resolved, qualified: resolved, repoPath: '' }
    cache.set(resolved, { at: Date.now(), value })
    return value
  }

  try {
    const [{ stdout: top }, { stdout: config }] = await Promise.all([
      execFileAsync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { timeout: 3000 }),
      execFileAsync('git', ['-C', real, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeout: 3000 }),
    ])
    const remotes = parseRemotes(config)
    const preferred =
      remotes.find((remote) => remote.name === 'origin') ||
      remotes.find((remote) => remote.name === 'upstream') ||
      remotes[0]
    const remote = normalizeRemote(preferred?.url)
    if (remote) {
      const value = {
        key: `remote:${remote}`,
        ...labelsForRemote(remote),
        repoPath: String(top).trim() || real,
        remote,
      }
      cache.set(resolved, { at: Date.now(), value })
      return value
    }
  } catch {
    /* A directory that is not a Git checkout is a normal workspace. */
  }

  const value = { key: `path:${real}`, name: path.basename(real) || real, qualified: real, repoPath: real }
  cache.set(resolved, { at: Date.now(), value })
  return value
}

async function mapLimit(items, fn) {
  const out = new Map()
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      out.set(item, await fn(item))
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Harnesses report where a thread ran. This pass decides which workspace and repository
 * plot it belongs to, without changing the paths handed back to the harness on Open.
 */
export async function addRepositoryIdentity(threads, home = os.homedir()) {
  const paths = [...new Set(threads.map((thread) => thread.projectPath || thread.cwd || '').filter(Boolean))]
  const identities = await mapLimit(paths, gitIdentity)
  const enriched = threads.map((thread) => {
    const workspace = workspaceRoot(thread.cwd || thread.projectPath, home)
    const sourcePath = thread.projectPath || thread.cwd || ''
    let repo = identities.get(sourcePath) || {
      key: `unknown:${thread.id || thread.project || 'thread'}`,
      name: thread.project || 'unknown',
      qualified: thread.project || 'unknown',
      repoPath: '',
    }
    const api = pathApiFor(home)
    if (repo.key.startsWith('path:') && workspace.path && api.resolve(sourcePath) === api.resolve(workspace.path)) {
      repo = { key: `workspace:${workspace.key}`, name: 'Workspace', qualified: 'Workspace', repoPath: workspace.path }
    }
    return {
      ...thread,
      legacyProject: thread.project || '',
      workspaceRootKey: workspace.key,
      workspaceRootName: workspace.name,
      workspaceRootPath: workspace.path,
      repoKey: repo.key,
      repoPath: repo.repoPath || '',
      project: repo.name,
      projectQualified: repo.qualified,
      plotKey: `${workspace.key}::${repo.key}`,
    }
  })

  const keysByLabel = new Map()
  for (const thread of enriched) {
    const labelKey = `${thread.workspaceRootKey}\0${thread.project}`
    if (!keysByLabel.has(labelKey)) keysByLabel.set(labelKey, new Set())
    keysByLabel.get(labelKey).add(thread.repoKey)
  }
  return enriched.map((thread) => {
    const collision = keysByLabel.get(`${thread.workspaceRootKey}\0${thread.project}`)?.size > 1
    return collision ? { ...thread, project: thread.projectQualified } : thread
  })
}

export function clearRepositoryIdentityCache() {
  cache.clear()
}
