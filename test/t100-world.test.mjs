import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWorld,
  resolveRequires,
  indexLayout,
  indexManifest,
  normalizeLinkPerformance,
  WORLD_SCHEMA,
} from '../server/t100/world.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'server', 't100', 'fixtures')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))

const bridge = readJson('bridge.json')
const layout = readJson('instances.json')
const overlay = readJson('status-overlay.json')

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const freshProvenance = {
  scorer: { path: 'x', observedAt: NOW - 1000 },
  layout: { path: 'y', observedAt: NOW - 1000 },
  overlay: { path: 'z', observedAt: NOW - 1000 },
}

function world(overrides = {}) {
  return buildWorld({
    bridge,
    layout,
    overlay,
    provenance: freshProvenance,
    now: NOW,
    ...overrides,
  })
}

test('world: assembles the v1 schema with expected counts from the real snapshot', () => {
  const w = world()
  assert.equal(w.schemaVersion, WORLD_SCHEMA)
  assert.equal(w.chip.name, 't100')
  assert.ok(w.chip.sizeUm.width > 0 && w.chip.sizeUm.height > 0)
  assert.ok(w.units.length >= 46, `expected the full roster, got ${w.units.length}`)
  assert.equal(w.rungs.length, 28)
  assert.equal(w.counts.leaves, 659)
})

test('world: progress is not gate closure — both survive independently', () => {
  const w = world()
  // unit_reset reads high progress off the units that have plans, but its gate is
  // nowhere near met (35 units demanded, none proven under an empty run).
  const reset = w.rungs.find((r) => r.id === 'unit_reset')
  assert.ok(reset)
  assert.equal(reset.gate.met, false)
  assert.equal(reset.gate.kind, 'per_unit')
  assert.ok(reset.gate.need > 0)
  // A rung can be 100% progress with an open gate; assert we never collapse them.
  for (const r of w.rungs) {
    if (r.progress.pct === 1) {
      assert.equal(typeof r.gate.met, 'boolean')
    }
  }
})

test('world: topology guard is surfaced on gates that declare a target', () => {
  const w = world()
  for (const r of w.rungs) {
    assert.equal(typeof r.gate.targetTopology, 'string')
  }
  // At least the fidelity axis is carried through, weakest-first.
  assert.deepEqual(w.fidelity.all, ['fmod', 'rtl', 'fpga', 'silicon'])
  assert.equal(w.fidelity.gate, 'fmod')
})

test('world: missing test evidence is unknown, never zero or failed', () => {
  const w = world()
  // chip_ctrl has no plan in the snapshot: its tests facet must be unknown.
  const chipCtrl = w.units.find((u) => u.unit === 'chip_ctrl')
  assert.ok(chipCtrl)
  assert.equal(chipCtrl.facets.tests.state, 'unknown')
  assert.equal(chipCtrl.facets.tests.evidenceClass, 'unknown')
  assert.equal(chipCtrl.tests.evidenceClass, 'unknown')
  // No unit is marked passing when there was no measured ctest run.
  assert.equal(w.diagnostics.junitPresent, false)
  for (const u of w.units) {
    assert.notEqual(u.facets.tests.state, 'passing')
  }
})

test('world: repeated instances collapse to one unit id but keep every instance', () => {
  const w = world()
  const hbm = w.units.filter((u) => u.unit === 'hbm')
  assert.equal(hbm.length, 1, 'six HBM stacks are one logical unit')
  assert.equal(hbm[0].id, 't100.eic.bar0.hbm')
  assert.equal(hbm[0].instances.length, 6, 'but all six instances are retained')
})

test('world: retired units are recorded, never phantomed into live cards', () => {
  const w = world()
  assert.ok(w.retiredUnits.some((r) => r.unit === 'ms_dma'))
  assert.ok(!w.units.some((u) => u.unit === 'ms_dma'), 'a retired unit gets no live card')
})

