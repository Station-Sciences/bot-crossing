/**
 * The T100 world read model — `t100.world/v1`.
 *
 * One canonical, revision-pinned projection of "where does T100 stand", assembled
 * from sources that each own a different truth:
 *
 *   - the chip manifest (t100.yaml) and unit roster (units.yaml) — what logical
 *     units exist, who owns them, what they terminate;
 *   - the capability ladder (milestones.yaml) scored by the canonical Python
 *     scorer — planned/passing progress AND gate closure, kept apart on purpose;
 *   - the SSoT floorplan (instances.json) — which logical units have a physical
 *     home, and the honest gap for the ones that do not;
 *   - the runtime status overlay and weekly ledger — derived readiness.
 *
 * Every function here is pure: it takes already-loaded JSON and returns plain
 * data, so the whole contract is testable under `node --test` with no repos, no
 * Python, and no network. The impure loading/caching lives in sources.mjs.
 *
 * Two invariants this file exists to protect:
 *   1. progress is not gate closure. A unit can be 100% on its planned tests
 *      while the chip gate it feeds stays open; both numbers survive to the UI.
 *   2. missing evidence is `unknown`, never zero and never failed. A unit nobody
 *      has measured is a different state from one whose tests fail.
 */

export const WORLD_SCHEMA = 't100.world/v1'

const DAY_MS = 24 * 60 * 60 * 1000

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v : [])
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const str = (v) => (v == null ? '' : String(v))
const positive = (v) => {
  const value = Number(v)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Coarse human duration for attention text ("3h ago", "8d ago"). */
const ago = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return 'at an unknown time'
  const s = Math.round(ms / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Construction states a facet building can be in, weakest first. */
export const FACET_STATES = Object.freeze([
  'unknown',
  'absent',
  'declared',
  'implemented',
  'planned',
  'passing',
])

/** Evidence classes, from strongest (a measured run) to weakest (a guess). */
export const EVIDENCE_CLASSES = Object.freeze(['measured', 'derived', 'declared', 'heuristic', 'unknown'])

/**
 * Resolve each chip/super-unit rung to every unit it demands, replicating the
 * scorer's `resolve_requires`: a rung names only what it newly adds and inherits
 * the rest. Unit rungs keep their advisory `units:` list verbatim.
 */
export function resolveRequires(rawMilestones) {
  const raw = arr(rawMilestones)
  const byId = new Map(raw.filter((m) => m && m.id).map((m) => [m.id, m]))
  const memo = new Map()

  const walk = (id, seen) => {
    if (memo.has(id)) return memo.get(id)
    if (seen.has(id)) return new Set() // a cycle: fail soft rather than loop forever
    const m = byId.get(id)
    if (!m) return new Set()
    const req = obj(m.requires)
    const acc = new Set(arr(req.adds).map(str))
    for (const parent of arr(req.inherits)) {
      for (const u of walk(str(parent), new Set([...seen, id]))) acc.add(u)
    }
    memo.set(id, acc)
    return acc
  }

  const out = new Map()
  for (const m of raw) {
    if (!m || !m.id) continue
    const level = str(m.level || 'unit')
    if (level === 'chip' || level === 'superunit') {
      out.set(m.id, [...walk(m.id, new Set())].sort())
    } else {
      out.set(m.id, arr(m.units).map(str))
    }
  }
  return out
}

/**
 * Index the floorplan by logical binding: for each `bind.path`, the leaves that
 * carry it, their count, and an area-weighted centroid. Unbound leaves are
 * tallied by their `unbound_reason` so the UI can explain the gap rather than
 * guess a rectangle.
 */
export function indexLayout(rawLayout) {
  const layout = obj(rawLayout)
  const instances = arr(layout.instances)
  const leaves = instances.filter((i) => arr(obj(i).children).length === 0)
  const byPath = new Map()
  const unboundReasons = new Map()
  const errors = []
  const seenIds = new Set()

  for (const instance of instances) {
    const id = str(obj(instance).id)
    if (!id) errors.push('instance without id')
    else if (seenIds.has(id)) errors.push(`duplicate instance id: ${id}`)
    seenIds.add(id)
    const rect = obj(obj(instance).rect_um)
    if (num(rect.w ?? rect.width) < 0 || num(rect.h ?? rect.height) < 0) {
      errors.push(`negative rectangle size: ${id || 'unknown instance'}`)
    }
  }

  for (const leaf of leaves) {
    const bind = obj(leaf).bind
    const path = bind && bind.path ? str(bind.path) : ''
    if (!path) {
      const reason = str(obj(leaf).unbound_reason || '')
      if (reason) unboundReasons.set(reason, (unboundReasons.get(reason) || 0) + 1)
      else errors.push(`unbound leaf has no reason: ${str(obj(leaf).id)}`)
      continue
    }
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+){2,}$/i.test(path)) {
      errors.push(`non-canonical bind path: ${path}`)
    }
    const rect = obj(leaf.rect_um)
    const w = num(rect.w ?? rect.width)
    const h = num(rect.h ?? rect.height)
    const x = num(rect.x)
    const y = num(rect.y)
    const area = Math.max(1, w * h)
    const group = byPath.get(path) || { path, physicalIds: [], leafCount: 0, _wx: 0, _wy: 0, _w: 0 }
    group.physicalIds.push(str(leaf.id))
    group.leafCount += 1
    group._wx += (x + w / 2) * area
    group._wy += (y + h / 2) * area
    group._w += area
    byPath.set(path, group)
  }

  for (const g of byPath.values()) {
    g.centroidUm = g._w ? { x: g._wx / g._w, y: g._wy / g._w } : null
    delete g._wx
    delete g._wy
    delete g._w
  }

  const binding = obj(layout.logical_binding)
  const declaredLeaves = num(binding.leaf_count, leaves.length)
  const declaredBound = num(binding.bound_leaf_count, [...byPath.values()].reduce((n, group) => n + group.leafCount, 0))
  const actualBound = [...byPath.values()].reduce((n, group) => n + group.leafCount, 0)
  if (declaredLeaves !== leaves.length) errors.push(`leaf count mismatch: declared ${declaredLeaves}, actual ${leaves.length}`)
  if (declaredBound !== actualBound) errors.push(`bound leaf count mismatch: declared ${declaredBound}, actual ${actualBound}`)
  const sourceDiagnostics = arr(layout.diagnostics)
  return {
    byPath,
    chipSizeUm: {
      width: num(obj(layout.chip_size_um).w ?? obj(layout.chip_size_um).width),
      height: num(obj(layout.chip_size_um).h ?? obj(layout.chip_size_um).height),
    },
    leafCount: num(binding.leaf_count, leaves.length),
    boundLeafCount: num(binding.bound_leaf_count),
    unboundLeafCount: num(binding.unbound_leaf_count),
    manifestValidated: Boolean(binding.manifest_validated),
    accuracy: str(obj(layout.provenance).accuracy || ''),
    unboundReasons: [...unboundReasons.entries()].map(([reason, count]) => ({ reason, count })),
    validation: {
      valid: errors.length === 0,
      errors,
      warnings: sourceDiagnostics
        .filter((entry) => str(obj(entry).severity) === 'warning')
        .map((entry) => ({ code: str(obj(entry).code), message: str(obj(entry).message) })),
    },
  }
}

