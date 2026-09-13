import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SelectionStore, ViewRegistry } from '../src/t100/view-registry.js'
import { bindingTargets, resolveThreadBinding } from '../src/t100/bindings.js'
import { normalizeLayout } from '../src/t100/contracts.js'
import { floorplanLodForDistance, physicalLodItems } from '../src/t100/physical-lod.js'
import {
  unitPhase,
  unitPhaseColor,
  partitionUnits,
  connectionsForUnit,
  endpointMatches,
  indexUnits,
} from '../src/t100/world.js'

// ── SelectionStore ─────────────────────────────────────────────────────────────
test('SelectionStore: selecting a unit notifies subscribers once', () => {
  const store = new SelectionStore()
  const seen = []
  store.subscribe((s) => seen.push(s.unitId))
  store.selectUnit('t100.eic.bar0.vpu')
  store.selectUnit('t100.eic.bar0.vpu') // idempotent — no second emit
  store.selectUnit('t100.eic.bar0.dfe')
  assert.deepEqual(seen, ['t100.eic.bar0.vpu', 't100.eic.bar0.dfe'])
})

test('SelectionStore: source is carried so a view can ignore its own echo', () => {
  const store = new SelectionStore()
  let last = null
  store.subscribe((s) => (last = s))
  store.selectUnit('u1', { source: 't100' })
  assert.equal(last.source, 't100')
  store.clear('t100')
  assert.equal(last.unitId, null)
})

test('SelectionStore: layer changes emit and persist', () => {
  const store = new SelectionStore()
  let last = null
  store.subscribe((s) => (last = s))
  store.setLayer('physical')
  assert.equal(last.layer, 'physical')
})

// ── ViewRegistry ───────────────────────────────────────────────────────────────
test('ViewRegistry: activates one view and deactivates the previous', () => {
  const reg = new ViewRegistry()
  const log = []
  reg.register({ id: 'colony', label: 'Colony', activate: () => log.push('colony:on'), deactivate: () => log.push('colony:off') })
  reg.register({ id: 't100', label: 'T100', activate: () => log.push('t100:on'), deactivate: () => log.push('t100:off') })
  assert.equal(reg.active().id, 'colony')
  reg.setActive('t100')
  assert.deepEqual(log, ['colony:off', 't100:on'])
  assert.equal(reg.active().id, 't100')
})

test('ViewRegistry: setActive on the current or unknown view is a no-op', () => {
  const reg = new ViewRegistry()
  reg.register({ id: 'a', label: 'A' })
  reg.setActive('a')
  reg.setActive('nope')
  assert.equal(reg.active().id, 'a')
})

// ── client world helpers ─────────────────────────────────────────────────────────
const unit = (over = {}) => ({
  id: 't100.eic.bar0.x',
  unit: 'x',
  owner: 'greg',
  placement: { bound: false, unboundReason: 'no tile' },
  facets: {
    spec: { state: 'implemented', evidenceClass: 'declared' },
    interfaces: { state: 'declared', evidenceClass: 'declared' },
    registers: { state: 'unknown', evidenceClass: 'unknown' },
    workshop: { state: 'implemented', evidenceClass: 'declared' },
    tests: { state: 'planned', evidenceClass: 'declared' },
    telemetry: { state: 'unknown', evidenceClass: 'unknown' },
  },
  tests: { planned: 10, passing: 0, failed: [] },
  overlay: null,
  ...over,
})

test('unitPhase: failing tests dominate everything', () => {
  assert.equal(unitPhase(unit({ tests: { planned: 3, failed: ['x.a.b'] } })), 'failed')
})

test('unitPhase: blocked runtime overrides structural progress', () => {
  assert.equal(unitPhase(unit({ overlay: { state: 'blocked', blockedOn: 'y' } })), 'blocked')
})

test('unitPhase: passing tests earn green, structural progress does not', () => {
  const passing = unit({ facets: { ...unit().facets, tests: { state: 'passing', evidenceClass: 'measured' } } })
  assert.equal(unitPhase(passing), 'passing')
  // Structure alone (no tests) never reads as passing.
  assert.notEqual(unitPhase(unit()), 'passing')
})

