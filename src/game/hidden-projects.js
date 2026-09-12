/**
 * Repos you have taken off the map.
 *
 * Colony-only, and that is the whole point: hiding writes nothing to any harness and archives
 * nothing. The threads stay exactly where they are and keep working; the map just stops drawing
 * that repo until you show it again. It is for the checkout you have forty dead threads in and
 * do not want owning a third of your ground.
 *
 * Keyed on stable plot identity. Display names may collide or change as another checkout
 * appears; neither event should put a hidden repository back on the map.
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

/** The threads the colony should actually draw. */
export function liveThreadsForColony(threads, archivedIds, hiddenProjects) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  return threads.filter((t) => !t.archived && !archived.has(t.id) && !hidden.has(t.plotKey || t.project || 'unknown'))
}

/**
 * What the sidebar lists, with a live count each — so a hidden repo that has since gone quiet
 * reads as `0` and you can tell it is safe to forget rather than having to show it to find out.
 */
export function hiddenCatalog(hidden, threads) {
  const ids = [...new Set(hidden.map(String).filter(Boolean))]
  return ids
    .map((key) => {
      const matches = threads.filter((t) => !t.archived && (t.plotKey || t.project || 'unknown') === key)
      return { key, name: matches[0]?.project || key, count: matches.length }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
