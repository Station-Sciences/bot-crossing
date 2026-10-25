/**
 * Errands: the subagents a thread has out right now, as threads of their own.
 *
 * A harness that can see them hands back `subagents` on the parent — `{ id, task,
 * lastActivityAt }` each. This turns every one into an ordinary thread, so the rest of the
 * colony needs to know almost nothing about them: an errand lands in its parent's zone because
 * it inherits the project and carries `parentId`.
 *
 * Where a subagent differs from a scanned thread is that it has no session of its own — nothing
 * to open, no transcript, no life once its parent is done with it. So the colony reads `parentId`
 * off it to keep it *at* the parent: it raises no building, it is born standing beside the
 * parent's and stays confined to that zone rather than walking in from the ship and back out
 * again, and when the errand ends it blinks out where it stood instead of trekking home. That
 * confinement lives in `colony.js` (the parent's building, no slot of its own) and
 * `astronauts.js` (born on the map, dropped rather than sent home), keyed on `isErrandId`.
 *
 * Pure and browser-free, because every way of getting it wrong is a way of forking a thread
 * into two astronauts — an id collision here would put one bot on the map twice and leave the
 * archive list keyed on something that is not a real session.
 */

/**
 * `<parent id>:errand:<subagent id>`. Prefixed rather than the bare subagent id because the
 * colony keys its archive list and saved layout on this string, and a subagent id is only
 * unique inside its parent's folder.
 */
export const errandId = (parentId, subId) => `${parentId}:errand:${subId}`

/** True for an id `errandId` made, so a caller can tell a derived thread from a scanned one. */
export const isErrandId = (id) => typeof id === 'string' && id.includes(':errand:')

export function withErrands(list) {
  const out = []
  for (const thread of list || []) {
    const errands = thread.subagents || []
    // The parent gives up the array as it is flattened. Nothing downstream reads it, and
    // leaving it on would let a second pass over the same list fan every errand out twice.
    out.push(errands.length ? { ...thread, subagents: undefined } : thread)
    for (const sub of errands) {
      if (!sub || !sub.id) continue
      out.push({
        ...thread,
        id: errandId(thread.id, sub.id),
        title: sub.task || 'Errand',
        preview: '',
        // Not carried down: an errand is not itself a parent, and leaving the array on the copy
        // would make a second pass fan it out again.
        subagents: undefined,
        parentId: thread.id,
        lastActivityAt: sub.lastActivityAt ?? thread.lastActivityAt,
        // Busy by definition. Never unread — an errand is not the thing asking for you, its
        // parent is, and a `?` over both would double-count the one thread that wants an answer.
        running: true,
        unread: false,
        hasError: false,
        prState: null,
        archived: false,
        hasTranscript: false,
        sizeBytes: 0,
        // Nothing to open: a subagent has no session of its own to resume.
        canOpen: false,
        ref: null,
      })
    }
  }
  return out
}