/** Every logical unit the manifest instantiates, canonicalised to its bind id. */
export function indexManifest(rawManifest) {
  const manifest = obj(rawManifest)
  const chipSet = str(manifest.name || 't100')
  const units = new Map() // canonicalId -> record

  for (const [chipName, chip] of Object.entries(obj(manifest.chips))) {
    for (const entry of arr(obj(chip).units)) {
      const e = obj(entry)
      const unit = str(e.unit)
      if (!unit) continue
      const bar = str(e.bar || '')
      const id = [chipSet, chipName, bar, unit].filter(Boolean).join('.')
      const record = units.get(id) || {
        id,
        unit,
        chip: chipName,
        bar,
        diagram: str(e.diagram || ''),
        intf: str(e.intf || ''),
        instances: [],
      }
      record.instances.push({
        instance: str(e.instance || ''),
        diagram: str(e.diagram || ''),
        base: e.base ?? null,
      })
      if (!record.diagram && e.diagram) record.diagram = str(e.diagram)
      if (!record.intf && e.intf) record.intf = str(e.intf)
      units.set(id, record)
    }
  }

  return {
    chipSet,
    units,
    connections: arr(manifest.connections).map((c, i) => {
      const v = obj(c)
      return {
        id: str(v.id || `conn-${i}`),
        from: str(v.from),
        to: str(v.to),
        interface: str(v.interface || ''),
        label: str(v.label || ''),
        performance: obj(v.performance),
      }
    }),
  }
}

