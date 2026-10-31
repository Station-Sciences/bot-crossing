/**
 * Thread → behaviour, with nothing but plain data in and a word out.
 *
 * Lives apart from colony.js because the server needs the same rule: a shared snapshot folds
 * dormant repos away exactly as the sharer's own map does, and colony.js cannot load in Node.
 */

export const STALE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Whether an error still earns the `!`. `hasError` describes the last turn, so it is sticky by
 * nature: a thread that failed a month ago still says so, and the adapter is right to report it.
 * But as the first rule below it outranked the three-day sleep every other thread gets, so one
 * abandoned failure held its astronaut slumped and badged for as long as the thread existed, and
 * kept its whole repo from folding away with the other quiet ones. Opening it did not help:
 * viewing clears `unread`, not `hasError`.
 *
 * So an error goes quiet on the same clock as everything else. The flag is untouched, only the
 * alarm decays, and a thread that failed on Friday afternoon is still red on Monday morning.
 */
export const isAlarming = (thread, now = Date.now()) =>
  Boolean(thread.hasError) && now - thread.lastActivityAt <= STALE_MS

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  if (isAlarming(thread, now)) return 'blocked'
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