test('unitPhase: an unknown unit is unknown, not zero', () => {
  const bare = { facets: {}, tests: { planned: null }, placement: { bound: false } }
  assert.equal(unitPhase(bare), 'unknown')
  assert.equal(typeof unitPhaseColor(bare), 'number')
})

test('partitionUnits: splits bound districts from the unplaced tray', () => {
  const world = {
    units: [
      unit({ id: 'a', placement: { bound: true, leafCount: 3 } }),
      unit({ id: 'b', placement: { bound: false, unboundReason: 'x' } }),
    ],
  }
  const { placed, tray } = partitionUnits(world)
  assert.equal(placed.length, 1)
  assert.equal(tray.length, 1)
  assert.equal(placed[0].id, 'a')
})

test('endpointMatches: bar-less manifest endpoints resolve to bound unit ids', () => {
  assert.ok(endpointMatches('t100.eic.fep.admit', 't100.eic.bar0.fep'))
  assert.ok(endpointMatches('t100.eic.bar0.vpu', 't100.eic.bar0.vpu'))
  assert.ok(!endpointMatches('t100.eic.dfe', 't100.eic.bar0.vpu'))
})

test('connectionsForUnit: returns only edges touching the unit', () => {
  const world = {
    connections: [
      { from: 't100.eic.fep.admit', to: 't100.eic.dfe.cfg', label: 'a' },
      { from: 'host.pcie', to: 't100.eic.pcie_ep.host', label: 'b' },
    ],
  }
  const forFep = connectionsForUnit(world, 't100.eic.bar0.fep')
  assert.equal(forFep.length, 1)
  assert.equal(forFep[0].label, 'a')
})

test('indexUnits: builds an id lookup', () => {
  const world = { units: [unit({ id: 'a' }), unit({ id: 'b' })] }
  const idx = indexUnits(world)
  assert.equal(idx.get('a').id, 'a')
})

// ── local thread bindings ────────────────────────────────────────────────────
const bindingWorld = {
  units: [
    unit({ id: 't100.eic.bar0.vpu', unit: 'vpu', diagram: 'Vector Processing Unit' }),
    unit({ id: 't100.eic.bar0.dfe', unit: 'dfe', diagram: 'Data Flow Engine' }),
  ],
}

test('thread binding: an explicit assignment is primary', () => {
  const result = resolveThreadBinding(
    { id: 'cursor:1', title: 'anything' },
    bindingWorld,
    { explicit: 't100.eic.bar0.dfe' },
  )
  assert.equal(result.primary.unitId, 't100.eic.bar0.dfe')
  assert.equal(result.primary.source, 'explicit')
})

test('thread binding: a unit source path may auto-suggest', () => {
  const result = resolveThreadBinding(
    { id: 'cursor:1', cwd: '/work/models/src/vpu/tests' },
    bindingWorld,
  )
  assert.equal(result.primary.unitId, 't100.eic.bar0.vpu')
  assert.equal(result.primary.source, 'path')
})

test('thread binding: a keyword alone requires confirmation', () => {
  const result = resolveThreadBinding(
    { id: 'cursor:1', title: 'Investigate VPU throughput' },
    bindingWorld,
  )
  assert.equal(result.primary, null)
  assert.equal(result.candidates[0].unitId, 't100.eic.bar0.vpu')
})

test('thread binding: gitBranch participates in the reviewed join', () => {
  const result = resolveThreadBinding(
    { id: 'cursor:1', gitBranch: 'feature/vpu-reset' },
    bindingWorld,
    { join: { 'feature/vpu-reset': 't100.eic.bar0.vpu' } },
  )
  assert.equal(result.primary.source, 'join')
})

test('binding targets include finite general workstream anchors', () => {
  const ids = bindingTargets(bindingWorld).map((target) => target.id)
  assert.ok(ids.includes('work:chip_top'))
  assert.ok(ids.includes('work:gate_tests'))
  assert.ok(ids.includes('work:phoebe'))
})

