/**
 * Type-to-find over one repo's threads. Pure, so the ranking can be tested without a DOM.
 *
 * Every word of the query must appear somewhere in the thread's title or worktree, in any
 * order, case ignored. Results keep the order they came in, except that a title that starts
 * with the query, then one with a word that does, come first.
 */
export function searchThreads(threads, query) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return threads.slice()

  const scored = []
  threads.forEach((thread, index) => {
    const title = (thread.title || 'Untitled thread').toLowerCase()
    const hay = `${title} ${(thread.worktree || '').toLowerCase()}`
    if (!words.every((w) => hay.includes(w))) return
    const first = words[0]
    const rank = title.startsWith(first) ? 0 : title.split(/[\s\-_/]+/).some((t) => t.startsWith(first)) ? 1 : 2
    scored.push({ thread, rank, index })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).map((s) => s.thread)
}
