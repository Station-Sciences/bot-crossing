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
export function disambiguateProjects(threads) {
  // Windows hands the same checkout back as `c:\…` from one transcript and `C:\…` from
  // another: the CLI's project-directory encoding keeps whatever case the drive letter was
  // given. Those are one path, not two — and counted as two they make an unambiguous name look
  // ambiguous, which renames a plot on a machine that has no collision at all.
  //
  // Codex hands the same checkout back a third way: with the extended-length prefix, as
  // `\\?\C:\…`. That does not begin with a drive letter, so the case fold below never reached
  // it and one folder on disk arrived here as two paths — enough to make `geh` look ambiguous
  // against itself and rename both plots to their full absolute paths. Drop the prefix first,
  // but only where a drive follows it: `\\?\UNC\server\share` is a different animal, and
  // folding its first character would be wrong.
  const canonical = (p) => {
    const s = /^\\\\\?\\[A-Za-z]:[\\/]/.test(p) ? p.slice(4) : p
    return /^[A-Za-z]:[\\/]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
  }

  const pathsByName = new Map()
  for (const t of threads) {
    if (!t.project) continue
    if (!pathsByName.has(t.project)) pathsByName.set(t.project, new Set())
    pathsByName.get(t.project).add(canonical(t.projectPath || ''))
  }

  const renames = new Map()
  for (const [name, paths] of pathsByName) {
    if (paths.size < 2) continue
    const list = [...paths]
    // Both separators. A Windows path splits on neither otherwise, leaving a single "segment"
    // that is the whole absolute path — which then becomes the plot's name on the map.
    const segments = list.map((p) => p.split(/[\\/]/).filter(Boolean))
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
    const next = renames.get(`${t.project || ''}\u0000${canonical(t.projectPath || '')}`)
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
  // Ignored directories go first: a thread in one must not make a real project's name look
  // ambiguous and rename its plot on the way out.
  const threads = disambiguateProjects(dropIgnoredDirs(lists.flat(), ignoredDirs()))
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/**
 * Directories the user has said are not projects, whatever harness ran there:
 * `BOT_CROSSING_IGNORE_DIRS=/Users/me` — comma-separated, absolute, matched exactly.
 *
 * Scratch directories a harness makes are filtered by the harness that makes them, and the
 * home directory is deliberately not among them (see HARNESS_SCRATCH in claude-code.mjs): for
 * most people a session started in `~` is real work in a real place, and hiding real threads
 * is worse than a dull zone. On a machine where `~` is only ever where `claude login` gets
 * run, though, it draws a zone named after the user with "login" and two untitled threads in
 * it, reading as a repo that does not exist. The user knows which directories on their
 * machine are not projects; this lets them say so, the way BOT_CROSSING_DISABLE_HARNESSES
 * lets them say which harnesses are theirs.
 *
 * Exact match, on purpose: naming `~` must not take `~/some-repo` off the map with it.
 */
export function ignoredDirs(env = process.env) {
  return new Set(
    (env.BOT_CROSSING_IGNORE_DIRS || '')
      .split(',')
      .map(trimDir)
      .filter(Boolean)
  )
}

export function dropIgnoredDirs(threads, dirs) {
  if (!dirs?.size) return threads
  return threads.filter((t) => !dirs.has(trimDir(t.projectPath || '')))
}

/** One spelling per directory: no surrounding space, no trailing separator. */
const trimDir = (s) => String(s).trim().replace(/[\\/]+$/, '')

/** What the HUD shows in the harness list: who is installed, and what they can do. */
export async function harnessStatus() {
  const detected = new Set((await detectedHarnesses()).map((h) => h.id))
  return Promise.all(
    HARNESSES.map(async (h) => ({
      id: h.id,
      name: h.name,
      detected: detected.has(h.id),
      // Optional. An adapter that can see its harness but cannot read it — wrong Node, a store
      // it does not understand — says why here instead of failing silently on every poll.
      error: h.diagnostic ? await h.diagnostic().catch(() => '') : '',
    }))
  )
}

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

/** Both may be async: an adapter that has to look for a CLI on disk cannot answer synchronously. */
export const openThread = async (harnessId, ref) => dispatch(harnessId).openThread(ref)

export const newSession = async (harnessId, dir) => dispatch(harnessId).newSession(dir)
