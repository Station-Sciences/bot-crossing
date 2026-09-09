/**
 * Three-way merge of a colony state.
 *
 * The colony file is written whole, by a page that read it once at boot. That is fine while
 * there is only one tab: the page holds the truth and the file is its shadow. With two tabs it
 * is two writers on one file, and the losing write is silent — the tab that saves last pastes
 * over everything the other did since it loaded. In practice that looks like a plot you moved
 * snapping back, or a thread you archived reappearing on its own.
 *
 * The server refuses a save whose base is stale and hands back what is on disk, so the page can
 * work out what it actually changed rather than asserting its whole picture. Hence three inputs:
 * `base` is the state as this tab last saw it agree with disk, `local` is what this tab holds
 * now, `remote` is what is on disk. The result keeps the other tab's work and replays this tab's
 * own edits on top.
 *
 * Pure and browser-free on purpose: this is the one piece worth being able to run under bare
 * node, since every way of getting it wrong is a way of losing somebody's archive list.
 */

/**
 * Structural equality, deep enough for the values that live in this file: `plots` holds arrays
 * of `[q, r]` integer pairs and `seen` holds numbers. Reference equality is no use — every one
 * of these values is rebuilt from scratch on each poll, so a cell list that never moved is still
 * a different array than the one in `base`, and comparing by identity would call every zone
 * "changed by this tab" and defeat the merge entirely.
 */
function sameValue(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]))
  }
  return false
}

const asArray = (v) => (Array.isArray(v) ? v : [])
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * A set-like list — `archived`, `opened`, `hiddenProjects` — merged as
 * `(remote ∪ (local \ base)) \ (base \ local)`.
 *
 * Both halves are needed, and it is tempting to write only the first. A plain union keeps every
 * addition and is trivially safe against loss, but it makes removal *impossible* between two
 * tabs: the id this tab dropped is still in the other tab's copy, so the union puts it straight
 * back. Subtracting what this tab deleted is what lets an un-archive survive a merge.
 *
 * Order follows `remote` with this tab's additions appended, so the file does not churn.
 */
function mergeSet(base, local, remote) {
  const baseSet = new Set(asArray(base))
  const localSet = new Set(asArray(local))
  // Deleted *here* — anything the base had and this tab no longer does.
  const removed = new Set([...baseSet].filter((id) => !localSet.has(id)))

  const out = []
  const seen = new Set()
  for (const id of asArray(remote)) {
    if (removed.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of localSet) {
    // Added *here* — not in the base, so it cannot be something the other tab deleted.
    if (baseSet.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * A keyed map — `archivedAt`, `plots`, `seen` — merged key by key.
 *
 * `remote` is the starting point, because everything in it is either untouched or the other
 * tab's work. This tab then replays its own diff against `base` on top: a key it added or
 * changed wins, a key it deleted goes. A key neither tab touched is left exactly as the other
 * tab left it, which is what stops a zone the other tab moved from snapping back.
 */
function mergeMap(base, local, remote) {
  const baseMap = asObject(base)
  const localMap = asObject(local)
  const out = { ...asObject(remote) }

  for (const [k, v] of Object.entries(localMap)) {
    if (k in baseMap && sameValue(baseMap[k], v)) continue // untouched here; leave theirs
    out[k] = v
  }
  for (const k of Object.keys(baseMap)) {
    if (k in localMap) continue
    delete out[k] // deleted here — the resurrection this whole file exists to prevent
  }
  return out
}

/**
 * Merge one colony state, field by field.
 *
 * `settings` is the deliberate exception: local wins, whole. It is a per-browser preference blob
 * — render scale, shadow quality, which planet — and two tabs are usually the same person on the
 * same machine expressing the same intent. Merging it field-wise would hand somebody a colony at
 * half quality on Mars at dusk because two tabs each contributed a third of a preset, which is a
 * worse outcome than the last tab to touch a slider winning.
 *
 * `updatedAt` is not merged at all: the server stamps it, and the value here would only ever be
 * a stale guess.
 *
 * Every field the state carries has to appear here. A field that is merely passed through by
 * `readState` but forgotten in this function is silently dropped on the first conflict — which
 * is exactly the bug this file exists to prevent, arriving through the back door.
 */
export function mergeState(base, local, remote) {
  const b = base || {}
  const l = local || {}
  const r = remote || {}
  return {
    version: r.version ?? l.version ?? 2,
    archived: mergeSet(b.archived, l.archived, r.archived),
    archivedAt: mergeMap(b.archivedAt, l.archivedAt, r.archivedAt),
    opened: mergeSet(b.opened, l.opened, r.opened),
    plots: mergeMap(b.plots, l.plots, r.plots),
    seen: mergeMap(b.seen, l.seen, r.seen),
    hiddenProjects: mergeSet(b.hiddenProjects, l.hiddenProjects, r.hiddenProjects),
    viewedAt: mergeMap(b.viewedAt, l.viewedAt, r.viewedAt),
    settings: l.settings && typeof l.settings === 'object' ? l.settings : r.settings ?? null,
    // Network config is this machine's own — sharing, its colony name, the neighbours it
    // visits. Like `settings`, local wins whole: two tabs are the same person on one machine,
    // and field-wise merging could leave sharing half-toggled between them.
    network: l.network && typeof l.network === 'object' ? l.network : r.network ?? null,
  }
}
