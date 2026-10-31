// server/share-snapshot.mjs
/**
 * What a friend sees of this colony: its shape and what its bots are doing, nothing more.
 *
 * Built field by field from a fixed list rather than by deleting the private ones. A field added
 * to the Thread shape next year is private until somebody adds it *here*, on purpose — a
 * denylist would publish it the day it landed. See DECISIONS.md.
 */
import crypto from 'node:crypto'
import { withErrands } from '../src/game/errands.js'
import { liveThreadsForColony } from '../src/game/hidden-projects.js'
import { allSleeping } from '../src/game/status.js'
import { battleLive, cleanBattle } from '../src/game/war.js'

export const SHARE_VERSION = 1

/** A pull request's state is one short word; anything else is not passed on. */
const WORD = /^[A-Za-z]{1,12}$/
const MAX_CELLS = 64

/**
 * Unlinkable to the real session id, stable for as long as the key is — so a friend's map does
 * not reshuffle every poll — and different the moment the key rotates.
 */
export function sharedId(key, id) {
  return 'n:' + crypto.createHash('sha256').update(`${key}:${id}`).digest('hex').slice(0, 16)
}

/** Building size travels as a power of two, which is all a log-scale skyline needs. */
export function sizeBucket(bytes) {
  const b = Number(bytes) || 0
  if (b < 1) return 0
  return Math.min(40, Math.max(0, Math.floor(Math.log2(b))))
}

const toMinute = (t) => Math.floor((Number(t) || 0) / 60000) * 60000

/**
 * Project name → the name a friend sees. Two repos with one name come back from the scan as
 * `1/foo` and `2/foo`, or as a whole path when nothing shorter tells them apart; only the last
 * folder name leaves the machine, and a clash is numbered in a fixed order instead.
 */
function sharedProjectNames(names) {
  const out = new Map()
  const used = new Set()
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const last = String(name).split(/[\\/]/).filter(Boolean).pop() || ''
    const base = /^[A-Za-z]:$/.test(last) || !last ? 'unknown' : last // a bare drive is still a path
    let label = base
    for (let i = 2; used.has(label); i++) label = `${base} (${i})`
    used.add(label)
    out.set(name, label)
  }
  return out
}

export function toShared(thread, key, project = thread.project) {
  return {
    id: sharedId(key, thread.id),
    project: String(project || 'unknown'),
    harness: String(thread.harness || ''),
    harnessName: String(thread.harnessName || ''),
    running: thread.running === true,
    unread: thread.unread === true,
    hasError: thread.hasError === true,
    prState: WORD.test(String(thread.prState || '')) ? String(thread.prState) : '',
    lastActivityAt: toMinute(thread.lastActivityAt),
    createdAt: toMinute(thread.createdAt),
    sizeBucket: sizeBucket(thread.sizeBytes),
    isErrand: Boolean(thread.parentId),
  }
}

/** A saved zone footprint, with anything that is not a pair of whole numbers dropped. */
function cleanCells(cells) {
  if (!Array.isArray(cells)) return []
  return cells
    .filter((c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]))
    .slice(0, MAX_CELLS)
    .map(([q, r]) => [q, r])
}

/**
 * The snapshot. Mirrors what the sharer's own map draws — errands expanded, viewed threads not
 * waving, archived threads and hidden repos gone, dormant repos folded away unless the sharer
 * turned that off — so a friend sees what the sharer sees, minus the words.
 */
export function buildSnapshot({ threads, state, now = Date.now(), name = '' }) {
  const key = state.sharing?.key || ''
  const viewed = state.viewedAt || {}
  const expanded = withErrands(threads).map((t) => {
    const at = viewed[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
  const live = liveThreadsForColony(expanded, new Set(state.archived || []), new Set(state.hiddenProjects || []))

  const byProject = new Map()
  for (const t of live) {
    const k = t.project || 'unknown'
    if (!byProject.has(k)) byProject.set(k, [])
    byProject.get(k).push(t)
  }
  // Same rule as Colony.setThreads, including never folding away everything.
  if (state.settings?.hideDormant !== false) {
    const dormant = [...byProject].filter(([, list]) => allSleeping(list, now)).map(([n]) => n)
    if (dormant.length < byProject.size) for (const n of dormant) byProject.delete(n)
  }

  const plots = state.plots || {}
  const names = [...byProject.keys()].sort((a, b) => a.localeCompare(b))
  const shared = sharedProjectNames(names)
  return {
    v: SHARE_VERSION,
    name: String(state.sharing?.name || name || 'Neighbor').slice(0, 40),
    generatedAt: now,
    // Layouts are saved under the full name, so they are looked up by it before it is shortened.
    projects: names.map((n) => ({ name: shared.get(n), cells: cleanCells(plots[n]) })),
    // Whether a friend may pick a fight with us, and what we are fighting now. Who we are fighting is
    // left out on purpose: the target is only a tag, so other friends cannot read a name from it.
    warReady: state.war?.enabled === true,
    battle: battleLive(state.war?.battle, now) ? cleanBattle(state.war.battle) : null,
    // A battle someone else started on us is in *their* snapshot, not ours, so without this a third
    // friend would see us free and attack while we are defending. A bare yes: it says nothing of who.
    warBusy: Number.isFinite(state.war?.busyUntil) && now < state.war.busyUntil,
    threads: names.flatMap((n) => byProject.get(n).map((t) => toShared(t, key, shared.get(n)))),
  }
}
