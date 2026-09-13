/**
 * Opt-in, read-only GitHub/Jira evidence.
 *
 * Remote systems are queried only for identifiers explicitly listed in the
 * reviewed join file. No branch-name guessing, no transcript data, no paths,
 * and no write-capable HTTP method. A failed refresh keeps the last good item
 * with a visible stale/error provenance record.
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'

export const JOIN_SCHEMA = 't100.work-join/v1'

const array = (v) => (Array.isArray(v) ? v : [])
const text = (v) => (v == null ? '' : String(v))
const targetsOf = (item) =>
  [...new Set([...array(item.targets), item.target].filter(Boolean).map(text))].slice(0, 32)

export function normalizeJoin(raw = {}) {
  const github = array(raw.github)
    .map((item) => ({
      repo: text(item.repo),
      number: Number(item.number),
      kind: item.kind === 'issue' ? 'issue' : 'pull',
      targets: targetsOf(item),
    }))
    .filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item.repo) && Number.isInteger(item.number) && item.number > 0 && item.targets.length)

  const jira = array(raw.jira)
    .map((item) => ({ key: text(item.key).toUpperCase(), targets: targetsOf(item) }))
    .filter((item) => /^[A-Z][A-Z0-9_]+-\d+$/.test(item.key) && item.targets.length)

  const claims = new Map()
  for (const item of github) {
    const id = `github:${item.repo}#${item.number}`
    claims.set(id, [...new Set([...(claims.get(id) || []), ...item.targets])])
  }
  for (const item of jira) {
    const id = `jira:${item.key}`
    claims.set(id, [...new Set([...(claims.get(id) || []), ...item.targets])])
  }
  const conflicts = [...claims]
    .filter(([, targets]) => targets.length > 1)
    .map(([id, targets]) => ({ id, targets, reason: 'one external item is joined to multiple targets' }))

  return { schemaVersion: JOIN_SCHEMA, github, jira, conflicts }
}

const cache = new Map()

async function remoteJson(url, headers, fetchImpl) {
  const previous = cache.get(url)
  const requestHeaders = { Accept: 'application/json', ...headers }
  if (previous?.etag) requestHeaders['If-None-Match'] = previous.etag
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: requestHeaders,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 304 && previous) return { ...previous, fetchedAt: Date.now(), stale: false, error: '' }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const value = {
      body: await res.json(),
      etag: res.headers.get('etag') || '',
      fetchedAt: Date.now(),
      stale: false,
      error: '',
    }
    cache.set(url, value)
    return value
  } catch (error) {
    if (previous) return { ...previous, stale: true, error: error?.message || String(error) }
    return { body: null, etag: '', fetchedAt: 0, stale: true, error: error?.message || String(error) }
  }
}

const githubItem = (join, body) => ({
  source: 'github',
  id: `${join.repo}#${join.number}`,
  kind: body.pull_request || join.kind === 'pull' ? 'pull' : 'issue',
  title: text(body.title),
  state: text(body.state),
  actor: text(body.user?.login),
  updatedAt: Date.parse(body.updated_at || '') || 0,
  url: text(body.html_url),
  targets: join.targets,
  evidenceClass: 'declared',
})

const jiraItem = (join, body) => ({
  source: 'jira',
  id: join.key,
  kind: text(body.fields?.issuetype?.name || 'work item'),
  title: text(body.fields?.summary),
  state: text(body.fields?.status?.name),
  actor: text(body.fields?.assignee?.displayName || body.fields?.assignee?.accountId),
  updatedAt: Date.parse(body.fields?.updated || '') || 0,
  url: '',
  targets: join.targets,
  evidenceClass: 'declared',
})

export async function loadTeamEvidence(cfg, { fetchImpl = fetch } = {}) {
  let raw = {}
  let joinObservedAt = 0
  let joinSource = 'none'
  if (cfg.joinFile && fs.existsSync(cfg.joinFile)) {
    try {
      const stat = await fsp.stat(cfg.joinFile)
      joinObservedAt = stat.mtimeMs
      raw = JSON.parse(await fsp.readFile(cfg.joinFile, 'utf8'))
      joinSource = cfg.joinFile.includes('/fixtures/') ? 'fixture' : 'live'
    } catch {
      raw = {}
    }
  }
  const join = normalizeJoin(raw)
  const items = []
  const provenance = {
    join: { source: joinSource, kind: 'authored', observedAt: joinObservedAt, schemaVersion: join.schemaVersion },
    github: { enabled: cfg.github.enabled, source: 'remote', fetchedAt: 0, stale: false, errors: [] },
    jira: { enabled: cfg.jira.enabled, source: 'remote', fetchedAt: 0, stale: false, errors: [] },
  }

  if (cfg.github.enabled) {
    for (const item of join.github) {
      const url = `${cfg.github.api}/repos/${encodeURIComponent(item.repo.split('/')[0])}/${encodeURIComponent(item.repo.split('/')[1])}/issues/${item.number}`
      const headers = {
        'X-GitHub-Api-Version': '2022-11-28',
        ...(cfg.github.token ? { Authorization: `Bearer ${cfg.github.token}` } : {}),
      }
      const result = await remoteJson(url, headers, fetchImpl)
      provenance.github.fetchedAt = Math.max(provenance.github.fetchedAt, result.fetchedAt)
      provenance.github.stale ||= result.stale
      if (result.error) provenance.github.errors.push(`${item.repo}#${item.number}: ${result.error}`)
      if (result.body) items.push(githubItem(item, result.body))
    }
  }

  if (cfg.jira.enabled && cfg.jira.url) {
    for (const item of join.jira) {
      const url = `${cfg.jira.url}/rest/api/3/issue/${encodeURIComponent(item.key)}?fields=summary,status,assignee,updated,issuetype`
      const basic = cfg.jira.email && cfg.jira.token
        ? Buffer.from(`${cfg.jira.email}:${cfg.jira.token}`).toString('base64')
        : ''
      const result = await remoteJson(url, basic ? { Authorization: `Basic ${basic}` } : {}, fetchImpl)
      provenance.jira.fetchedAt = Math.max(provenance.jira.fetchedAt, result.fetchedAt)
      provenance.jira.stale ||= result.stale
      if (result.error) provenance.jira.errors.push(`${item.key}: ${result.error}`)
      if (result.body) {
        const normalized = jiraItem(item, result.body)
        normalized.url = `${cfg.jira.url}/browse/${encodeURIComponent(item.key)}`
        items.push(normalized)
      }
    }
  }

  return { items, join, conflicts: join.conflicts, provenance }
}