/**
 * Turn source inputs into one comparable peak rate without manufacturing
 * precision. A source may state an aggregate B/s value, or state the physical
 * ingredients needed to derive one. Unknown/disputed links remain unscaled.
 */
export function normalizeLinkPerformance(raw = {}) {
  const value = obj(raw)
  const stated = positive(value.peak_bytes_per_second)
  const bytesPerCycle = positive(value.bytes_per_cycle)
  const clockHz = positive(value.clock_hz)
  const multiplicity = positive(value.multiplicity) || 1
  const derived = bytesPerCycle && clockHz ? bytesPerCycle * clockHz * multiplicity : null
  const peakBytesPerSecond = stated || derived
  const latency = obj(value.latency)
  return {
    status: str(value.status || (peakBytesPerSecond ? 'specified' : 'unknown')),
    trafficClass: str(value.traffic_class || 'unknown'),
    peakBytesPerSecond,
    derivation: stated
      ? 'stated aggregate'
      : derived
        ? `${bytesPerCycle} B/cycle × ${clockHz} Hz × ${multiplicity}`
        : '',
    bytesPerCycle,
    clockHz,
    multiplicity,
    scope: str(value.scope || ''),
    direction: str(value.direction || ''),
    latency: {
      status: str(latency.status || 'unknown'),
      minNs: positive(latency.min_ns),
      typicalNs: positive(latency.typical_ns),
      maxNs: positive(latency.max_ns),
      cyclesMin: positive(latency.cycles_min),
      cyclesMax: positive(latency.cycles_max),
      profile: str(latency.profile || ''),
    },
    source: str(value.source || ''),
    note: str(value.note || ''),
  }
}

/** Derive one facet's construction state and evidence class from what is known. */
function facet(state, evidenceClass, detail) {
  return { state, evidenceClass, detail: detail || '' }
}

/**
 * Facets for one unit. Deliberately conservative: a facet is `unknown` unless a
 * source actually speaks to it. Tests are `passing` only when a real ctest run
 * was measured; a plan with no run is `planned` (declared), never green.
 */
function deriveFacets({ rosterMeta, manifestUnit, unitSpec, testStat, overlay, junitPresent }) {
  const flavors = arr(rosterMeta.flavors).map(str)
  const has = (f) => flavors.includes(f)

  // Spec / library.
  const spec = has('spec')
    ? facet('implemented', 'declared', 'spec flavor present')
    : rosterMeta.known
      ? facet('absent', 'declared', 'no spec flavor in units.yaml')
      : facet('unknown', 'unknown', '')

  // Interfaces.
  const interfacePorts = arr(obj(unitSpec).interface)
  const interfaces = manifestUnit?.intf || interfacePorts.length
    ? facet('declared', 'declared', manifestUnit?.intf || `${interfacePorts.length} typed unit ports`)
    : facet('unknown', 'unknown', 'no interface contract on record')

  // Registers — no register SSoT is wired into this model yet.
  const registers = facet('unknown', 'unknown', 'register parity not sampled')

  // Workshop / implementation flavors.
  const workshop = has('rtl')
    ? facet('implemented', 'declared', 'rtl flavor present')
    : has('fmod') || has('pmod')
      ? facet('implemented', 'declared', 'model flavor present')
      : rosterMeta.known
        ? facet('declared', 'declared', 'no implementation flavor yet')
        : facet('unknown', 'unknown', '')

  // Tests.
  let tests
  if (!testStat || testStat.planned == null) {
    tests = facet('unknown', 'unknown', 'no test plan')
  } else if (num(testStat.planned) === 0) {
    tests = facet('declared', 'declared', 'empty plan')
  } else if (junitPresent && num(testStat.passing) > 0) {
    tests = facet('passing', 'measured', `${testStat.passing}/${testStat.planned} planned tests pass`)
  } else if (num(testStat.written) > 0) {
    tests = facet('implemented', junitPresent ? 'measured' : 'declared', `${testStat.written}/${testStat.planned} planned tests written`)
  } else {
    tests = facet('planned', 'declared', `${testStat.planned} planned, none written`)
  }

  // Telemetry — from the runtime overlay if it saw this unit.
  const telemetry = overlay
    ? facet('implemented', 'derived', `runtime overlay: ${overlay.state || 'observed'}`)
    : facet('unknown', 'unknown', 'no runtime telemetry on record')

  return { spec, interfaces, registers, workshop, tests, telemetry }
}

