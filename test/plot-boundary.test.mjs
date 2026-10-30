import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as THREE from 'three'
import { Navigation } from '../src/agents/navigation.js'
import { worldToHex, PLOT_CELL } from '../src/world/plots.js'

// The crew module reads Vite's `import.meta.env`, which plain node does not have.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function load(url, context, next) {
  const out = await next(url, context)
  if (out.format === 'module' && url.includes('/src/') && out.source) {
    out.source = String(out.source).replaceAll('import.meta.env', '({ BASE_URL: "/" })')
  }
  return out
}`),
  import.meta.url,
)
const { Astronauts } = await import('../src/agents/astronauts.js')

// One hex zone centred on the origin; its edge along z sits at PLOT_CELL * sqrt(3) / 2.
const EDGE = (PLOT_CELL * Math.sqrt(3)) / 2
const onZone = (x, z) => {
  const c = worldToHex(x, z)
  return c.q === 0 && c.r === 0
}

function crew({ onPlot = onZone } = {}) {
  const nav = new Navigation()
  nav.rebuild([])
  const c = Object.create(Astronauts.prototype)
  Object.assign(c, {
    nav,
    _v: new THREE.Vector3(),
    _wp: new THREE.Vector3(),
    _crowded: () => false,
    _walk() {},
    _settle() {},
    _faceToward() {},
    _check() {},
    _nearDoor: () => false,
    _steerTarget: (agent, out) => out.copy(agent.site),
    _watchWobble() {},
    _sitePose() {},
    _animate() {},
  })
  const agent = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    site: new THREE.Vector3(),
    anchor: new THREE.Vector3(),
    wander: new THREE.Vector3(),
    workSpot: new THREE.Vector3(),
    wanderAt: 0,
    workAt: 0,
    checkStart: -1,
    onPlot,
    status: 'idle',
    state: 'at-site',
    stateAge: 0,
    stuckFor: 0,
    pathVersion: 0,
    groundSpeed: 0,
  }
  return { c, agent }
}

test('the test hex really has an edge where the comment says', () => {
  assert.ok(onZone(0, EDGE - 0.1))
  assert.ok(!onZone(0, EDGE + 0.1))
})

test('idle pottering never picks a point off the plot, even for a spot at the edge', () => {
  const { c, agent } = crew()
  agent.site.set(0, 0, EDGE - 0.4)
  agent.pos.copy(agent.site)
  let moved = 0
  for (let i = 0; i < 400; i++) {
    agent.wanderAt = 0
    c._drift(agent, 0.016, 100)
    assert.ok(onZone(agent.wander.x, agent.wander.z), `drift ${i} chose ${agent.wander.x}, ${agent.wander.z}`)
    if (agent.wander.distanceTo(agent.pos) > 0.5) moved++
  }
  assert.ok(moved > 50, 'it should still find spots on the plot to potter to')
})

test('working round a building never picks a point off the plot', () => {
  const { c, agent } = crew()
  agent.status = 'working'
  // A building on the edge: the ring of spots round it (radius 1.6) crosses the border.
  // The agent stands level with the building, so its next step along the ring heads for the edge.
  agent.anchor.set(0, 0, EDGE - 0.5)
  agent.site.set(1.6, 0, EDGE - 0.5)
  agent.pos.copy(agent.site)
  let moved = 0
  for (let i = 0; i < 400; i++) {
    agent.workAt = 0
    c._workRound(agent, 0.016, 100)
    assert.ok(onZone(agent.workSpot.x, agent.workSpot.z), `round ${i} chose ${agent.workSpot.x}, ${agent.workSpot.z}`)
    if (agent.workSpot.distanceTo(agent.pos) > 0.5) moved++
  }
  assert.ok(moved > 50, 'it should still find spots on the plot to work from')
})

test('jitter recovery keeps an agent on its plot, however near the border it is', () => {
  for (let i = 0; i < 100; i++) {
    const { c, agent } = crew()
    // Wedged inside a building's keep circle at the edge, so the nearest clear ground is
    // some way off in some direction, and about half of those directions are next door.
    // The keep radius varies because the search direction depends on how far out it has to go.
    const x = (Math.random() - 0.5) * 4
    c.nav.rebuild([{ x, z: EDGE - 0.2, r: 1, keep: 1.5 + Math.random() * 3 }])
    agent.pos.set(x, 0, EDGE - 0.2)
    c._unglitch(agent)
    assert.ok(agent.pos.distanceTo(new THREE.Vector3(x, 0, EDGE - 0.2)) > 1, 'it should have moved')
    assert.ok(onZone(agent.pos.x, agent.pos.z), `unglitch ${i} landed on ${agent.pos.x}, ${agent.pos.z}`)
  }
})

test('jitter recovery still gets an agent that is already off its plot moving', () => {
  const { c, agent } = crew()
  agent.pos.set(0, 0, EDGE + 1)
  c._unglitch(agent)
  assert.equal(agent.pathVersion, -1)
  assert.ok(agent.driftBlocked)
})

test('an agent with no plot is not restricted', () => {
  const { c, agent } = crew({ onPlot: null })
  agent.site.set(0, 0, EDGE - 0.4)
  agent.pos.copy(agent.site)
  let off = 0
  for (let i = 0; i < 400; i++) {
    agent.wanderAt = 0
    c._drift(agent, 0.016, 100)
    if (!onZone(agent.wander.x, agent.wander.z)) off++
  }
  assert.ok(off > 0)
})

test('giving up on a site from another zone keeps the real site and tries again', () => {
  const { c, agent } = crew()
  agent.state = 'walking'
  agent.site.set(0, 0, 0)
  agent.pos.set(0, 0, EDGE + 3)
  agent.stuckFor = 6
  agent.stateAge = 10
  c._step(agent, 0.016, 100, {})
  assert.deepEqual([agent.site.x, agent.site.z], [0, 0])
  assert.equal(agent.state, 'walking')
  assert.equal(agent.pathVersion, -1)
})

test('giving up on a site on its own plot still adopts the ground it reached', () => {
  const { c, agent } = crew()
  agent.state = 'walking'
  agent.site.set(0, 0, 0)
  agent.pos.set(0, 0, EDGE - 3)
  agent.stuckFor = 6
  agent.stateAge = 10
  c._step(agent, 0.016, 100, {})
  assert.equal(agent.site.z, EDGE - 3)
  assert.equal(agent.state, 'at-site')
})
