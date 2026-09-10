import { mergeState } from './merge-state.js'

/**
 * Hosted or local. Local is `npm run dev`: the API lives in the Vite server on this machine
 * and does the scanning itself. Hosted is the same page served by a workspace: the scanning
 * happens in the page (see `src/scan/`), the server only keeps the colony file and a snapshot,
 * and every request carries the workspace's sign-in cookie.
 */
export const HOSTED = import.meta.env.VITE_HOSTED === '1'
const API = import.meta.env.VITE_API_BASE || '/api'

/** Where the workspace's sign-in lives; it comes back to this page afterwards. */
function signInRedirect() {
  const next = window.location.pathname + window.location.search
  window.location.assign(`/?next=${encodeURIComponent(next)}`)
}

async function req(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options })
  if (HOSTED && res.status === 401) {
    signInRedirect()
    throw new Error('Sign in to see your planet')
  }
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

export const fetchThreads = () => req(`${API}/threads`)

/**
 * The colony file, and the base every later save is measured against.
 *
 * `baseUpdatedAt` is the file version this tab last agreed with; `baseSnapshot` is the state as
 * it looked at that moment. The snapshot is the half that matters: without it a conflicted save
 * can only union the two lists, and a union can never express "I un-archived this".
 */
let baseUpdatedAt = 0
let baseSnapshot = null

function adoptBase(state, updatedAt) {
  baseUpdatedAt = Number(updatedAt ?? state?.updatedAt) || 0
  // Cloned, because the page mutates the object it holds. Sharing the reference would let
  // `local` and `base` drift into being the same thing, which reads as "this tab changed
  // nothing" and quietly turns every save back into last-writer-wins.
  baseSnapshot = structuredClone(state)
}

export const fetchState = async () => {
  const state = await req(`${API}/state`)
  adoptBase(state)
  return state
}

/** Enough attempts to get through a burst of saves from another tab, and no more. */
const SAVE_TRIES = 3

/**
 * Save the colony, merging rather than clobbering if another tab got there first.
 *
 * The server answers 409 with what is on disk when this tab's base is stale. That is not a
 * failure to report at the user — it is the normal shape of two tabs being open — so it is
 * merged and re-sent here. The base for the next attempt is the disk state just merged against,
 * which keeps a retry from re-applying edits it has already folded in.
 *
 * Returns the state the caller should hold from now on: the *same object* when nothing
 * conflicted, so the common path never swaps the page's state out from under a click that
 * happened mid-flight, and only a real merge hands back something new.
 */
export async function saveState(state) {
  let local = state
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const res = await fetch(`${API}/state`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...local, baseUpdatedAt }),
    })
    if (HOSTED && res.status === 401) {
      signInRedirect()
      throw new Error('Sign in to see your planet')
    }
    const body = await res.json().catch(() => ({}))

    if (res.status === 409) {
      local = mergeState(baseSnapshot, local, body)
      adoptBase(body)
      continue
    }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
    adoptBase(local, body.updatedAt)
    return local
  }
  // Losing three times running means the other tab is saving faster than we can merge. The
  // caller swallows this: nothing local is lost, and the next save tries again.
  throw new Error('Could not save the colony — another tab kept writing first')
}

/**
 * Hand a thread back to whichever harness owns it — the desktop app comes forward on its own.
 *
 * Locally the server hands the harness's deep link to the OS opener. Hosted, the page *is* on
 * the machine that runs the harness, so it navigates to the deep link itself and the browser
 * asks the OS to open it. `ref` stays opaque either way: whatever the harness's adapter needs
 * to find the thread again.
 */
export const openThread = (thread) => {
  if (!HOSTED) return post(`${API}/open`, { harness: thread.harness, ref: thread.ref })
  if (!thread.canOpen || !thread.openUrl) {
    throw new Error(thread.openHint || 'That thread cannot be opened from here')
  }
  return openDeepLink(thread.openUrl)
}

/** Navigate to a `harness://` link. The page stays put; the OS hands the link to its app. */
export function openDeepLink(url) {
  window.location.assign(url)
  return Promise.resolve({ ok: true, url })
}

/** A brand new thread in a repo, via that harness's own new-session deep link. */
export const newSession = (folder, harness) => post(`${API}/new-session`, { folder, harness })

export const revealFolder = (folder) => {
  if (HOSTED) return Promise.reject(new Error('Not available on a hosted planet — the folder is on your computer'))
  return post(`${API}/reveal`, { folder })
}

/** Hosted only: what the in-page scanner saw, so the planet shows from another device too. */
export const putSnapshot = async (snapshot) => {
  const res = await fetch(`${API}/snapshot`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}
