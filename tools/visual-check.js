import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Colony } from '../src/game/colony.js'
import { loadKit } from '../src/world/kit.js'
import { loadCrew, crewRig } from '../src/agents/crew.js'
import { installWorldCurve, setCurveView, CURVE_FULL } from '../src/core/curve.js'
import { PLANETS, mulberry } from '../src/world/planet.js'

// Synthetic data only: no colony API, saved preferences, or user threads are modified.
Math.random = mulberry(9342)
const output = document.querySelector('#results')
const query = new URLSearchParams(location.search)
const planet = PLANETS[query.get('planet')] ? query.get('planet') : 'ocean'
const results = []
const report = (r) => { results.push(r); output.textContent = JSON.stringify(results, null, 2) }
try {
  await Promise.all([loadKit(), loadCrew()])
  installWorldCurve()
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    planet, autoQuality: false, timeOfDay: 0.34, autoTime: false, clockTime: false,
    renderScale: 1 / devicePixelRatio, tiltShift: false, worldCurve: 0.45,
    exposure: 1, bloomStrength: 0.25, saturation: 1, vignette: 0.3, iblIntensity: 1, fov: 38,
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)
  colony.astronauts.setRig(crewRig())
  const threads = Array.from({ length: 42 }, (_, i) => ({
    id: `visual-${i}`, project: `fixture-${Math.floor(i / 14)}`, title: `Fixture ${i}`,
    createdAt: i, lastActivityAt: Date.now(), sizeBytes: 100000, unread: i % 3 === 0, running: i % 3 === 1,
  }))
  colony.setThreads(threads, new Set(), new Set(), new Set(threads.map(t => t.id)))
  const focus = new THREE.Vector3()
  const view = (x, y, z, distance = 1) => {
    focus.set(x, y, z)
    engine.camera.position.set(x + 30 * distance, y + 30 * distance, z + 40 * distance)
    engine.camera.lookAt(focus)
    engine.setFocusDistance(engine.camera.position.distanceTo(focus))
    setCurveView(focus, Math.atan2(30, 40), CURVE_FULL * 0.45)
  }
  view(0, 0, 0)
  let corrections = 0
  const original = colony.astronauts._unglitch.bind(colony.astronauts)
  colony.astronauts._unglitch = (a) => { corrections++; original(a) }
  const probe = Object.create(Object.getPrototypeOf(colony.astronauts))
  probe._sep = new THREE.Vector3()
  probe._separation = (_, out) => out.set(0, 0, 0)
  const stopped = { pos: new THREE.Vector3(), vel: new THREE.Vector3(1, 0, 0), speed: 1, ghost: 0 }
  probe._walk(stopped, new THREE.Vector3(0.01, 0, 0), 0.01, 1 / 60, 1)
  const waypointStops = stopped.vel.length() === 0 && stopped.pos.length() === 0
  const history = new Map()
  let jitterSeconds = 0, settledJitterSeconds = 0, restingWalkSeconds = 0
  const timings = []
  const jitterAgents = new Set()
  const roofLandings = new Set()
  let clippedParcels = 0
  for (let frame = 0; frame < 10800; frame++) {
    const start = performance.now()
    colony.update(1 / 60, frame / 60, focus)
    timings.push(performance.now() - start)
    for (const p of colony.fauna.fleet?.parcels || []) {
      const surface = colony.buildingSurfaces.at(p.x, p.z)
      if (p.y < surface.height - 0.01) clippedParcels++
      if (p.landed && surface.height > colony.groundAt(p.x, p.z) + 0.25) roofLandings.add(p)
    }
    for (const a of colony.astronauts.agents) {
      let h = history.get(a.id)
      if (!h) history.set(a.id, h = { x: a.pos.x, z: a.pos.z, startX: a.pos.x, startZ: a.pos.z, travel: 0 })
      h.travel += Math.hypot(a.pos.x - h.x, a.pos.z - h.z)
      h.x = a.pos.x; h.z = a.pos.z
      if (frame % 60 === 59) {
        if (frame > 600 && h.travel > 0.3 && Math.hypot(a.pos.x - h.startX, a.pos.z - h.startZ) < 0.15) {
          jitterSeconds++
          if (frame > 3600) { settledJitterSeconds++; jitterAgents.add(a.id) }
        }
        if (frame > 3600 && a.status === 'waiting' && a.state === 'at-site' && a.groundSpeed > 0.15) restingWalkSeconds++
        h.travel = 0; h.startX = a.pos.x; h.startZ = a.pos.z
      }
    }
    if (frame % 180 === 0) { engine.renderFrame(); await new Promise(requestAnimationFrame) }
  }
  let offDeckVertices = 0, buildingVertices = 0, offDeckProps = 0, offDeckScaffolds = 0
  const point = new THREE.Vector3()
  for (const entry of colony.buildings.values()) {
    entry.mesh.updateMatrixWorld(true)
    const pos = entry.mesh.geometry.attributes.position
    const plot = colony.plots.get(entry.plot)
    for (let i = 0; i < pos.count; i++) {
      point.fromBufferAttribute(pos, i).applyMatrix4(entry.mesh.matrixWorld)
      if (!plot.containsWorld(point.x, point.z)) offDeckVertices++
      buildingVertices++
    }
  }
  for (const plot of colony.plotOrder) {
    for (const p of plot.clutterSpots || []) if (!plot.containsLocal(p.x, p.z, p.r)) offDeckProps++
  }
  for (const site of colony._scaffoldSites()) {
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.78
      const x = site.x + Math.cos(a) * site.radius, z = site.z + Math.sin(a) * site.radius
      if (!site.contains(x, z)) continue // omitted by the scaffold renderer
      if (!colony.plotOrder.some(p => p.containsWorld(x, z, 0.14))) offDeckScaffolds++
    }
  }
  timings.sort((a, b) => a - b)
  report({ complete: true, planet, simulatedSeconds: 180, waypointStops, jitterSeconds, settledJitterSeconds,
    jitterAgents: [...jitterAgents], restingWalkSeconds, corrections, offDeckVertices, buildingVertices,
    offDeckProps, offDeckScaffolds, roofLandings: roofLandings.size, clippedParcels,
    blockedSites: colony.astronauts.agents.filter(a => colony.nav.isBlocked(a.site.x, a.site.z) || colony.nav.insideKeep(a.site.x, a.site.z)).length,
    updateMedianMs: timings[Math.floor(timings.length * 0.5)], updateP95Ms: timings[Math.floor(timings.length * 0.95)],
    grassBlades: colony.grass?.mesh.count, foliage: colony.scatterGroup.children.reduce((s, m) => s + m.count, 0),
  })
  let elapsed = 180
  engine.add({ update(dt) { elapsed += dt; colony.update(dt, elapsed, focus) } })
  engine.start()
  for (const id of ['ocean', 'terra', 'moon']) {
    const link = document.createElement('a')
    link.textContent = PLANETS[id].name
    link.href = `?planet=${id}`
    document.querySelector('nav').append(link)
  }
  const button = (text, fn) => {
    const b = document.createElement('button'); b.textContent = text; b.onclick = fn
    document.querySelector('nav').append(b)
  }
  button('Overview', () => view(0, 0, 0))
  button('Delivery close-up', () => {
    const entry = [...colony.buildings.values()].find(e => e.mesh.userData.kind === 'greenhouse') || [...colony.buildings.values()][0]
    const p = entry.mesh.position
    view(p.x, p.y + 0.5, p.z, 0.22)
    const fleet = colony.fauna.fleet
    if (fleet) for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2
      const x = p.x + Math.cos(a) * 0.5, z = p.z + Math.sin(a) * 0.5
      fleet._release({ x, z, y: colony.buildingSurfaces.at(x, z).height + 4 })
    }
  })
  button('Night / day', () => {
    settings.values.timeOfDay = settings.values.timeOfDay === 0.34 ? 0.8 : 0.34
    colony.sky.setTime(settings.values.timeOfDay)
  })
} catch (error) { report({ error: error.stack }) }
