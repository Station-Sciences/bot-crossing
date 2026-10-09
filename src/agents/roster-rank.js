/**
 * Who survives a display cap: the ones that want you, then the ones doing something — and your
 * own crew before anybody's neighbours, whatever they are doing. A friend's busy afternoon must
 * never push your one waiting thread off the map.
 *
 * Its own module so the rule runs under node; astronauts.js cannot load there.
 */
const ROSTER_RANK = { blocked: 0, waiting: 1, working: 2, celebrating: 3, idle: 4, sleeping: 5 }
const NEIGHBOR_PENALTY = 10

export const rosterRank = (entry) => (entry.neighbor ? NEIGHBOR_PENALTY : 0) + (ROSTER_RANK[entry.status] ?? 6)
