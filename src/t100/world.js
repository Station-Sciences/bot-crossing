/**
 * Client-side helpers over the `t100.world/v1` read model.
 *
 * These turn a unit's factual facets into the one thing the map needs: a district
 * "phase" — how far along this unit is — plus the colour and label that phase
 * shows as. Kept pure and three-free so the mapping is testable and identical
 * whether it drives a mesh colour or an inspector row.
 *
 * The phase is intentionally honest: a unit nobody has measured is `unknown`
 * (unlit), not green; a blocked or failing unit is called out above its progress.
 */

/** Phases weakest-to-strongest, with the map colour each one lights as. */
export const PHASE = Object.freeze({
  unknown: { rank: 0, label: 'Unknown', color: 0x3a4150 },
  absent: { rank: 1, label: 'Absent', color: 0x4a4f5c },
  declared: { rank: 2, label: 'Declared', color: 0xb08a3a },
  implemented: { rank: 3, label: 'Implemented', color: 0x2f7fd0 },
  planned: { rank: 3, label: 'Planned', color: 0x9a7bd0 },
  passing: { rank: 5, label: 'Passing', color: 0x39c77a },
  blocked: { rank: 4, label: 'Blocked', color: 0xd06be8 },
  failed: { rank: 6, label: 'Failing', color: 0xf05252 },
})

const FACET_ORDER = ['spec', 'interfaces', 'registers', 'workshop', 'tests', 'telemetry']

const facetRank = (state) => (PHASE[state] ? PHASE[state].rank : 0)

/**
 * A unit's district phase. Failure and blockage dominate (they are what needs a
 * human); otherwise the phase is the strongest facet the evidence supports,
 * floored at the test facet so an untested unit never reads as "done".
 */
export function unitPhase(unit) {
  if (!unit) return 'unknown'
  const failed = unit.tests && Array.isArray(unit.tests.failed) && unit.tests.failed.length > 0
  if (failed) return 'failed'
  if (unit.overlay && (unit.overlay.state === 'blocked' || unit.overlay.blockedOn)) return 'blocked'

  const facets = unit.facets || {}
  const tests = facets.tests ? facets.tests.state : 'unknown'
  if (tests === 'passing') return 'passing'

  // Strongest facet that is not "tests", so structural progress still shows even
  // before any test exists — but capped below "passing".
  let best = 'unknown'
  for (const key of FACET_ORDER) {
    const state = facets[key] ? facets[key].state : 'unknown'
    if (state === 'passing') continue // only the tests facet earns green
    if (facetRank(state) > facetRank(best)) best = state
  }
  // Fold the tests facet's own non-green state in (planned/implemented/declared).
  if (facetRank(tests) > facetRank(best)) best = tests
  return best
}

export function unitPhaseColor(unit) {
  return PHASE[unitPhase(unit)]?.color ?? PHASE.unknown.color
}

/** One-line phase summary for the inspector. */
export function unitPhaseLabel(unit) {
  return PHASE[unitPhase(unit)]?.label ?? 'Unknown'
}

/** Facet rows for the inspector: [{ key, state, evidenceClass, detail }]. */
export function facetRows(unit) {
  const facets = (unit && unit.facets) || {}
  return FACET_ORDER.map((key) => ({
    key,
    state: facets[key]?.state || 'unknown',
    evidenceClass: facets[key]?.evidenceClass || 'unknown',
    detail: facets[key]?.detail || '',
  }))
}

/** Attention items about one unit, most severe first. */
export function attentionForUnit(world, unitId) {
  return (world.attention || []).filter((a) => a.subject === unitId)
}

/** Index units by canonical id for O(1) selection lookups. */
export function indexUnits(world) {
  const map = new Map()
  for (const u of world.units || []) map.set(u.id, u)
  return map
}

/**
 * Split units into placed districts and the unplaced tray. Placed units are those
 * with a floorplan bind; everything else stands in the tray until Architecture
 * binds it — never at guessed coordinates.
 */
export function partitionUnits(world) {
  const placed = []
  const tray = []
  for (const u of world.units || []) {
    if (u.placement && u.placement.bound) placed.push(u)
    else tray.push(u)
  }
  return { placed, tray }
}

/** Logical connections that touch a given unit id (either endpoint prefix-matches). */
export function connectionsForUnit(world, unitId) {
  if (!unitId) return []
  return (world.connections || []).filter(
    (c) => endpointMatches(c.from, unitId) || endpointMatches(c.to, unitId),
  )
}

/** A manifest endpoint like `t100.eic.fep.admit` belongs to unit `t100.eic.bar0.fep`? */
export function endpointMatches(endpoint, unitId) {
  if (!endpoint || !unitId) return false
  if (endpoint === unitId) return true
  // Manifest endpoints omit the bar segment; compare on chip.unit tails.
  const unitTail = unitId.split('.').filter((s) => s !== 'bar0' && s !== 'bar1').join('.')
  return endpoint === unitTail || endpoint.startsWith(`${unitTail}.`) || unitTail.startsWith(`${endpoint}.`)
}