/** Normalize one runtime-overlay component entry into a small readiness view. */
function normalizeOverlayComponent(entry) {
  const e = obj(entry)
  const readiness = obj(e.readiness)
  const state = str(readiness.runtime_state || readiness.state || e.runtime_state || e.state || '').toLowerCase()
  return {
    state: state || 'observed',
    diagram: str(e.diagram || ''),
    reason: str(readiness.reason || e.reason || ''),
    blockedOn: str(readiness.blocked_on || e.blocked_on || ''),
    aliases: arr(e.aliases).map((a) => str(obj(a).id)).filter(Boolean),
  }
}

/**
 * Build the whole world.
 *
 * @param {object} input
 *   bridge: { manifest, roster, ladder, status }  (status is the scorer JSON)
 *   layout: raw instances.json
 *   overlay: raw status-overlay.json (optional)
 *   evidence: { weekly: [...], artifacts: [...] } (optional)
 *   teamEvidence: normalized, explicitly joined GitHub/Jira items (optional)
 *   provenance: { <source>: { path, revision, sha, observedAt } }
 *   now: ms (defaults to Date.now)
 *   staleMs: freshness threshold (default 24h)
 */
export function buildWorld(input = {}) {
  const now = num(input.now, Date.now())
  const staleMs = num(input.staleMs, DAY_MS)
  const bridge = obj(input.bridge)
  const status = obj(bridge.status)
  const provenance = obj(input.provenance)
  const teamEvidence = obj(input.teamEvidence)

  const junitPresent = status._junit_present === true
  const manifestIndex = indexManifest(bridge.manifest)
  const layoutIndex = indexLayout(input.layout)
  const rungUnits = resolveRequires(obj(bridge.ladder).milestones)

  const rosterUnits = obj(obj(bridge.roster).units)
  const retired = obj(obj(bridge.roster).retired)
  const statusUnits = obj(status.units)
  const statusMilestones = obj(status.milestones)
  const interfaceSpecs = obj(bridge.interfaces)
  const unitSpecs = obj(bridge.unit_specs)

  // Runtime overlay, keyed by canonical id and by alias.
  const overlayComponents = obj(obj(input.overlay).components)
  const overlayByPath = new Map()
  for (const [id, entry] of Object.entries(overlayComponents)) {
    const c = normalizeOverlayComponent(entry)
    overlayByPath.set(id, c)
    for (const alias of c.aliases) if (!overlayByPath.has(alias)) overlayByPath.set(alias, c)
  }

  // Age is only a freshness signal for feeds that are *observed*. An authored SSoT
  // file's mtime says when a human last edited the spec — a floorplan untouched for
  // a week is stable, not stale — and a computed score is as fresh as the run that
  // produced it. Treating all three alike flagged every unit as stale off one
  // seven-day-old spec file, which is the wrong alarm, raised 46 times.
  const staleFor = (source) => {
    const p = obj(provenance[source])
    const kind = str(p.kind || 'observed')
    const computedAt = num(p.computedAt, 0)
    const observedAt = computedAt || num(p.observedAt, 0)
    const stale =
      kind === 'computed' || kind === 'authored'
        ? false
        : observedAt > 0
          ? now - observedAt > staleMs
          : true
    return { observedAt, kind, source: str(p.source || ''), stale }
  }
  const scorerFresh = staleFor('scorer')
  const layoutFresh = staleFor('layout')
  const overlayFresh = staleFor('overlay')

  // ── Units ───────────────────────────────────────────────────────────────
  // Base set: every roster unit (the authoritative "what exists"), joined to the
  // manifest for placement identity and diagram names. A roster unit the manifest
  // never instantiates still gets a card, marked logical-only.
  const units = []
  const canonicalByUnit = new Map() // unit short name -> canonical id(s)

  const manifestByUnit = new Map()
  for (const rec of manifestIndex.units.values()) {
    const list = manifestByUnit.get(rec.unit) || []
    list.push(rec)
    manifestByUnit.set(rec.unit, list)
  }

  const buildUnitRecord = (unitShort, manifestUnit) => {
    const rosterMetaRaw = obj(rosterUnits[unitShort])
    const rosterMeta = {
      known: unitShort in rosterUnits,
      owner: str(rosterMetaRaw.owner || ''),
      desc: str(rosterMetaRaw.desc || ''),
      home: str(rosterMetaRaw.home || ''),
      flavors: arr(rosterMetaRaw.flavors),
      chips: arr(rosterMetaRaw.chips),
    }
    const canonicalId = manifestUnit ? manifestUnit.id : `${manifestIndex.chipSet}.${unitShort}`
    canonicalByUnit.set(unitShort, [...(canonicalByUnit.get(unitShort) || []), canonicalId])

    const testStatRaw = obj(statusUnits[unitShort])
    const testStat = unitShort in statusUnits
      ? {
          planned: testStatRaw.planned,
          written: testStatRaw.written,
          passing: testStatRaw.passing,
          completion: testStatRaw.completion,
          total: num(testStatRaw.total),
          passed: arr(testStatRaw.passed),
          failed: arr(testStatRaw.failed),
          notrun: arr(testStatRaw.notrun),
          missing: arr(testStatRaw.missing),
          unplanned: arr(testStatRaw.unplanned),
        }
      : null

    // Placement from the floorplan: bound only through an exact bind.path match.
    const placementGroup = layoutIndex.byPath.get(canonicalId) || null
    const placement = placementGroup
      ? {
          bound: true,
          physicalIds: placementGroup.physicalIds,
          leafCount: placementGroup.leafCount,
          centroidUm: placementGroup.centroidUm,
          unboundReason: '',
        }
      : {
          bound: false,
          physicalIds: [],
          leafCount: 0,
          centroidUm: null,
          unboundReason: 'no physical tile bound in the floorplan SSoT (illustrative-not-silicon)',
        }

    const overlay = overlayByPath.get(canonicalId) || null
    const unitSpec = obj(unitSpecs[unitShort])
    const interfacePorts = arr(unitSpec.interface).map((port) => ({
      name: str(obj(port).name),
      type: str(obj(port).type),
      role: str(obj(port).role),
      external: obj(port).external === true,
      clock: str(obj(port).clock),
      reset: str(obj(port).reset),
      desc: str(obj(port).desc),
    }))
    const facets = deriveFacets({ rosterMeta, manifestUnit, unitSpec, testStat, overlay, junitPresent })

    // Rungs this unit is demanded by.
    const rungs = []
    for (const [rungId, demanded] of rungUnits) {
      if (demanded.includes('all') || demanded.includes(unitShort)) rungs.push(rungId)
    }

    return {
      id: canonicalId,
      unit: unitShort,
      chip: manifestUnit ? manifestUnit.chip : '',
      bar: manifestUnit ? manifestUnit.bar : '',
      diagram: manifestUnit ? manifestUnit.diagram : '',
      owner: rosterMeta.owner,
      desc: rosterMeta.desc,
      flavors: rosterMeta.flavors,
      retired: false,
      logicalOnly: !manifestUnit,
      instances: manifestUnit ? manifestUnit.instances : [],
      interfacePorts,
      placement,
      facets,
      tests: testStat
        ? {
            planned: testStat.planned,
            written: testStat.written,
            passing: testStat.passing,
            completion: testStat.completion,
            total: testStat.total,
            failed: testStat.failed,
            missing: testStat.missing,
            evidenceClass:
              testStat.planned == null
                ? 'unknown'
                : junitPresent && testStat.planned
                  ? 'measured'
                  : 'declared',
          }
        : { planned: null, evidenceClass: 'unknown' },
      rungs,
      overlay,
      work: [], // filled by the team-evidence overlay
      freshness: {
        scorer: scorerFresh,
        layout: layoutFresh,
        overlay: overlay ? overlayFresh : null,
        // A unit is stale when the runtime feed describing it has gone quiet. The
        // authored spec behind it having sat unchanged is not staleness.
        stale: overlay ? overlayFresh.stale : false,
      },
    }
  }

  const seen = new Set()
  for (const unitShort of Object.keys(rosterUnits)) {
    const manifestRecs = manifestByUnit.get(unitShort)
    if (manifestRecs && manifestRecs.length) {
      for (const rec of manifestRecs) {
        units.push(buildUnitRecord(unitShort, rec))
      }
    } else {
      units.push(buildUnitRecord(unitShort, null))
    }
    seen.add(unitShort)
  }
  // Manifest units with no roster entry (rare, but keep them visible).
  for (const [unitShort, recs] of manifestByUnit) {
    if (seen.has(unitShort)) continue
    for (const rec of recs) units.push(buildUnitRecord(unitShort, rec))
  }

  // Retired units: recorded, but never phantomed into live cards.
  const retiredUnits = Object.entries(retired).map(([name, meta]) => ({
    unit: name,
    successor: str(obj(meta).successor || ''),
    date: str(obj(meta).date || ''),
    note: str(obj(meta).note || obj(meta).reason || ''),
  }))

  // ── Rungs ───────────────────────────────────────────────────────────────
  const rungs = Object.entries(statusMilestones).map(([id, m]) => {
    const gate = obj(obj(m).gate)
    const planned = num(obj(m).planned)
    const passing = num(obj(m).passing)
    return {
      id,
      label: str(obj(m).label),
      wave: str(obj(m).wave),
      level: str(obj(m).level || 'unit'),
      units: rungUnits.get(id) || [],
      progress: {
        planned,
        passing,
        pct: planned ? passing / planned : null,
      },
      gate: {
        kind: str(gate.kind || ''),
        have: num(gate.have),
        need: num(gate.need),
        met: gate.met === true,
        written: num(gate.written),
        scored: gate.scored !== false,
        fidelity: str(gate.fidelity || status.gate_fidelity || 'fmod'),
        informational: num(gate.informational),
        targetTopology: str(gate.target_topology || ''),
      },
      evidenceClass: junitPresent ? 'measured' : 'declared',
      work: [],
    }
  })

  // Durable team work is decoration on canonical identities, never a scoring
  // input. One item may intentionally appear on several targets; that ambiguity
  // remains visible in diagnostics instead of choosing a silent winner.
  const workItems = arr(teamEvidence.items)
  const unitById = new Map(units.map((unit) => [unit.id, unit]))
  const rungById = new Map(rungs.map((rung) => [rung.id, rung]))
  for (const item of workItems) {
    for (const target of arr(item.targets)) {
      unitById.get(target)?.work.push(item)
      rungById.get(target)?.work.push(item)
    }
  }

  const interfaceName = (source) => {
    const leaf = str(source).split('/').pop() || ''
    return leaf.replace(/_interface\.toml$/, '').replace(/\.toml$/, '')
  }
  const endpointPort = (endpoint) => {
    const parts = str(endpoint).split('.')
    return { unit: parts.at(-2) || '', port: parts.at(-1) || '' }
  }
  const roleFor = (endpoint) => {
    const ref = endpointPort(endpoint)
    const spec = obj(unitSpecs[ref.unit])
    const port = arr(spec.interface).find((entry) => str(obj(entry).name) === ref.port)
    return port ? str(obj(port).role) : ''
  }
  const countSignals = (spec) =>
    Object.values(obj(spec.channel)).reduce(
      (sum, channel) => sum + arr(obj(channel).signal).length,
      0,
    )
  const typedConnections = manifestIndex.connections.map((connection) => {
    const type = interfaceName(connection.interface)
    const spec = obj(interfaceSpecs[type])
    const fromRole = roleFor(connection.from)
    const toRole = roleFor(connection.to)
    return {
      ...connection,
      type,
      performance: normalizeLinkPerformance(connection.performance),
      interfaceSpec: Object.keys(spec).length
        ? {
            name: str(spec.name || type),
            kind: str(spec.kind),
            status: str(spec.status),
            owner: str(spec.owner),
            path: str(spec.path || connection.interface),
            channels: Object.keys(obj(spec.channel)).length,
            signals: countSignals(spec),
            gaps: arr(spec.ssot_gap).map((gap) => ({
              id: str(obj(gap).id),
              blocking: obj(gap).blocking === true,
              desc: str(obj(gap).desc),
            })),
          }
        : null,
      endpoints: {
        from: { ...endpointPort(connection.from), role: fromRole },
        to: { ...endpointPort(connection.to), role: toRole },
        directionValid: fromRole && toRole ? fromRole !== toRole : null,
      },
      provenance: { source: 'manifest', path: connection.interface },
    }
  })

  // ── Unplaced tray ─────────────────────────────────────────────────────────
  const unplaced = units
    .filter((u) => !u.placement.bound && !u.retired)
    .map((u) => ({ id: u.id, unit: u.unit, diagram: u.diagram, reason: u.placement.unboundReason }))

  // ── Attention queue ────────────────────────────────────────────────────────
  const attention = buildAttention({
    units,
    rungs,
    junitPresent,
    freshness: { scorer: scorerFresh, layout: layoutFresh, overlay: overlayFresh },
    conflicts: arr(teamEvidence.conflicts),
    now,
  })

  // ── Fidelity axis (v3/v4 skew tolerant) ────────────────────────────────────
  const fidelities = arr(status.fidelities)
  const fidelity = {
    gate: str(status.gate_fidelity || 'fmod'),
    all: fidelities.length ? fidelities.map(str) : ['fmod'],
  }

  return {
    schemaVersion: WORLD_SCHEMA,
    generatedAt: now,
    chip: { name: manifestIndex.chipSet, sizeUm: layoutIndex.chipSizeUm },
    fidelity,
    counts: {
      units: units.length,
      rungs: rungs.length,
      rungsMet: rungs.filter((r) => r.gate.met).length,
      unplaced: unplaced.length,
      leaves: layoutIndex.leafCount,
      boundLeaves: layoutIndex.boundLeafCount,
    },
    placement: {
      accuracy: layoutIndex.accuracy,
      manifestValidated: layoutIndex.manifestValidated,
      unboundReasons: layoutIndex.unboundReasons,
      validation: layoutIndex.validation,
    },
    units,
    rungs,
    connections: typedConnections,
    team: {
      items: workItems,
      conflicts: arr(teamEvidence.conflicts),
      provenance: obj(teamEvidence.provenance),
    },
    unplaced,
    retiredUnits,
    attention,
    diagnostics: {
      junitPresent,
      scorerReturncode: num(status._scorer_returncode, 0),
      ladderDrift: arr(status.ladder_drift),
      undemandedUnits: arr(status.undemanded_units),
      planProblems: arr(status.plan_problems),
      violations: arr(status.violations),
      workJoinConflicts: arr(teamEvidence.conflicts),
      scorerError: str(status.error || ''),
    },
    provenance,
  }
}

