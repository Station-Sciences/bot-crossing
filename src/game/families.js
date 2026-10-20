/**
 * Families: which threads on the map started which.
 *
 * A harness that knows reports `spawnedBy` on a thread — the id of the thread that started it
 * as a session of its own (not a subagent: those are errands, and go through `errands.js`).
 * A thread with crew of its own still on the map is a *manager*; the rest of the colony only
 * ever asks this module, so the rule for what counts lives in one place.
 *
 * Only links between two threads that are both on the map count. A child whose manager was
 * archived is an ordinary thread again, and a manager whose last child went home is too —
 * a foreman with nobody to watch is just a bot standing around in a hat.
 *
 * Pure and browser-free, so the rules can be tested without a scene.
 */

/** The statuses that mean a thread is waiting on you rather than working or resting. */
const NEEDS_YOU = ['blocked', 'approval', 'waiting']

/** Children oldest first: the order they were sent out in, which is the order a ring visits them. */
const byAge = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id)

/**
 * `{ crewOf, managerOf }` over `threads`, which should already be only the ones on the map.
 * `crewOf` maps a manager's id to its children's ids; `managerOf` maps a child to its manager.
 */
export function buildFamilies(threads) {
  const byId = new Map()
  for (const t of threads || []) if (t?.id) byId.set(t.id, t)
  const crew = new Map()
  const managerOf = new Map()
  for (const t of byId.values()) {
    const parent = t.spawnedBy
    if (!parent || parent === t.id || !byId.has(parent)) continue
    managerOf.set(t.id, parent)
    if (!crew.has(parent)) crew.set(parent, [])
    crew.get(parent).push(t)
  }
  // Nothing here walks more than one link, so even a loop in the records (which the app cannot
  // write, but a record is only JSON on disk) costs nothing worse than an odd-looking family.
  const crewOf = new Map()
  for (const [id, list] of crew) crewOf.set(id, list.sort(byAge).map((t) => t.id))
  return { crewOf, managerOf }
}

export const isManager = (families, id) => Boolean(families?.crewOf.get(id)?.length)

/**
 * The ring the family key walks from `id`: its manager, then that manager's crew in the order
 * they were sent out. A thread that is both — managing crew while itself one of someone else's —
 * walks the family it belongs to, since that is the one you came in through; its own crew is a
 * click away on its card. Empty for a thread with no family.
 */
export function familyRing(families, id) {
  if (!families || !id) return []
  const head = families.managerOf.get(id) ?? (isManager(families, id) ? id : null)
  if (!head) return []
  return [head, ...families.crewOf.get(head)]
}

/**
 * Whether a thread's astronaut stands supervising: it has crew, it has nothing of its own on
 * (idle — one that is working, or wants you, does that instead), and some of its crew are
 * still busy or waiting on you. A foreman whose crew have all stopped is just idle.
 */
export function isSupervising(status, summary) {
  return status === 'idle' && Boolean(summary && summary.working + summary.needsYou > 0)
}

/**
 * How a manager's crew is doing, for its card and its pose: how many are still building, how
 * many are stuck on you, and how many have stopped. `statusOf` maps an id to its status.
 */
export function crewSummary(families, id, statusOf) {
  const crew = families?.crewOf.get(id) || []
  const out = { total: crew.length, working: 0, needsYou: 0, done: 0 }
  for (const child of crew) {
    const status = statusOf(child)
    if (status === 'working') out.working++
    else if (NEEDS_YOU.includes(status)) out.needsYou++
    else out.done++
  }
  return out
}
