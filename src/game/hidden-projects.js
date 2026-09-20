/**
 * Repos you have taken off the map.
 *
 * Colony-only, and that is the whole point: hiding writes nothing to any harness and archives
 * nothing. The threads stay exactly where they are and keep working; the map just stops drawing
 * that repo until you show it again. It is for the checkout you have forty dead threads in and
 * do not want owning a third of your ground.
 *
 * Keyed on the project *name*, which is what plots are keyed on too. That has a consequence
 * worth knowing: a second checkout of the same repo appearing renames `foo` to `1/foo` (see
 * `disambiguateProjects` in server/scan.mjs) and the hide quietly stops matching. Keying on the
 * path instead would fix it and break the moment somebody moves a folder, and the layout has the
 * same trade — so both are wrong in the same direction, which is at least predictable.
 */

export function hideProject(hidden, name) {
  const id = String(name || '')
  if (!id || hidden.includes(id)) return [...hidden]
  return [...hidden, id]
}

export function unhideProject(hidden, name) {
  const id = String(name || '')
  return hidden.filter((n) => n !== id)
}

/**
 * How long after a thread's last activity its repo keeps its ground.
 *
 * A `.jsonl` never leaves disk, so left alone the colony grows a zone for every repo you have
 * ever run a session in and never shrinks. "Active today" is the line: a repo earns a plot only
 * while something in it has a live process, or stirred in the last day. Everything older is still
 * on disk, still archivable, still there the moment it moves again — it just stops owning ground.
 */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/** True while a thread's repo should hold ground: a live process, or activity inside the window. */
export function isActiveToday(thread, now = Date.now()) {
  if (thread.hasLiveProcess === true) return true
  return now - (thread.lastActivityAt || thread.createdAt || 0) < ACTIVE_WINDOW_MS
}

/** The threads the colony should actually draw. */
export function liveThreadsForColony(threads, archivedIds, hiddenProjects, now = Date.now()) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  return threads.filter(
    (t) =>
      !t.archived &&
      !archived.has(t.id) &&
      !hidden.has(t.project || 'unknown') &&
      isActiveToday(t, now)
  )
}

/**
 * What the sidebar lists, with a live count each — so a hidden repo that has since gone quiet
 * reads as `0` and you can tell it is safe to forget rather than having to show it to find out.
 */
export function hiddenCatalog(hidden, threads) {
  const names = [...new Set(hidden.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return names.map((name) => ({
    name,
    count: threads.filter((t) => !t.archived && (t.project || 'unknown') === name).length,
  }))
}
