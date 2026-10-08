/**
 * Which bot the jump keys land on next — J (next crew), B (busiest), N (needs you).
 *
 * Kept free of the scene so the orderings can be tested: every function here takes plain
 * `{ id, status, project, lastActivityAt }` candidates, which main.js reads off the agents.
 *
 * Scope is the same for every key. Plain stays inside the open zone; shift goes *outside*
 * it, to every other zone. With no zone open there is nothing to be inside of, so both mean
 * the whole colony.
 */

/** Everything the "needs you" key covers, most urgent first. */
export const NEEDS_YOU = ['blocked', 'approval', 'waiting']

/** What the busiest key covers: anyone stuck on you, plus anyone building. Idle, asleep and
 *  shipped bots have nothing going on to jump to. */
export const ACTIVE = [...NEEDS_YOU, 'working']

/** The candidates one side of the open zone's boundary. */
export function inScope(candidates, project, { outside = false } = {}) {
  if (!project) return candidates
  return candidates.filter((c) => (c.project === project) !== outside)
}

/** Legend order, then id — so walking it visits one zone's crew together, zones in turn. */
export function crewOrder(candidates, projectOrder = []) {
  const rank = new Map(projectOrder.map((id, i) => [id, i]))
  const at = (c) => rank.get(c.project) ?? projectOrder.length
  return [...candidates].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id))
}

/** The first crew member after `selectedId` in `ordered` that `allowed` accepts, wrapping. */
export function nextInRing(ordered, allowed, selectedId = null) {
  const from = ordered.findIndex((c) => c.id === selectedId)
  for (let step = 1; step <= ordered.length; step++) {
    const c = ordered[(from + step) % ordered.length]
    if (allowed(c)) return c.id
  }
  return null
}

/**
 * Busiest first. "Busiest" is a proxy — errored crew, then most recent activity — until
 * real per-agent spend or call counts exist to rank by instead.
 */
export function busiestOrder(candidates) {
  return [...candidates].sort(
    (a, b) =>
      (b.status === 'blocked') - (a.status === 'blocked') ||
      (b.lastActivityAt || 0) - (a.lastActivityAt || 0) ||
      a.id.localeCompare(b.id)
  )
}

/** Most urgent state first, then whoever has been left waiting the longest. */
export function needsYouOrder(candidates) {
  const tier = (c) => {
    const i = NEEDS_YOU.indexOf(c.status)
    return i < 0 ? NEEDS_YOU.length : i
  }
  return [...candidates].sort(
    (a, b) => tier(a) - tier(b) || (a.lastActivityAt || 0) - (b.lastActivityAt || 0) || a.id.localeCompare(b.id)
  )
}

/**
 * A run of presses on one key, walking a ranking fixed at the first press.
 *
 * The rankings move under you — activity times change every poll, and a shift-jump opens
 * a different zone, which changes what "outside" means — so re-ranking on every press
 * skips some bots and revisits others. Instead the first press takes a snapshot, and the
 * run continues for as long as you are still standing on the bot it last picked. Click
 * somebody else, pick a zone, or press a different key, and the next press starts afresh
 * from the top.
 */
export class JumpRun {
  constructor() {
    this.key = null
    this.ids = []
    this.last = null
  }

  /**
   * @param {string} key       which key and modifier this is; a different one starts a new run
   * @param {string|null} selectedId
   * @param {() => string[]} rank  the ranking, called only when a new run starts
   * @param {(id: string) => boolean} alive  still on the surface, and still qualifies
   * @returns {string|null} who to fly to, or null if nobody in the snapshot qualifies
   */
  next(key, selectedId, rank, alive) {
    const fresh = key !== this.key || !selectedId || selectedId !== this.last
    if (fresh) {
      this.key = key
      this.ids = rank()
    }
    const ids = this.ids
    const from = fresh ? -1 : ids.indexOf(selectedId)
    let pick = null
    for (let step = 1; step <= ids.length; step++) {
      const id = ids[(from + step) % ids.length]
      if (id === selectedId || !alive(id)) continue
      pick = id
      break
    }
    // The bot you are already on is the only one left: stay put rather than say nobody.
    if (!pick && selectedId && ids.includes(selectedId) && alive(selectedId)) pick = selectedId
    this.last = pick
    return pick
  }

  reset() {
    this.key = null
    this.last = null
  }
}
