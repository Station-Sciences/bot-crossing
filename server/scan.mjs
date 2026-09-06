/**
 * Harness-agnostic thread scanning.
 *
 * This module knows nothing about any particular agent harness: it asks every harness that
 * is present on this machine for its threads, stamps each one with which harness it came
 * from, and hands back a single list sorted by recency. Everything harness-specific lives
 * in `server/harnesses/` — see the README there.
 */
import { HARNESSES, detectedHarnesses, harnessById } from './harnesses/index.mjs'

/**
 * A project's ground is keyed on its name, and a name is the last segment of its path — so two
 * checkouts of the same repo, `~/workspaces/1/foo` and `~/workspaces/2/foo`, are both "foo".
 * Left alone they share one plot and their threads become indistinguishable, which is wrong for
 * anyone keeping parallel copies instead of using worktrees.
 *
 * Where a name is ambiguous, grow it leftward along the path until it is not: `1/foo` and
 * `2/foo`. Only names that actually collide are touched, and that restraint is the point — the
 * name is also the key a saved layout is stored under, so disambiguating unconditionally would
 * move every plot on everybody's map to fix something most people never hit.
 */
function disambiguateProjects(threads) {
  const pathsByName = new Map()
  for (const t of threads) {
    if (!t.project) continue
    if (!pathsByName.has(t.project)) pathsByName.set(t.project, new Set())
    pathsByName.get(t.project).add(t.projectPath || '')
  }

  const renames = new Map()
  for (const [name, paths] of pathsByName) {
    if (paths.size < 2) continue
    const list = [...paths]
    const segments = list.map((p) => p.split('/').filter(Boolean))
    const deepest = Math.max(...segments.map((s) => s.length))

    // Take one more trailing segment until every path in the group reads differently. Paths
    // that differ at all must separate by `deepest`, so this always terminates. A thread with
    // no path at all cannot be told apart by one, so it keeps the bare name and the others
    // move around it.
    const labelAt = (segs, depth) => (segs.length ? segs.slice(-depth).join('/') : name)
    let depth = 1
    let labels = segments.map((segs) => labelAt(segs, depth))
    while (new Set(labels).size < list.length && depth < deepest) {
      depth += 1
      labels = segments.map((segs) => labelAt(segs, depth))
    }
    list.forEach((path, i) => renames.set(`${name}\u0000${path}`, labels[i]))
  }

  if (!renames.size) return threads
  return threads.map((t) => {
    const next = renames.get(`${t.project || ''}\u0000${t.projectPath || ''}`)
    return next && next !== t.project ? { ...t, project: next } : t
  })
}

/**
 * Every thread from every detected harness.
 *
 * A harness that throws is skipped rather than allowed to take the scan down with it: one
 * broken adapter should cost you that harness's threads, not the whole colony.
 */
export async function scanThreads() {
  const harnesses = await detectedHarnesses()
  const lists = await Promise.all(
    harnesses.map(async (h) => {
      try {
        const threads = await h.scanThreads()
        return threads.map((t) => ({ ...t, harness: h.id, harnessName: h.name }))
      } catch (err) {
        console.warn(`bot-crossing: harness "${h.id}" failed to scan —`, err?.message || err)
        return []
      }
    })
  )
  const threads = disambiguateProjects(lists.flat())
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/** What the HUD shows in the harness list: who is installed, and what they can do. */
export async function harnessStatus() {
  const detected = new Set((await detectedHarnesses()).map((h) => h.id))
  return Promise.all(HARNESSES.map(async (h) => ({
    id: h.id, name: h.name, detected: detected.has(h.id),
    error: h.diagnostic ? await h.diagnostic() : '',
  })))
}

/** Database-backed adapters confirm archiving on the next read, without an app restart. */
export const harnessArchiveSync = (id) => harnessById(id)?.archiveSync || 'restart'

/** The harness to use when a caller has not said — the first one present on this machine. */
export async function defaultHarness() {
  const [first] = await detectedHarnesses()
  return first?.id || ''
}

const dispatch = (harnessId) => {
  const h = harnessById(harnessId)
  if (!h) throw new Error(`Unknown harness "${harnessId}"`)
  return h
}

export const openThread = (harnessId, ref) => dispatch(harnessId).openThread(ref)

export const newSession = (harnessId, dir) => dispatch(harnessId).newSession(dir)

export const setThreadArchived = (harnessId, ref, archived) => dispatch(harnessId).setArchived(ref, archived)

/**
 * When a harness's own app last started, used to tell an archive it has already read from
 * one still waiting on disk. A harness with no long-lived app has nothing to report.
 */
export async function harnessAppStartedAt(harnessId) {
  const h = harnessById(harnessId)
  if (!h?.appStartedAt) return 0
  try {
    return await h.appStartedAt()
  } catch {
    return 0
  }
}
