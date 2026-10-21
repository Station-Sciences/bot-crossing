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

/**
 * Squad colours: a manager's pennant, and the backpacks of the crew it sent out. Picked to sit
 * apart from the status colours the trims and lamps use — green, blue, red and amber all mean
 * something already, so none of them is here.
 */
export const SQUAD_PALETTE = [0xff8a3d, 0xe05ab8, 0x3cc7d6, 0x9b6bff, 0xc6e04a, 0xff6f91]

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

/**
 * Each manager's colour, keyed by its id. A manager prefers the colour its id hashes to and
 * takes the next free one along when that is taken, oldest manager first — so a colour, once a
 * manager has it, survives a younger manager turning up. Colours repeat only once there are
 * more managers on the map than colours.
 */
export function squadColors(families, createdAtOf = () => 0) {
  const managers = [...(families?.crewOf.keys() || [])].sort(
    (a, b) => (createdAtOf(a) || 0) - (createdAtOf(b) || 0) || a.localeCompare(b)
  )
  const out = new Map()
  const taken = new Set()
  for (const id of managers) {
    const start = hashId(id) % SQUAD_PALETTE.length
    let pick = start
    for (let step = 0; step < SQUAD_PALETTE.length; step++) {
      const i = (start + step) % SQUAD_PALETTE.length
      if (!taken.has(i)) {
        pick = i
        break
      }
    }
    if (taken.size >= SQUAD_PALETTE.length) taken.clear()
    taken.add(pick)
    out.set(id, SQUAD_PALETTE[pick])
  }
  return out
}

function hashId(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
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
 * The team key's next stop: the lead of the next team in the same repo, skipping the rest of
 * the team `fromId` is on. A team is a family as far as it reaches into this repo — a manager
 * and its crew — and a bot with no family is a team of its own, so every bot is reachable.
 *
 * `ids` is the repo's bots on the map, in the order teams are toured (oldest first, so the tour
 * holds still between presses). A team's lead is its manager when the manager is in `ids`, and
 * otherwise whichever of its crew comes first. With no `fromId`, or one not in `ids`, the first
 * team's lead (or, going back, the last's). Null when there is no other team to go to.
 */
export function nextTeam(families, ids, fromId = null, { back = false } = {}) {
  const here = new Set(ids)
  const teamOf = (id) => familyRing(families, id)[0] ?? id
  const teams = []
  const leads = new Map()
  for (const id of ids) {
    const team = teamOf(id)
    if (!leads.has(team)) {
      teams.push(team)
      leads.set(team, here.has(team) ? team : id)
    }
  }
  if (!teams.length) return null
  const from = here.has(fromId) ? teams.indexOf(teamOf(fromId)) : -1
  if (from < 0) return leads.get(back ? teams[teams.length - 1] : teams[0])
  if (teams.length < 2) return null
  const step = back ? -1 : 1
  return leads.get(teams[(from + step + teams.length) % teams.length])
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
 * Crew that finished a turn between two polls, as `[manager, crew]` pairs: working on the
 * last one and not now — the moment its result goes back to the session that started it.
 * `before` and `after` map ids to statuses. With no `before` (the first roster) nothing has
 * finished: a reload is not a report.
 */
export function finishedTurns(families, before, after) {
  if (!before || !families) return []
  const out = []
  for (const [crew, manager] of families.managerOf) {
    if (before.get(crew) === 'working' && after.get(crew) !== 'working') out.push([manager, crew])
  }
  return out
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

/**
 * The alert each top manager carries for its crew when crew alerts are hidden, keyed by the
 * manager's id: the most urgent status anyone under it is on that needs you, in `NEEDS_YOU`
 * order. "Under" reaches through middle managers — they are crew too, so their own badges are
 * hidden as well, and an alert that stopped at one would never be seen. A manager whose crew
 * want nothing from you is not in the map.
 */
export function crewAlerts(families, statusOf) {
  const out = new Map()
  for (const id of families?.managerOf.keys() || []) {
    const i = NEEDS_YOU.indexOf(statusOf(id))
    if (i < 0) continue
    // Up to the top of the chain. The seen set is for a loop in the records, as above.
    let top = families.managerOf.get(id)
    const seen = new Set([id])
    while (families.managerOf.has(top) && !seen.has(top)) {
      seen.add(top)
      top = families.managerOf.get(top)
    }
    const held = NEEDS_YOU.indexOf(out.get(top))
    if (held < 0 || i < held) out.set(top, NEEDS_YOU[i])
  }
  return out
}

/**
 * The building kind a manager's plot slot gets: a dispatch post, the control tower its crew
 * were sent out from. Everyone else — crew included — keeps whatever their id seeds, so a
 * thread that stops managing gets its own old building back rather than a new random one.
 */
export const DISPATCH_KIND = 'dispatch'

export const buildingKindFor = (families, id) => (isManager(families, id) ? DISPATCH_KIND : null)

/**
 * The flag each crew member's building flies: its manager's squad colour, keyed by the crew
 * member's id. A middle manager flies its *manager's* colour here — the flag says whose squad
 * the building is in, and its own squad's colour is already up on its astronaut's pennant. A
 * manager with no colour yet (nothing should get here without one) flies nothing.
 */
export function crewFlags(families, squads) {
  const out = new Map()
  if (!families || !squads) return out
  for (const [crew, manager] of families.managerOf) {
    const colour = squads.get(manager)
    if (colour != null) out.set(crew, colour)
  }
  return out
}
