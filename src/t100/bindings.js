/**
 * Bind a local harness thread to the T100 unit(s) it is working on.
 *
 * The plan is explicit that this must offer *candidates with reasons*, never one
 * guessed unit silently dropped onto the map. Signals, strongest first:
 *
 *   1. an explicit local assignment (drag/drop or a saved threadBinding);
 *   2. a working directory or changed file under a unit's source tree;
 *   3. a branch / PR / work-item linked through the reviewed join contract;
 *   4. repo/path ownership and canonical changed-file prefixes;
 *   5. prompt/title keyword matches — suggestions only, never auto-placement.
 *
 * Pure and framework-free: it reads a thread record and the world model and
 * returns ranked candidates, so the confirmation UI decides, not this function.
 */

const CONFIDENCE = { explicit: 1, path: 0.8, join: 0.75, ownership: 0.5, keyword: 0.3 }

const lower = (v) => String(v ?? '').toLowerCase()

/** Non-unit anchors are intentionally finite and local. They have no invented map geometry. */
export const WORK_TARGETS = Object.freeze([
  { id: 'work:chip_top', label: 'chip_top', keywords: ['chip top', 'chip_top', 'top-level'] },
  { id: 'work:gate_tests', label: 'gate_tests', keywords: ['gate test', 'gate_tests', 'milestone'] },
  { id: 'work:phoebe', label: 'phoebe', keywords: ['phoebe'] },
])

export function bindingTargets(world) {
  return [
    ...(world.units || []).map((u) => ({
      id: u.id,
      label: u.unit || u.id,
      detail: u.diagram || u.desc || '',
      kind: 'unit',
      placed: Boolean(u.placement?.bound),
    })),
    ...WORK_TARGETS.map((t) => ({ ...t, detail: 'general workstream', kind: 'workstream', placed: false })),
  ]
}

/** Every string field on a thread we are willing to scan for a unit reference. */
function threadText(thread) {
  const bits = [thread.title, thread.summary, thread.worktree, thread.cwd, thread.repo]
  for (const f of thread.changedFiles || thread.files || []) bits.push(f)
  return bits.filter(Boolean).map(String)
}

/** Does any thread path sit under a source tree that clearly belongs to a unit? */
function pathSignal(thread, unit) {
  const paths = [thread.worktree, thread.cwd, ...(thread.changedFiles || thread.files || [])].filter(Boolean).map(lower)
  if (!paths.length) return null
  const needles = [`/src/${unit.unit}/`, `/fmod/src/${unit.unit}/`, `/${unit.unit}/`]
  for (const p of paths) {
    for (const n of needles) {
      if (p.includes(n)) return `working files under ${n.replaceAll('/', '')}`
    }
  }
  return null
}

/** Keyword match on unit short name or diagram name in the thread's text. */
function keywordSignal(thread, unit) {
  const text = threadText(thread).map(lower).join(' \u0001 ')
  const name = lower(unit.unit)
  // Word-boundary-ish match to avoid 'rot' matching 'rotate'.
  if (name && new RegExp(`(^|[^a-z0-9])${escapeRe(name)}([^a-z0-9]|$)`).test(text)) {
    return `mentions "${unit.unit}"`
  }
  const diagram = lower(unit.diagram)
  if (diagram && diagram.length > 3 && text.includes(diagram)) return `mentions "${unit.diagram}"`
  return null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {object} thread   harness thread record
 * @param {object} world    t100.world/v1
 * @param {object} opts
 *   explicit: unitId the user pinned for this thread (or null)
 *   join: { threadKey|branch|pr -> unitId } reviewed identity map (optional)
 */
export function resolveThreadBinding(thread, world, opts = {}) {
  const units = world.units || []
  const targets = bindingTargets(world)
  const byId = new Map(targets.map((target) => [target.id, target]))
  const candidates = []
  const add = (unitId, source, reason, confidence) => {
    if (!byId.has(unitId)) return
    candidates.push({ unitId, source, reason, confidence })
  }

  // 1. Explicit.
  if (opts.explicit && byId.has(opts.explicit)) {
    add(opts.explicit, 'explicit', 'assigned by you', CONFIDENCE.explicit)
  }

  // 3. Join contract (branch / pr / thread id).
  const join = opts.join || {}
  for (const key of [thread.id, thread.branch, thread.gitBranch, thread.pr, thread.prNumber].filter(Boolean)) {
    const target = join[String(key)]
    if (target && byId.has(target)) add(target, 'join', `linked via join (${key})`, CONFIDENCE.join)
  }

  // 2, 4, 5: per-unit signals.
  for (const unit of units) {
    const path = pathSignal(thread, unit)
    if (path) add(unit.id, 'path', path, CONFIDENCE.path)
    const kw = keywordSignal(thread, unit)
    if (kw) add(unit.id, 'keyword', kw, CONFIDENCE.keyword)
  }

  // General anchors can be suggested from a title, but — like unit keywords —
  // never become the automatic primary.
  const text = threadText(thread).map(lower).join(' \u0001 ')
  for (const target of WORK_TARGETS) {
    const word = target.keywords.find((keyword) => text.includes(keyword))
    if (word) add(target.id, 'keyword', `mentions "${word}"`, CONFIDENCE.keyword)
  }

  // Dedupe by unit, keeping the strongest reason, and sort.
  const best = new Map()
  for (const c of candidates) {
    const prev = best.get(c.unitId)
    if (!prev || c.confidence > prev.confidence) best.set(c.unitId, c)
  }
  const ranked = [...best.values()].sort((a, b) => b.confidence - a.confidence)

  return {
    candidates: ranked,
    // A primary is only auto-suggested when a strong non-keyword signal exists;
    // a keyword alone stays a suggestion the user must confirm.
    primary: ranked.find((c) => c.confidence >= CONFIDENCE.ownership) || null,
  }
}
