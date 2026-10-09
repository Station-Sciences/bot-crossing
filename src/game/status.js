/**
 * Thread → behaviour, with nothing but plain data in and a word out.
 *
 * Lives apart from colony.js because the server needs the same rule: a shared snapshot folds
 * dormant repos away exactly as the sharer's own map does, and colony.js cannot load in Node.
 */

export const STALE_MS = 3 * 24 * 60 * 60 * 1000

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/** The dormant fold's line, drawn at the repo: every thread in it asleep. */
export function allSleeping(list, now = Date.now()) {
  return list.length > 0 && list.every((t) => statusFor(t, now) === 'sleeping')
}