test('world: unbound logical units land in the unplaced tray with a reason', () => {
  const w = world()
  // Only VPU, NoC HS, DFE are bound in the prototype floorplan.
  const vpu = w.units.find((u) => u.id === 't100.eic.bar0.vpu')
  assert.ok(vpu.placement.bound, 'VPU is bound')
  assert.ok(vpu.placement.leafCount > 0)
  const xpu = w.units.find((u) => u.unit === 'xpu')
  assert.ok(xpu, 'xpu exists as a logical unit')
  assert.equal(xpu.placement.bound, false)
  assert.ok(w.unplaced.some((u) => u.unit === 'xpu'), 'xpu is unplaced')
  assert.match(xpu.placement.unboundReason, /floorplan/i)
})

test('world: only the three bound units carry physical leaves', () => {
  const w = world()
  const bound = w.units.filter((u) => u.placement.bound).map((u) => u.id).sort()
  assert.deepEqual(bound, ['t100.eic.bar0.dfe', 't100.eic.bar0.noc_hs', 't100.eic.bar0.vpu'])
})

test('world: an old observed feed is stale, and does not zero out what it described', () => {
  const w = buildWorld({
    bridge,
    layout,
    overlay,
    provenance: {
      scorer: { path: 'x', kind: 'computed', computedAt: NOW - 1000 },
      layout: { path: 'y', kind: 'authored', observedAt: NOW - 3 * DAY },
      overlay: { path: 'z', kind: 'observed', observedAt: NOW - 3 * DAY },
    },
    now: NOW,
  })
  const vpu = w.units.find((u) => u.id === 't100.eic.bar0.vpu')
  assert.equal(vpu.freshness.overlay.stale, true)
  // Stale does not blank the placement — the last-known bind is still shown.
  assert.equal(vpu.placement.bound, true)
  assert.ok(w.attention.some((a) => a.kind === 'stale' && a.subject === 'overlay'))
})

test('world: age is not staleness for an authored spec or a computed score', () => {
  // A floorplan nobody has edited for a week is stable, and the scorer just ran.
  // Reading either as "stale" is a false alarm, and the old per-unit version
  // raised it once per unit, burying every real finding.
  const w = buildWorld({
    bridge,
    layout,
    overlay,
    provenance: {
      scorer: { path: 'x', kind: 'computed', computedAt: NOW - 1000 },
      layout: { path: 'y', kind: 'authored', observedAt: NOW - 7 * DAY },
      manifest: { path: 'm', kind: 'authored', observedAt: NOW - 7 * DAY },
      overlay: { path: 'z', kind: 'observed', observedAt: NOW - 1000 },
    },
    now: NOW,
  })
  assert.equal(w.units.every((u) => u.freshness.stale === false), true)
  assert.deepEqual(w.attention.filter((a) => a.kind === 'stale'), [])
})

test('world: a data-quality flag is raised once per feed, not once per unit', () => {
  const w = buildWorld({
    bridge,
    layout,
    overlay,
    provenance: {
      scorer: { path: 'x', kind: 'computed', computedAt: NOW - 1000 },
      layout: { path: 'y', kind: 'authored', observedAt: NOW - 1000 },
      overlay: { path: 'z', kind: 'observed', observedAt: NOW - 9 * DAY },
    },
    now: NOW,
  })
  const stale = w.attention.filter((a) => a.kind === 'stale')
  assert.equal(stale.length, 1, 'one row for the one stale feed')
  assert.ok(w.units.length > 1, 'and that is with many units reading it')
})

test('world: serving a bundled snapshot is disclosed in the attention queue', () => {
  const w = buildWorld({
    bridge,
    layout,
    overlay,
    provenance: {
      scorer: { path: 'x', kind: 'computed', computedAt: NOW - 1000 },
      layout: { path: 'y', kind: 'authored', source: 'fixture', observedAt: NOW - 1000 },
      overlay: { path: 'z', kind: 'observed', observedAt: NOW - 1000 },
    },
    now: NOW,
  })
  assert.ok(w.attention.some((a) => a.kind === 'fixture' && a.subject === 'layout'))
})

