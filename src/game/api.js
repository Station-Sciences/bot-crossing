async function req(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

const post = (url, payload) =>
  req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

export const fetchThreads = () => req('/api/threads')
export const fetchState = () => req('/api/state')

export const saveState = (state) =>
  req('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })

/**
 * Hand a thread back to whichever harness owns it — the desktop app comes forward on its own.
 *
 * `ref` is opaque here on purpose: it is whatever that harness's adapter needs to find the
 * thread again, and the browser only ever passes it straight back. Nothing in the UI knows
 * what a Claude Code session id, or a Codex rollout id, actually looks like.
 */
export const openThread = (thread) =>
  post('/api/open', { harness: thread.harness, ref: thread.ref, cwd: thread.cwd })

export const archiveThread = (thread, archived) =>
  post('/api/archive', { id: thread.id, harness: thread.harness, ref: thread.ref, archived })

/** A brand new thread in a repo, via that harness's own new-session deep link. */
export const newSession = (folder, harness) => post('/api/new-session', { folder, harness })

export const revealFolder = (folder) => post('/api/reveal', { folder })
