/**
 * Archiving here, and taking it back.
 *
 * An archive is only the colony's own list — the harness is never written — so un-archiving
 * is removing ids from it. The catch is *which* ids: the server counts a thread archived when
 * any id it answers to is on the list, including the older ones in `ref` from before it
 * re-keyed. Removing only the current id would leave the thread archived under an old one.
 *
 * A thread archived in its harness's own app reports that itself, and the colony has no way
 * to undo it. The server marks which kind each archive is (`archivedInHarness`), so those are
 * never offered back here.
 */

/**
 * Every id a thread answers to — the same strings the server matches archives against. An
 * archived thread arrives as a stub carrying only the ones that matched (`archivedAs`); a live
 * one carries them all in `ref`.
 */
export function threadIds(thread) {
  const ids = [thread.id, ...(thread.archivedAs || [])]
  for (const value of Object.values(thread.ref || {})) {
    if (typeof value === 'string' && value) ids.push(value)
    else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string' && v) ids.push(v)
  }
  return ids
}

/** On the colony's own list under any of its ids. */
export function archivedHere(thread, archivedSet) {
  return threadIds(thread).some((id) => archivedSet.has(id))
}

/** Archived in the harness itself, which only the harness can take back. */
export const archivedInHarness = (thread) => thread.archivedInHarness ?? thread.archived === true

/** The archive list and timestamps with every id this thread answers to taken out. */
export function unarchive(state, thread) {
  const ids = new Set(threadIds(thread))
  const archivedAt = { ...(state.archivedAt || {}) }
  for (const id of ids) delete archivedAt[id]
  return { archived: (state.archived || []).filter((id) => !ids.has(id)), archivedAt }
}

/**
 * The scan's `archived` flag is a poll old. Once a thread is off the list it should be back
 * on the map now, not in fifteen seconds — unless its harness archived it too.
 */
export function withLocalArchive(thread, archivedSet) {
  if (!thread.archived || archivedInHarness(thread) || archivedHere(thread, archivedSet)) return thread
  return { ...thread, archived: false }
}

/** Restorable archives in the repos `include` accepts, most recently archived first. */
export function restorableArchives(threads, state, include) {
  const archivedSet = new Set(state.archived || [])
  const at = state.archivedAt || {}
  const when = (t) => Math.max(0, ...threadIds(t).map((id) => at[id] || 0))
  return threads
    .filter((t) => include(t.project) && archivedHere(t, archivedSet) && !archivedInHarness(t))
    .map((t) => ({ id: t.id, title: t.title, project: t.project, archivedAt: when(t) }))
    .sort((a, b) => b.archivedAt - a.archivedAt)
}

/** A zone's restorable archives. */
export const archivedInProject = (threads, state, project) => restorableArchives(threads, state, (p) => p === project)
