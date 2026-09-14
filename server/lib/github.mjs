import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const GITHUB_PR_CACHE_TTL_MS = 60 * 1000 // 60s cache
const prCache = new Map() // key: `${owner}/${repo}` -> { time, prs }

let cachedToken = undefined

/**
 * Retrieve GitHub token from env or git credential helper without requiring manual config.
 */
export async function getGitHubToken() {
  if (cachedToken !== undefined) return cachedToken
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN)
  if (process.env.GH_TOKEN) return (cachedToken = process.env.GH_TOKEN)

  try {
    const token = await new Promise((resolve) => {
      const proc = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout.on('data', (d) => {
        out += d.toString()
      })
      proc.on('close', (code) => {
        if (code !== 0) return resolve('')
        const match = /^password=(.*)$/m.exec(out)
        resolve(match && match[1] ? match[1].trim() : '')
      })
      proc.on('error', () => resolve(''))
      proc.stdin.write('protocol=https\nhost=github.com\n\n')
      proc.stdin.end()
    })
    return (cachedToken = token)
  } catch {
    return (cachedToken = '')
  }
}

/**
 * Extract GitHub owner and repo from a git remote URL.
 * Handles HTTPS, SSH, and git:// URLs.
 */
export function parseGitHubUrl(url) {
  if (!url || typeof url !== 'string') return null
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url.trim())
  if (!m) return null
  return {
    owner: m[1],
    repo: m[2],
    fullName: `${m[1]}/${m[2]}`,
  }
}

/**
 * Read .git/config to determine origin and upstream GitHub repositories.
 */
export function parseGitRepo(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return null
  const configPath = path.join(projectPath, '.git', 'config')
  if (!fs.existsSync(configPath)) return null

  try {
    const text = fs.readFileSync(configPath, 'utf8')
    let currentRemote = null
    let origin = null
    let upstream = null

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      const section = /^\[remote\s+"([^"]+)"\]/.exec(trimmed)
      if (section) {
        currentRemote = section[1]
        continue
      }
      if (currentRemote && trimmed.startsWith('url =')) {
        const url = trimmed.slice(5).trim()
        const parsed = parseGitHubUrl(url)
        if (parsed) {
          if (currentRemote === 'origin') origin = parsed
          else if (currentRemote === 'upstream') upstream = parsed
        }
      }
    }
    if (!origin && !upstream) return null
    return { origin, upstream }
  } catch {
    return null
  }
}

/**
 * Read current branch name from .git/HEAD.
 */
export function getHeadBranch(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return ''
  const headPath = path.join(projectPath, '.git', 'HEAD')
  try {
    if (!fs.existsSync(headPath)) return ''
    const content = fs.readFileSync(headPath, 'utf8').trim()
    if (content.startsWith('ref: refs/heads/')) {
      return content.replace('ref: refs/heads/', '').trim()
    }
    return content.slice(0, 8)
  } catch {
    return ''
  }
}

/**
 * Fetch PRs for a GitHub repository using native fetch with TTL caching.
 */