test('world: attention queue ranks gate mismatch above missing owner', () => {
  const w = world()
  const severities = w.attention.map((a) => a.severity)
  assert.deepEqual(severities, [...severities].sort((a, b) => b - a), 'sorted by severity')
  // Every attention item carries an evidence class so heuristics never look measured.
  for (const a of w.attention) {
    assert.ok(['measured', 'derived', 'declared', 'heuristic', 'unknown'].includes(a.evidenceClass))
  }
})

test('world: explicitly joined team work decorates targets but never changes scores', () => {
  const baseline = world()
  const item = {
    source: 'github',
    id: 'neurophos/models#42',
    title: 'VPU reset',
    state: 'open',
    targets: ['t100.eic.bar0.vpu', 'unit_reset'],
  }
  const w = world({
    teamEvidence: {
      items: [item],
      conflicts: [{ id: 'github:neurophos/models#42', targets: item.targets, reason: 'review mapping' }],
      provenance: { github: { enabled: true } },
    },
  })
  assert.equal(w.units.find((u) => u.id === 't100.eic.bar0.vpu').work[0].id, item.id)
  assert.equal(w.rungs.find((r) => r.id === 'unit_reset').work[0].id, item.id)
  assert.equal(w.counts.rungsMet, baseline.counts.rungsMet)
  assert.ok(w.attention.some((a) => a.kind === 'identity-conflict'))
})

test('resolveRequires: chip rungs inherit their parents transitively', () => {
  const map = resolveRequires([
    { id: 'a', level: 'superunit', requires: { adds: ['x', 'y'] } },
    { id: 'b', level: 'chip', requires: { inherits: ['a'], adds: ['z'] } },
    { id: 'u', level: 'unit', units: ['q'] },
  ])
  assert.deepEqual(map.get('a'), ['x', 'y'])
  assert.deepEqual(map.get('b'), ['x', 'y', 'z'])
  assert.deepEqual(map.get('u'), ['q'])
})

test('resolveRequires: a cycle fails soft instead of looping forever', () => {
  const map = resolveRequires([
    { id: 'a', level: 'chip', requires: { inherits: ['b'] } },
    { id: 'b', level: 'chip', requires: { inherits: ['a'] } },
  ])
  assert.ok(map.has('a') && map.has('b'))
})

test('indexManifest: canonicalises units to bind ids and keeps connections', () => {
  const idx = indexManifest(bridge.manifest)
  assert.ok(idx.units.has('t100.eic.bar0.vpu'))
  assert.ok(idx.connections.length > 0)
  const c = idx.connections[0]
  assert.ok('from' in c && 'to' in c)
})

test('indexLayout: groups leaves by bind path with area-weighted centroids', () => {
  const idx = indexLayout(layout)
  const vpu = idx.byPath.get('t100.eic.bar0.vpu')
  assert.ok(vpu)
  assert.ok(vpu.leafCount > 0)
  assert.ok(vpu.centroidUm && Number.isFinite(vpu.centroidUm.x))
  assert.ok(idx.unboundReasons.length > 0, 'unbound tiles explain themselves')
})

