import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Sky } from '../src/world/sky.js'
import { PLANETS } from '../src/world/planet.js'
import { Plot, DECK_TOP } from '../src/world/plots.js'
import { createBuilding } from '../src/world/buildings.js'
import { SceneryReflections } from '../src/world/reflections.js'
import { loadKit } from '../src/world/kit.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor } from '../src/agents/crew.js'
import { FACE } from '../src/agents/faces.js'
import { installWorldCurve, setCurveView } from '../src/core/curve.js'
const output = document.querySelector('#results')
try {
  await Promise.all([loadKit(), loadCrew()])
  installWorldCurve(); setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, autoTime: false, clockTime: false,
    ibl: true, iblIntensity: 1, bloom: true, bloomStrength: 0.25, exposure: 1,
    tiltShift: false, colorGrade: false, antialias: true, fov: 30, shadows: 'high',
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  const { scene, camera, renderer } = engine
  const sky = new Sky(scene, settings, renderer)
  sky.setPlanet(PLANETS.ocean); sky.setTime(0.34)
  const plot = new Plot({ id: 'reflection', name: 'Reflection review', index: 0, cells: [{ q: 0, r: 0 }], accent: 0x336799 })
  scene.add(plot.group)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0x304b5a, roughness: 0.95 }))
  ground.rotation.x = -Math.PI / 2; scene.add(ground)
  const houses = []
  for (const [x, z, accent, kind] of [[-2.3, 1.8, 0xd86235, 'habitat'], [2.7, 2.6, 0x4b99b9, 'habitat'], [2.6, -3, 0x4b99b9, 'greenhouse']]) {
    const mesh = createBuilding({ seed: 7, accent, kind })
    mesh.position.set(x, DECK_TOP, z); mesh.rotation.y = Math.PI / 3
    scene.add(mesh); houses.push(mesh)
  }
  const crew = new Astronauts(scene, settings), rig = crewRig()
  crew.setRig(rig)
  crew._spawnAgent({ id: 'reflection', status: 'sleeping', site: new THREE.Vector3(), thread: {} }, false)
  const agent = crew.agents[0]
  agent.pos.set(0, DECK_TOP, 0); agent.yaw = 0.2; agent.scale = 1; agent.suit = 0xf3f2ef; agent.phase = 0
  crew._applyStatus(agent, 'sleeping'); agent.faceFrame = FACE.sleep
  agent.frame = frameFor(rig.clips.idle, 0.4); agent.clipKey = 'idle'; agent.colorDirty = true
  crew._writeMatrices(0, 1)
  const focus = new THREE.Vector3(0, DECK_TOP + 0.94, 0)
  camera.position.set(0, DECK_TOP + 1.02, 1.8); camera.lookAt(focus); camera.updateMatrixWorld()
  sky.update(0, 0, camera); sky._refreshEnvironment(true)
  const reflections = new SceneryReflections({ scene, renderer, settings, sky, astronauts: crew })
  const still = document.createElement('img'); still.id = 'still'; still.alt = 'Actual engine render of glass with nearby building reflections'
  document.querySelector('#scene').append(still)
  const gl = renderer.getContext()
  const pixels = () => {
    const p = new Uint8Array(engine.canvas.width * engine.canvas.height * 4)
    gl.readPixels(0, 0, engine.canvas.width, engine.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p)
    return p
  }
  const delta = (a, b) => {
    let sum = 0, changed = 0
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      sum += d; if (d > 3) changed++
    }
    return { meanDelta: sum / (a.length / 4) / 3, changedPixels: changed }
  }
  const render = (local = true) => {
    const ready = reflections.uniforms.uReflectionReady.value
    if (!local) reflections.uniforms.uReflectionReady.value = 0
    renderer.setClearColor(0x101925)
    engine.renderFrame()
    still.src = engine.canvas.toDataURL('image/png')
    reflections.uniforms.uReflectionReady.value = ready
    return pixels()
  }
  const settle = () => {
    for (let i = 0; i < 35; i++) reflections.update(1 / 60, focus, camera)
  }
  render(false) // populate the actual sun shadow map before the probe reuses it
  const before = still.src
  settle(); render(true)
  const after = still.src
  // Side-by-side export is composed from actual drawing-buffer snapshots, with no retouching.
  const comparison = document.createElement('canvas'); comparison.width = 2000; comparison.height = 866
  const ctx = comparison.getContext('2d'); ctx.fillStyle = '#101925'; ctx.fillRect(0, 0, 2000, 866)
  for (const [i, src] of [before, after].entries()) {
    const img = new Image(); img.src = src; await img.decode(); ctx.drawImage(img, i * 1000, 66)
    ctx.fillStyle = '#e9effb'; ctx.font = '24px system-ui'; ctx.fillText(i ? 'AFTER · Buildings + deck + sky' : 'BEFORE · Sky only', i * 1000 + 28, 43)
  }
  document.querySelector('#comparison').src = comparison.toDataURL('image/png')
  const report = () => { output.textContent = JSON.stringify({ ready: true, ...reflections.stats, glError: gl.getError() }, null, 2) }
  document.querySelector('#before').onclick = () => { render(false); report() }
  document.querySelector('#after').onclick = () => { render(true); report() }
  document.querySelector('#move').onclick = () => {
    houses[0].position.z = houses[0].position.z < 3 ? 4 : 1.8
    reflections.lastCapture = -Infinity; settle(); render(); report()
  }
  document.querySelector('#angle').onclick = () => {
    agent.yaw = agent.yaw < 0.4 ? 0.65 : 0.2; crew._writeMatrices(0, 1); render(); report()
  }
  document.querySelector('#verify').onclick = async () => {
    const results = []
    const a = render(false), b = render(true)
    results.push({ check: 'scenery changes the rendered glass', ...delta(a, b) })
    results.push({ check: 'frozen reflection is stable', ...delta(b, render(true)) })
    // The moved building is outside the camera frustum, so a changed image is its reflection.
    const oldX = houses[0].position.x
    houses[0].position.x -= 2
    reflections.lastCapture = -Infinity; settle()
    results.push({ check: 'offscreen building changes reflection', ...delta(b, render(true)) })
    houses[0].position.x = oldX
    reflections.lastCapture = -Infinity; settle(); render()
    const data = new Uint16Array(128 * 128 * 4)
    let invalid = 0
    for (let face = 0; face < 6; face++) {
      renderer.readRenderTargetPixels(reflections.targets[reflections.published], 0, 0, 128, 128, data, face)
      for (const p of data) if ((p & 0x7c00) === 0x7c00) invalid++
    }
    results.push({ check: 'all six HDR cube faces are finite', invalid })
    const savedMaterial = crew.parts.visor.material
    const changed = new Set(['maxAgents']); settings.values.maxAgents = 200
    crew.onSettingsChanged(changed); crew._writeMatrices(0, 1); render()
    results.push({ check: 'preset capacity rebuild retains reflections', rebuilt: savedMaterial !== crew.parts.visor.material, ready: reflections.uniforms.uReflectionReady.value })
    const times = []
    for (let i = 0; i < 18; i++) {
      if (reflections.face < 0) { reflections.lastCapture = -Infinity; reflections.blend = 1 }
      gl.finish(); const start = performance.now()
      reflections.update(1 / 60, focus, camera); gl.finish()
      times.push(+(performance.now() - start).toFixed(2))
      if (i % 6 === 5) await new Promise(requestAnimationFrame)
    }
    results.push({ check: 'one-face capture GPU synchronized ms, small scene', times })
    settings.values.ibl = false; reflections.update(1 / 60, focus, camera)
    results.push({ check: 'IBL off frees cubes and disables local reflections', released: reflections.targets === null, ready: reflections.uniforms.uReflectionReady.value })
    settings.values.ibl = true; settle(); render()
    results.push({ check: 'IBL back on restores reflection', ready: reflections.uniforms.uReflectionReady.value, glError: gl.getError() })
    output.textContent = JSON.stringify(results, null, 2)
  }
  report()
} catch (e) { output.textContent = e.stack }
