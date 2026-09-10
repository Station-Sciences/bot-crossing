/**
 * Which threads get a body when there are more threads than astronauts.
 *
 * The HUD counts every thread in the scan, but `maxAgents` caps how many astronauts are
 * actually on the surface. A plain positional cut ("first N in roster order") is ordered by
 * project size and thread age — never by status — so the threads most worth watching are the
 * likeliest to be cut: a working thread is by definition recently active, which puts it at
 * the very end of its project's age-sorted list. That is how a colony ends up saying
 * "1 building" while no builder exists to click.
 *
 * So the cut is by status first: everything the chips call urgent — blocked, waiting,
 * working — outranks idle and dormant, and inside one status the incoming order (biggest
 * project, oldest thread) is preserved, so the crew stays put between scans. Membership only
 * changes when a thread actually changes status, which is exactly when the player would
 * expect the crew to change.
 *
 * Pure and browser-free on purpose, like merge-state.js, so it runs under bare node.
 */

/**
 * The zone a thread belongs to. Scanners tolerate threads with no project, and the colony
 * plots those under 'unknown' — every grouping, count and lookup has to apply the same
 * rule, or the unknown zone drifts apart from its own card and legend.
 */
export const projectKey = (thread) => thread.project || 'unknown'

/** Loudest first. Doubles as the spawn priority when the cap forces a choice. */
export const STATUS_ORDER = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']

/**
 * The statuses the HUD turns into clickable chips (STAT_DEFS in hud.js). Named outright
 * rather than sliced off STATUS_ORDER, so reordering the spawn priority cannot silently
 * change which statuses the representative guarantee below covers — it only ever spends
 * bodies on these, because seating an idle or dormant astronaut by evicting a blocked one
 * would cost a click target to buy something no chip can reach.
 */
export const CHIP_STATUSES = ['blocked', 'waiting', 'working', 'celebrating']

const RANK = new Map(STATUS_ORDER.map((status, i) => [status, i]))

/** One rank source for every status sort — an unknown status always sorts last, everywhere. */
export const statusRank = (status) => RANK.get(status) ?? STATUS_ORDER.length

/**
 * Pick which roster entries get an astronaut. Entries must carry a `status`; the incoming
 * order is preserved within each status. Deterministic: the same entries and cap always
 * return the same crew, so a re-scan that changed nothing moves nobody.
 */
export function capRoster(entries, cap) {
  if (entries.length <= cap) return entries
  // Array.prototype.sort is stable, which is load-bearing here: it is what keeps a quiet
  // scan from reshuffling the crew.
  const sorted = [...entries].sort((a, b) => statusRank(a.status) - statusRank(b.status))
  const wanted = sorted.slice(0, cap)

  // A tiny cap can still be exhausted by one loud status — 200 blocked threads under a cap
  // of 90 would leave "1 building" unclickable all over again. Guarantee every *chip*
  // status in the scan one representative by evicting from the tail, never a status's own
  // last body.
  const counts = new Map()
  for (const entry of wanted) counts.set(entry.status, (counts.get(entry.status) || 0) + 1)
  for (const status of CHIP_STATUSES) {
    if (counts.get(status)) continue
    const promote = sorted.find((entry) => entry.status === status)
    if (!promote) continue
    for (let i = wanted.length - 1; i >= 0; i--) {
      const evict = wanted[i].status
      if ((counts.get(evict) || 0) < 2) continue
      counts.set(evict, counts.get(evict) - 1)
      counts.set(status, 1)
      wanted[i] = promote
      break
    }
  }
  return wanted
}
