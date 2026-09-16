import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Sky } from '../src/world/sky.js'
import { PLANETS } from '../src/world/planet.js'
import { createBuilding } from '../src/world/buildings.js'
import { loadKit } from '../src/world/kit.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor } from '../src/agents/crew.js'
import { FACE } from '../src/agents/faces.js'
import { installWorldCurve, setCurveView } from '../src/core/curve.js'

const output = document.querySelector('#results')
const report = data => { output.textContent = JSON.stringify(data, null, 2) }
try {
  await Promise.all([loadKit(), loadCrew()])
  installWorldCurve(); setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, autoTime: false, clockTime: false,
    ibl: true, iblIntensity: 1, bloom: true, bloomStrength: 0.25, exposure: 1,
    tiltShift: false, colorGrade: false, antialias: true, fov: 32, shadows: 'high',
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  const { scene, camera, renderer } = engine
  const sky = new Sky(scene, settings, renderer)
  sky.setPlanet(PLANETS.ocean); sky.setTime(0.34)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x687f92, roughness: 0.9 }))
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground)
  const house = createBuilding({ seed: 7, accent: 0x5999aa, kind: 'habitat' })
  house.position.set(3.5, 0, -2.6); scene.add(house)
  const crew = new Astronauts(scene, settings), rig = crewRig()
  crew.setRig(rig)
  for (const [i, pose] of ['idle', 'sit'].entries()) {
    const a = crew._spawnAgent({ id: `ao-${pose}`, status: 'sleeping', site: new THREE.Vector3(), thread: {} }, false)
    a.pos.set(i ? 0.6 : -0.6, 0, 0); a.yaw = 0.25; a.scale = 1; a.suit = 0xf3f2ef; a.phase = 0
    a.frame = frameFor(rig.clips[pose], 0.4); a.clipKey = pose; a.faceFrame = i ? FACE.sleep : FACE.stroll
  }
  crew._writeMatrices(0, 1)
  const still = document.createElement('img'); still.id = 'still'; still.alt = 'Game models with adjustable ambient occlusion'
  document.querySelector('#scene').append(still)
  const gl = renderer.getContext()
  let view = 'crew'
  const cameraAt = () => {
    if (view === 'crew') { camera.position.set(0.25, 1.65, 4.4); camera.lookAt(0, 0.68, 0) }
    else { camera.position.set(7.2, 3.8, 3); camera.lookAt(3.5, 1.0, -2.6) }
    camera.updateMatrixWorld(); engine.setFocusDistance(view === 'crew' ? 4.4 : 7)
    sky.update(0, 0, camera)
  }
  cameraAt(); sky._refreshEnvironment(true)
  const setStrength = strength => {
    settings.values.ambientOcclusion = strength; engine.applySettings()
    document.querySelector('#strength').value = strength
    document.querySelector('#value').textContent = strength ? `${Math.round(strength * 100)}%` : 'Off'
  }
  const capture = () => {
    engine.renderFrame()
    const data = new Uint8Array(engine.canvas.width * engine.canvas.height * 4)
    gl.readPixels(0, 0, engine.canvas.width, engine.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return data
  }
  const diff = (a, b) => {
    let changed = 0, darker = 0, delta = 0
    for (let i = 0; i < a.length; i += 4) {
      const d = b[i] + b[i + 1] + b[i + 2] - a[i] - a[i + 1] - a[i + 2]
      if (Math.abs(d) > 3) changed++
      if (d < -3) darker++
      delta += Math.abs(d)
    }
    return { changed, darker, meanDelta: delta / (a.length / 4) / 3 }
  }
  const snapshot = () => {
    engine.renderFrame(); still.src = engine.canvas.toDataURL('image/png')
    report({ ready: true, strength: settings.get('ambientOcclusion'), view,
      drawCalls: renderer.info.render.calls, glError: gl.getError() })
  }
  const comparison = async () => {
    const saved = settings.get('ambientOcclusion')
    const images = []
    for (const strength of [0, 0.25]) {
      setStrength(strength); engine.renderFrame()
      const image = new Image(); image.src = engine.canvas.toDataURL('image/png'); await image.decode(); images.push(image)
    }
    const canvas = document.createElement('canvas'); canvas.width = 2160; canvas.height = 805
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#152034'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (const [i, image] of images.entries()) {
      const x = i % 2 * 1080, y = Math.floor(i / 2) * 805
      ctx.drawImage(image, x, y + 45)
      ctx.fillStyle = '#eaf2ff'; ctx.font = '24px system-ui'
      ctx.fillText(['Off', '25% · subtle'][i], x + 22, y + 32)
    }
    document.querySelector('#comparison').src = canvas.toDataURL('image/png')
    setStrength(saved); snapshot()
  }
  document.querySelector('#strength').oninput = e => { setStrength(Number(e.target.value)); snapshot() }
  for (const [id, strength] of [['off', 0], ['subtle', 0.25], ['strong', 1]]) {
    document.querySelector(`#${id}`).onclick = () => { setStrength(strength); snapshot() }
  }
  for (const id of ['crew', 'building']) document.querySelector(`#${id}`).onclick = () => { view = id; cameraAt(); comparison() }
  document.querySelector('#verify').onclick = async () => {
    const results = []
    setStrength(0); const off = capture(); const offCalls = renderer.info.render.calls
    setStrength(1); const on = capture(); const onCalls = renderer.info.render.calls
    results.push({ check: 'local shading is visible', ...diff(off, on), extraCalls: onCalls - offCalls })
    for (let frame = 0; frame < 4; frame++) results.push({ check: 'frozen frame parity', frame, ...diff(on, capture()) })
    setStrength(0); results.push({ check: 'off restores baseline and frees target', ...diff(off, capture()), freed: engine.occlusionPass.target === null })
    house.visible = false; crew.group.visible = false
    setStrength(0); const flatOff = capture()
    setStrength(1); const flatDifference = diff(flatOff, capture())
    results.push({ check: 'flat ground and sky remain unchanged', ...flatDifference })
    house.visible = true; crew.group.visible = true
    setStrength(1)
    let invalid = 0, errors = 0
    const inspect = target => {
      const bytes = new Uint16Array(target.width * target.height * 4)
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, bytes)
      for (const value of bytes) if ((value & 0x7c00) === 0x7c00) invalid++
    }
    const aoRender = engine.occlusionPass.render.bind(engine.occlusionPass)
    engine.occlusionPass.render = (r, w, read) => { aoRender(r, w, read); inspect(read); errors += gl.getError() !== 0 ? 1 : 0 }
    for (let i = 0; i < 36; i++) {
      const angle = i * 0.09, radius = 1.8 + i * 0.15
      camera.position.set(Math.sin(angle) * radius, 1.4 + i * 0.05, Math.cos(angle) * radius)
      camera.lookAt(0, 0.7, 0); camera.updateMatrixWorld()
      settings.values.tiltShift = i >= 12; settings.values.antialias = i % 2 === 0
      settings.values.renderScale = (i < 18 ? 1 : 0.65) / devicePixelRatio
      engine.applySettings(); engine.renderFrame()
      errors += gl.getError() !== 0 ? 1 : 0
      if (i % 6 === 0) await new Promise(requestAnimationFrame)
    }
    engine.occlusionPass.render = aoRender
    results.push({ check: 'moving camera, defocus, buffer parity and resize', invalidHDR: invalid, glErrors: errors })
    settings.values.tiltShift = false; settings.values.antialias = true
    settings.values.renderScale = 1 / devicePixelRatio
    cameraAt(); setStrength(0.25); snapshot()
    // Compare the actual overhead at the same drawing-buffer size after shader warmup.
    const timings = []
    for (const strength of [0, 0.25, 0, 0.25]) {
      setStrength(strength); engine.renderFrame(); gl.finish()
      const start = performance.now()
      for (let i = 0; i < 16; i++) engine.renderFrame()
      gl.finish(); timings.push({ strength, ms: (performance.now() - start) / 16 })
      await new Promise(requestAnimationFrame)
    }
    results.push({ check: 'GPU synchronized frame time, 1080x760', timings })
    settings.values.bloom = false; settings.values.antialias = false
    setStrength(0); const bare = capture(); const composerOff = engine.composer === null
    setStrength(0.25); capture(); const aoOnly = Boolean(engine.composer && engine.occlusionPass.target)
    setStrength(0); const restored = capture(); const released = engine.composer === null
    const soloError = gl.getError()
    const soloPassed = composerOff && aoOnly && released && diff(bare, restored).changed === 0 && soloError === 0
    results.push({ check: 'AO works alone, then releases the composer when off', passed: soloPassed, glError: soloError })
    settings.values.bloom = true; settings.values.antialias = true
    setStrength(0.25); snapshot()
    results.push({ complete: true, passed: results[0].darker > 100 && results[0].extraCalls === 2 &&
      results.filter(r => r.check === 'frozen frame parity').every(r => r.changed === 0) &&
      results[5].changed === 0 && results[5].freed && flatDifference.changed === 0 && invalid === 0 && errors === 0 && soloPassed, glError: gl.getError() })
    report(results)
  }
  await comparison()
} catch (error) { report({ error: error.stack }) }