test('physical layout keeps typed ports and endpoint coordinates', () => {
  const layout = normalizeLayout({
    chip_size_um: { w: 100, h: 100 },
    instances: [{
      id: 'tile',
      children: [],
      rect_um: { x: 0, y: 0, w: 10, h: 10 },
      ports: [{ name: 'out', interface: 'foo', direction: 'out', x_um: 10, y_um: 5 }],
    }],
    connections: [{
      id: 'wire',
      interface: 'foo',
      from: { instance: 'tile', port: 'out', x_um: 10, y_um: 5 },
      to: { instance: 'other', port: 'in', x_um: 20, y_um: 5 },
    }],
  })
  assert.equal(layout.instances[0].ports[0].direction, 'out')
  assert.equal(layout.connections[0].interface, 'foo')
  assert.equal(layout.connections[0].fromEndpoint.xUm, 10)
})

const hierarchyLayout = () => normalizeLayout({
  chip_size_um: { w: 1000, h: 800 },
  instances: [
    {
      id: 't100',
      kind: 'hstack',
      parent: null,
      children: ['t100.array', 't100.dfe'],
      rect_um: { x: 0, y: 0, w: 1000, h: 800 },
      display: { expand_at_lod: 0 },
    },
    {
      id: 't100.array',
      tile: 'vpu_array',
      kind: 'hstack',
      parent: 't100',
      children: ['t100.array.tile'],
      rect_um: { x: 100, y: 100, w: 800, h: 600 },
      display: {
        label: 'VPU / TM array',
        expand_at_lod: 1,
        logical_units: ['t100.eic.bar0.vpu', 't100.eic.bar0.sram'],
        primary_logical_unit: 't100.eic.bar0.vpu',
      },
    },
    {
      id: 't100.array.tile',
      tile: 'vpu_tile12',
      kind: 'vstack',
      parent: 't100.array',
      children: ['t100.array.tile.vpu'],
      rect_um: { x: 100, y: 100, w: 200, h: 600 },
      display: { label: 'VPU / TM ×12', expand_at_lod: 2 },
    },
    {
      id: 't100.array.tile.vpu',
      tile: 'vpu_sram',
      kind: 'leaf',
      parent: 't100.array.tile',
      children: [],
      rect_um: { x: 100, y: 100, w: 20, h: 100 },
      bind: { path: 't100.eic.bar0.vpu' },
      display: { label: 'VPU + TM' },
    },
    {
      id: 't100.dfe',
      tile: 'dataflow_engine',
      kind: 'leaf',
      parent: 't100',
      children: [],
      rect_um: { x: 920, y: 300, w: 60, h: 200 },
      bind: { path: 't100.eic.bar0.dfe' },
      display: { label: 'DFE' },
    },
  ],
})

test('physical LOD reveals only authored children and preserves exact SSoT rectangles', () => {
  const layout = hierarchyLayout()
  assert.deepEqual(
    physicalLodItems(layout, 0).map((item) => item.instance.id),
    ['t100.array', 't100.dfe'],
  )
  assert.deepEqual(
    physicalLodItems(layout, 1).map((item) => item.instance.id),
    ['t100.array.tile', 't100.dfe'],
  )
  assert.deepEqual(
    physicalLodItems(layout, 2).map((item) => item.instance.id),
    ['t100.array.tile.vpu', 't100.dfe'],
  )
  assert.deepEqual(physicalLodItems(layout, 0)[0].rectUm, {
    x: 100,
    y: 100,
    width: 800,
    height: 600,
  })
})

test('physical super-units carry their authored logical membership and primary selection', () => {
  const array = physicalLodItems(hierarchyLayout(), 0)[0]
  assert.equal(array.label, 'VPU / TM array')
  assert.deepEqual(array.logicalUnitIds, ['t100.eic.bar0.vpu', 't100.eic.bar0.sram'])
  assert.equal(array.primaryUnitId, 't100.eic.bar0.vpu')
  assert.equal(array.aggregate, true)
})

test('camera distance maps monotonically onto all authored floorplan LODs', () => {
  assert.deepEqual(
    [80, 48, 34, 24, 16, 10, 6, 4].map(floorplanLodForDistance),
    [0, 1, 2, 3, 4, 5, 6, 6],
  )
})
