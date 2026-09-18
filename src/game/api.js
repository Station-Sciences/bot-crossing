import { mergeState } from './merge-state.js'

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
  const state = await req('/api/state')
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
  // Nothing may be written before the file has been read. The page boots holding an EMPTY
  // archive list and only swaps it for the real one when fetchState() resolves; a save that
  // slips out inside that window PUTs the empty list and erases every archive on disk.
  //
  // The optimistic-concurrency guard does not cover it, by design: `baseUpdatedAt` is 0 until
  // a base is adopted, and the server reads a zero base as a first write and allows it. That
  // is right for a fresh install and wrong for a tab whose read failed — and the two are
  // distinguishable here, which is why the guard lives at this seam rather than at the caller.
  // A fresh install still *read* the file; the server answers a missing one with an empty state
  // rather than an error, so `baseSnapshot` is an object. Only a read that never happened
  // leaves it null.
  //
  // The damage hides itself, which is what makes this worth a guard rather than a comment: the
  // scan carries each harness's own archived flag independently of this file, so a wiped list
  // reads back populated rather than empty. Measured twice by the contributor who found it —
  // an archive list of 50 came back as 11, exactly the number with a Claude Code desktop record.
  if (baseSnapshot === null) throw new Error('Refusing to save a colony that was never read')

  let local = state
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...local, baseUpdatedAt }),
    })
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
 * Hand a thread back to whichever harness owns it — the desktop app comes forward on its own,
 * or a terminal opens with its CLI, whichever `via` asks for.
 *
 * `ref` is opaque here on purpose: it is whatever that harness's adapter needs to find the
 * thread again, and the browser only ever passes it straight back. Nothing in the UI knows
 * what a Claude Code session id, or a Codex rollout id, actually looks like.
 */
export const openThread = (thread, via) => post('/api/open', { harness: thread.harness, ref: thread.ref, via })

/** A brand new thread in a repo, via that harness's own new-session deep link. */
export const newSession = (folder, harness, via) => post('/api/new-session', { folder, harness, via })

export const revealFolder = (folder) => post('/api/reveal', { folder })