export async function fetchRepoPRs(owner, repo, token = '') {
  const key = `${owner}/${repo}`
  const now = Date.now()
  const cached = prCache.get(key)
  if (cached && now - cached.time < GITHUB_PR_CACHE_TTL_MS) {
    return cached.prs
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=30`
  const headers = {
    'User-Agent': 'bot-crossing',
    'Accept': 'application/vnd.github+json',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
    if (!res.ok) {
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        // Cache empty on auth/rate failure to avoid retrying every second
        prCache.set(key, { time: now, prs: cached?.prs || [] })
      }
      return cached?.prs || []
    }
    const data = await res.json()
    if (!Array.isArray(data)) return []

    const prs = data.map((pr) => ({
      number: pr.number,
      title: pr.title || '',
      state: pr.state || 'open',
      merged: Boolean(pr.merged_at),
      mergedAt: pr.merged_at ? Date.parse(pr.merged_at) : null,
      createdAt: pr.created_at ? Date.parse(pr.created_at) : 0,
      headRef: pr.head?.ref || '',
      headSha: pr.head?.sha || '',
      baseRef: pr.base?.ref || '',
      url: pr.html_url || '',
      user: pr.user?.login || '',
    }))

    prCache.set(key, { time: now, prs })
    return prs
  } catch {
    return cached?.prs || []
  }
}

/**
 * Match a thread with its corresponding Pull Request.
 */
const GENERIC_BRANCHES = new Set(['master', 'main', 'staging', 'demo', 'develop', 'dev', 'trunk', ''])

/**
 * Match a thread with its corresponding Pull Request.
 */
export function matchThreadPR(thread, prs, claimedNumbers = null) {
  if (!Array.isArray(prs) || !prs.length) return null

  const branch = thread.gitBranch || ''
  const isGeneric = GENERIC_BRANCHES.has(branch)
  const threadStart = thread.createdAt || thread.lastActivityAt || 0
  const threadEnd = thread.lastActivityAt || thread.createdAt || 0

  // If thread has no timestamp info, cannot safely match
  if (!threadStart && !threadEnd) return null

  const CAUSALITY_TOLERANCE_MS = 2 * 60 * 1000 // 2 minutes

  // 1. Direct match by feature branch name (e.g. feat/antigravity-harness)
  if (!isGeneric) {
    for (const pr of prs) {
      if (claimedNumbers && claimedNumbers.has(pr.number)) continue
      if (pr.headRef !== branch) continue
      // A thread cannot have shipped a PR that was already merged before the thread even started
      if (pr.merged && pr.mergedAt && pr.mergedAt < threadStart - CAUSALITY_TOLERANCE_MS) {
        continue
      }
      return pr
    }
    return null
  }

  // 2. Generic branch matching (e.g. master/main)
  const threadContent = (
    (thread.title || '') +
    ' ' +
    (thread.preview || '') +
    ' ' +
    (thread.recentLogs || []).map((l) => l.text || '').join(' ')
  ).toLowerCase()

  let bestMatch = null
  let bestScore = -1

  for (const pr of prs) {
    if (claimedNumbers && claimedNumbers.has(pr.number)) continue
    if (branch && pr.headRef !== branch) continue

    // Temporal Causality Check:
    // A thread cannot have shipped a PR that was merged before this thread began!
    if (pr.merged && pr.mergedAt) {
      if (pr.mergedAt < threadStart - CAUSALITY_TOLERANCE_MS) {
        continue
      }
      if (pr.mergedAt > threadEnd + 48 * 60 * 60 * 1000) {
        continue
      }
    }

    // Thread shouldn't have finished long before PR was created
    if (pr.createdAt && threadEnd < pr.createdAt - 2 * 60 * 60 * 1000) {
      continue
    }

    let score = 0
    const prTime = pr.mergedAt || pr.createdAt || 0
    const diffMs = Math.abs(threadEnd - prTime)

    // Closeness in time: thread concluded around when PR was created or merged
    if (diffMs < 10 * 60 * 1000) score += 40 // within 10m
    else if (diffMs < 30 * 60 * 1000) score += 30 // within 30m
    else if (diffMs < 2 * 60 * 60 * 1000) score += 20 // within 2h
    else if (diffMs < 12 * 60 * 60 * 1000) score += 10 // within 12h
    else score += 2

    // Keyword matching
    const prWords = pr.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
    let kwMatches = 0
    for (const w of prWords) {
      if (threadContent.includes(w)) {
        kwMatches++
        score += 15
      }
    }

    // On generic branches: require strong correlation (keyword match OR very tight time window <= 15m)
    const isStrongMatch = kwMatches >= 1 || diffMs <= 15 * 60 * 1000
    if (isStrongMatch && score > bestScore && score >= 25) {
      bestScore = score
      bestMatch = pr
    }
  }

  return bestMatch
}

/**
 * Enrich a list of threads with GitHub PR state.
 */
export async function enrichThreadsWithGitHubPRs(threads) {
  if (!Array.isArray(threads) || !threads.length) return threads

  // Group projects
  const repoMap = new Map() // projectPath -> { origin, upstream, prs: [] }
  for (const t of threads) {
    if (!t.projectPath || repoMap.has(t.projectPath)) continue
    const repoInfo = parseGitRepo(t.projectPath)
    if (repoInfo) repoMap.set(t.projectPath, repoInfo)
  }

  if (!repoMap.size) return threads

  const token = await getGitHubToken()

  // Fetch PRs for all unique repos concurrently
  await Promise.all(
    [...repoMap.entries()].map(async ([projectPath, info]) => {
      const prs = []
      // If fork, check upstream first, then origin
      const targets = [info.upstream, info.origin].filter(Boolean)
      for (const target of targets) {
        const repoPrs = await fetchRepoPRs(target.owner, target.repo, token)
        prs.push(...repoPrs)
      }
      info.prs = prs
    })
  )

  const claimedNumbers = new Set()

  // Attach PR information to each thread
  return threads.map((t) => {
    // If harness already provided a confirmed prState (e.g. from Claude Code desktop store), keep it unless empty
    if (t.prState && t.prState !== '') return t

    const repoInfo = repoMap.get(t.projectPath)
    if (!repoInfo || !repoInfo.prs?.length) return t

    const matchedPr = matchThreadPR(t, repoInfo.prs, claimedNumbers)
    if (!matchedPr) return t

    claimedNumbers.add(matchedPr.number)
    const prState = matchedPr.merged ? 'merged' : matchedPr.state
    return {
      ...t,
      prState,
      prNumber: matchedPr.number,
      prTitle: matchedPr.title,
      prUrl: matchedPr.url,
    }
  })
}
