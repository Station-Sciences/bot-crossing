/**
 * Errands: the subagents a thread has out right now, as threads of their own.
 *
 * A harness that can see them hands back `subagents` on the parent — `{ id, task,
 * lastActivityAt }` each. This turns every one into an ordinary thread so the rest of the
 * colony needs to know nothing about them: an errand lands in its parent's zone because it
 * inherits the project, it walks out of the airlock on the poll it first appears because the
 * colony already stages an entrance for a thread it has not seen, and it leaves when the errand
 * ends the same way any thread that stops being scanned does.
 *
 * Drawing them as small companions at the parent's building was the other option and was
 * rejected: a subagent is doing the same kind of work as everything else on the map, and a
 * second, smaller visual vocabulary for it buys nothing but a special case in the renderer.
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
