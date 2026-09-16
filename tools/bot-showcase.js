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

const WIDTH = 1080, HEIGHT = 1920, FPS = 30, DURATION = 22
const output = document.querySelector('#results')
const buttons = [...document.querySelectorAll('button')]
const status = info => { output.textContent = JSON.stringify(info, null, 2) }
const pause = () => new Promise(resolve => setTimeout(resolve, 0))
try {
  await Promise.all([loadKit(), loadCrew()])
  installWorldCurve(); setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.high.values, {
    renderScale: 2 / devicePixelRatio, autoQuality: false, autoTime: false, clockTime: false,
    ibl: true, iblIntensity: 1, bloom: true, bloomStrength: 0.20, exposure: 1,
    tiltShift: false, colorGrade: false, antialias: true, fov: 36, shadows: 'high',
  })
  const engine = new Engine(settings).mount(document.querySelector('#stage'))
  const { scene, camera, renderer } = engine
  const sky = new Sky(scene, settings, renderer)
  sky.setPlanet(PLANETS.ocean); sky.setTime(0.34)
  const plot = new Plot({ id: 'showcase', name: 'Showcase', index: 0, cells: [{ q: 0, r: 0 }], accent: 0x386d90 })
  scene.add(plot.group)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0x355760, roughness: 0.9 }))
  ground.rotation.x = -Math.PI / 2; scene.add(ground)
  for (const [x, z, accent, kind, yaw] of [
    [-5.0, 4.8, 0xd8663d, 'habitat', 0.9],
    [5.0, 4.8, 0x438fab, 'habitat', -0.6],
    [-2.8, -5.4, 0x3b939a, 'habitat', 0.4],
    [2.6, -5.4, 0x77976c, 'greenhouse', -0.5],
  ]) {
    const mesh = createBuilding({ seed: 7, accent, kind })
    mesh.position.set(x, DECK_TOP, z); mesh.rotation.y = yaw; scene.add(mesh)
  }
  const crew = new Astronauts(scene, settings), rig = crewRig()
  crew.setRig(rig)
  const cast = [
    { id: 'sleepy', state: 'sleeping', face: FACE.sleep, x: -0.63, z: -0.62, yaw: 0.12, phase: 0 },
    { id: 'happy', state: 'celebrating', face: FACE.happy, x: 0.63, z: -0.62, yaw: 0.10, phase: 1.6 },
    { id: 'attentive', state: 'waiting', face: FACE.alert, x: 0, z: 0.82, yaw: 0, phase: 3.4 },
  ]
  for (const item of cast) {
    crew._spawnAgent({ id: item.id, status: item.state, site: new THREE.Vector3(), thread: {} }, false)
    const agent = crew.byId.get(item.id)
    agent.pos.set(item.x, DECK_TOP, item.z)
    agent.yaw = item.yaw; agent.scale = 1; agent.suit = 0xf3f2ef; agent.phase = item.phase
    agent.clipKey = 'sit'; agent.frame = frameFor(rig.clips.sit, item.phase)
    crew._applyStatus(agent, item.state); agent.faceFrame = item.face; agent.colorDirty = true
  }
  const focus = new THREE.Vector3(0, DECK_TOP + 0.43, 0.08)
  const reflections = new SceneryReflections({ scene, renderer, settings, sky, astronauts: crew })
  const still = document.createElement('img'); still.id = 'still'; still.alt = 'Three seated bots in a portrait camera orbit'
  document.querySelector('#stage').append(still)
  let previewing = false, recording = false, previewAt = 0, previousTime = 0
  const pose = t => {
    for (const item of cast) {
      const a = crew.byId.get(item.id)
      a.frame = frameFor(rig.clips.sit, t * 0.72 + item.phase)
      a.yaw = item.yaw + Math.sin(t * 0.42 + item.phase) * 0.04
      a.faceFrame = item.face
      if (item.id === 'attentive' && t % 5.4 > 4.95 && t % 5.4 < 5.08) a.faceFrame = FACE.blink
      if (item.id === 'happy' && t > 11.8 && t < 12.45) a.faceFrame = FACE.wink
    }
    crew._writeMatrices(t, 1)
  }
  const cameraAt = t => {
    const progress = THREE.MathUtils.clamp(t / DURATION, 0, 1)
    const smooth = progress * progress * (3 - 2 * progress)
    const angle = THREE.MathUtils.lerp(-0.42, 0.42, smooth)
    const radius = 6.35 - Math.sin(progress * Math.PI) * 0.9
    camera.position.set(Math.sin(angle) * radius, DECK_TOP + 2.9, Math.cos(angle) * radius + 0.08)
    camera.lookAt(focus); camera.updateMatrixWorld()
  }
  const render = (t, dt = 0) => {
    pose(t); cameraAt(t)
    sky.update(0, t, camera)
    reflections.update(dt, focus, camera)
    renderer.setClearColor(0x132534)
    engine.renderFrame()
  }
  const snapshot = t => {
    render(t)
    still.src = engine.canvas.toDataURL('image/png'); still.style.display = 'block'
    status({ ready: true, time: t, dimensions: [engine.canvas.width, engine.canvas.height], states: cast.map(a => a.id), reflections: reflections.stats, glError: renderer.getContext().getError() })
  }
  render(0)
  sky._refreshEnvironment(true)
  for (let i = 0; i < 35; i++) reflections.update(1 / FPS, focus, camera)
  snapshot(0)

  // Preview samples are exports of the actual drawing buffer, not composited mockups.
  for (const t of [0, 11, 22]) {
    render(t)
    const thumb = document.createElement('img'); thumb.alt = `Orbit at ${t} seconds`
    thumb.src = engine.canvas.toDataURL('image/png'); document.querySelector('#frames').append(thumb)
  }
  snapshot(0)
  document.querySelector('#start').onclick = () => { previewing = false; snapshot(0) }
  document.querySelector('#middle').onclick = () => { previewing = false; snapshot(11) }
  document.querySelector('#end').onclick = () => { previewing = false; snapshot(22) }
  document.querySelector('#preview').onclick = () => {
    previewing = !previewing; previewAt = performance.now(); previousTime = 0
    still.style.display = previewing ? 'none' : 'block'
    if (!previewing) snapshot(0)
  }
  const animate = now => {
    if (previewing && !recording) {
      const t = ((now - previewAt) / 1000) % DURATION
      render(t, Math.min(0.05, Math.max(0, t - previousTime))); previousTime = t
    }
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  document.querySelector('#record').onclick = async () => {
    recording = true; previewing = false
    buttons.forEach(b => b.disabled = true)
    still.style.display = 'none'
    try {
      if (engine.canvas.width !== WIDTH || engine.canvas.height !== HEIGHT) throw new Error('Recording buffer must be 1080 × 1920')
      // Lossless canvas frames flow to the temporary local encoder. Rendering at explicit
      // timestamps guarantees 30 fps output even if capture is slower than real time.
      const response = await fetch('http://127.0.0.1:5276/start', { method: 'POST' })
      if (!response.ok) throw new Error(await response.text())
      render(0)
      reflections.invalidate()
      for (let i = 0; i < 35; i++) reflections.update(1 / FPS, focus, camera)
      const total = DURATION * FPS
      for (let frame = 0; frame < total; frame++) {
        render(frame / FPS, 1 / FPS)
        const error = renderer.getContext().getError()
        if (error) throw new Error(`WebGL error ${error} at frame ${frame}`)
        const png = await new Promise(resolve => engine.canvas.toBlob(resolve, 'image/png'))
        if (!png) throw new Error('Canvas capture failed')
        const sent = await fetch(`http://127.0.0.1:5276/frame/${frame}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })
        if (!sent.ok) throw new Error(await sent.text())
        if (frame % FPS === 0) status({ recording: true, frame, total, percent: Math.round(100 * frame / total) })
        await pause()
      }
      status({ encoding: true, frames: total })
      const finished = await fetch('http://127.0.0.1:5276/finish', { method: 'POST' })
      if (!finished.ok) throw new Error(await finished.text())
      const result = await finished.json()
      snapshot(11)
      status({ complete: true, ...result, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, glError: renderer.getContext().getError() })
    } catch (error) { status({ error: error.stack }) }
    finally { recording = false; buttons.forEach(b => b.disabled = false) }
  }
} catch (error) { status({ error: error.stack }) }