test('indexLayout: validates identity, counts, and explicit unplacement', () => {
  const indexed = indexLayout({
    instances: [
      { id: 'a', children: [], rect_um: { x: 0, y: 0, w: 1, h: 1 }, bind: { path: 't100.eic.bar0.vpu' } },
      { id: 'b', children: [], rect_um: { x: 1, y: 0, w: 1, h: 1 }, bind: null, unbound_reason: 'prototype tile' },
    ],
    logical_binding: { leaf_count: 2, bound_leaf_count: 1, unbound_leaf_count: 1 },
  })
  assert.equal(indexed.validation.valid, true)
  const bad = indexLayout({
    instances: [
      { id: 'same', children: [], rect_um: { w: -1, h: 1 }, bind: null },
      { id: 'same', children: [], rect_um: { w: 1, h: 1 }, bind: { path: 'not-canonical' } },
    ],
    logical_binding: { leaf_count: 9, bound_leaf_count: 9 },
  })
  assert.equal(bad.validation.valid, false)
  assert.ok(bad.validation.errors.some((error) => error.includes('duplicate instance id')))
  assert.ok(bad.validation.errors.some((error) => error.includes('unbound leaf has no reason')))
})

test('world: enriches manifest edges from typed interface and unit contracts', () => {
  const enrichedBridge = structuredClone(bridge)
  enrichedBridge.interfaces = {
    eu: {
      name: 'eu',
      kind: 'parallel',
      status: 'proposed',
      owner: 'owner',
      path: 'ssot/interfaces/eu_interface.toml',
      channel: { cmd: { signal: [{ name: 'valid' }, { name: 'ready' }] } },
      ssot_gap: [{ id: 'G1', blocking: true, desc: 'choose payload' }],
    },
  }
  enrichedBridge.unit_specs = {
    dfe: { interface: [{ name: 'eu_xpu', type: 'eu', role: 'initiator' }] },
    xpu: { interface: [{ name: 'eu', type: 'eu', role: 'target' }] },
  }
  const w = world({ bridge: enrichedBridge })
  const edge = w.connections.find((connection) => connection.from.endsWith('.dfe.eu_xpu'))
  assert.equal(edge.type, 'eu')
  assert.equal(edge.interfaceSpec.signals, 2)
  assert.equal(edge.interfaceSpec.gaps[0].blocking, true)
  assert.equal(edge.endpoints.from.role, 'initiator')
  assert.equal(edge.endpoints.to.role, 'target')
  assert.equal(edge.endpoints.directionValid, true)
})

test('link performance: derives comparable peak bandwidth without inventing unknowns', () => {
  const derived = normalizeLinkPerformance({
    status: 'bounded',
    traffic_class: 'bulk',
    bytes_per_cycle: 192,
    clock_hz: 2_000_000_000,
    multiplicity: 64,
    latency: { cycles_min: 5, cycles_max: 10 },
  })
  assert.equal(derived.peakBytesPerSecond, 24_576_000_000_000)
  assert.equal(derived.trafficClass, 'bulk')
  assert.equal(derived.latency.cyclesMin, 5)
  assert.match(derived.derivation, /192 B\/cycle/)

  const unknown = normalizeLinkPerformance({ status: 'unknown' })
  assert.equal(unknown.peakBytesPerSecond, null)
  assert.equal(unknown.latency.typicalNs, null)
})

test('world: tolerates a v3-style status with no fidelities key', () => {
  const v3Bridge = {
    ...bridge,
    status: { ...bridge.status, fidelities: undefined, gate_fidelity: 'fmod' },
  }
  const w = buildWorld({ bridge: v3Bridge, layout, overlay, provenance: freshProvenance, now: NOW })
  assert.deepEqual(w.fidelity.all, ['fmod'])
  assert.equal(w.fidelity.gate, 'fmod')
})

test('world: an empty/failed scorer degrades to unknown, not to failure', () => {
  const brokenBridge = { ...bridge, status: { error: 'scorer produced no readable json', units: {}, milestones: {} } }
  const w = buildWorld({ bridge: brokenBridge, layout, overlay, provenance: freshProvenance, now: NOW })
  assert.equal(w.rungs.length, 0)
  assert.ok(w.diagnostics.scorerError.length > 0)
  // Units still come from the roster/manifest; none is marked failed.
  assert.ok(w.units.length > 0)
  for (const u of w.units) assert.notEqual(u.facets.tests.state, 'passing')
})