/**
 * Rank the evidence-backed conditions worth a human's attention. Each item names
 * its reason, the unit or rung it is about, and the evidence class behind it, so
 * a heuristic nudge never masquerades as a measured failure.
 */
export function buildAttention({ units, rungs, junitPresent, freshness, conflicts = [], now = Date.now() }) {
  const items = []
  const push = (severity, kind, subject, reason, evidenceClass) =>
    items.push({ severity, kind, subject, reason, evidenceClass })

  for (const u of units) {
    // Failed tests — only meaningful when a run actually measured them.
    if (junitPresent && arr(u.tests.failed).length) {
      push(90, 'test-failed', u.id, `${u.tests.failed.length} failing test(s)`, 'measured')
    }
    // Blocked at runtime.
    if (u.overlay && (u.overlay.state === 'blocked' || u.overlay.blockedOn)) {
      push(70, 'blocked', u.id, u.overlay.blockedOn ? `blocked on ${u.overlay.blockedOn}` : 'runtime blocked', 'derived')
    }
    // Missing owner on a live (non-logical-only) unit.
    if (!u.owner && !u.logicalOnly) {
      push(40, 'no-owner', u.id, 'no owner in units.yaml', 'declared')
    }
  }

  // Data-quality problems belong to the feed, not to each unit that reads it: one
  // row per source, named by source, instead of one per unit.
  for (const [source, f] of Object.entries(obj(freshness))) {
    if (!f) continue
    if (f.source === 'fixture') {
      push(30, 'fixture', source, `${source} is served from a bundled snapshot, not this repo`, 'declared')
    } else if (f.stale) {
      push(20, 'stale', source, `${source} feed last observed ${ago(now - f.observedAt)}`, 'unknown')
    }
  }

  // Unit-complete / chip-gate-open mismatch: a rung whose contributing units are
  // fully passing while its own gate stays open (the XPU-shaped trap).
  for (const r of rungs) {
    if (r.progress.pct === 1 && !r.gate.met && r.gate.kind) {
      push(80, 'gate-mismatch', r.id, `progress 100% but gate ${r.gate.have}/${r.gate.need} at fidelity ${r.gate.fidelity}`, r.evidenceClass)
    }
  }

  for (const conflict of conflicts) {
    push(60, 'identity-conflict', conflict.id, conflict.reason, 'declared')
  }

  return items.sort((a, b) => b.severity - a.severity)
}
