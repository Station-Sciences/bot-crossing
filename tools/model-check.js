import * as THREE from 'three'
import { Sky } from '../src/world/sky.js'
import { PLANETS } from '../src/world/planet.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor } from '../src/agents/crew.js'
import { FACE } from '../src/agents/faces.js'
import { animateFace } from '../src/agents/face-animation.js'
import { installWorldCurve, setCurveView } from '../src/core/curve.js'

const planetLighting = new URLSearchParams(location.search).get('lighting') === 'planet'
const output = document.querySelector('#results')
try {
  await loadCrew()
  installWorldCurve()
  setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, bloom: true,
    bloomStrength: 0.25, tiltShift: false, colorGrade: false, antialias: true,
    shadows: 'high', fov: 30, exposure: 1,
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  engine.renderer.setClearColor(0x29364b)
  if (!planetLighting) {
    const pmrem = new THREE.PMREMGenerator(engine.renderer)
    const hdr = await new HDRLoader().loadAsync('/assets/lighting/studio_small_09_1k.hdr')
    const environment = pmrem.fromEquirectangular(hdr)
    engine.scene.environment = environment.texture
    engine.scene.environmentIntensity = 0.7
    hdr.dispose(); pmrem.dispose()
  }
  engine.scene.add(new THREE.HemisphereLight(0xdae7ff, 0x596477, 0.3))
  const sun = new THREE.DirectionalLight(0xfff5e8, 1.2)
  sun.position.set(-2.5, 5, 4); sun.castShadow = true
  sun.shadow.mapSize.setScalar(2048)
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.1, far: 12 })
  sun.shadow.normalBias = 0.015; engine.scene.add(sun)
  let sky
  if (planetLighting) {
    sun.visible = false
    engine.scene.children.filter(o => o.isHemisphereLight).forEach(o => o.visible = false)
    settings.values.autoTime = false; settings.values.clockTime = false
    sky = new Sky(engine.scene, settings, engine.renderer)
    sky.setPlanet(PLANETS.ocean); sky.setTime(0.34)
    sky.update(0, 0, engine.camera)
    document.querySelector('p').textContent = 'Game sky and lighting · Archipelago · fixed poses'
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x29364b, roughness: 0.92 }))
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.012; ground.receiveShadow = true; engine.scene.add(ground)
  const crew = new Astronauts(engine.scene, settings), rig = crewRig()
  crew.setRig(rig)
  for (const [i, pose] of ['idle', 'sit'].entries()) {
    const id = `model-${pose}`
    crew._spawnAgent({ id, status: 'sleeping', site: new THREE.Vector3(), thread: {} }, false)
    const a = crew.byId.get(id)
    a.pos.set(i ? 0.68 : -0.68, 0, 0)
    a.yaw = 0.25; a.scale = 1; a.suit = 0xf3f2ef; a.phase = 0
    crew._applyStatus(a, 'sleeping')
    a.faceFrame = FACE.sleep; a.frame = frameFor(rig.clips[pose], 0.4)
    a.clipKey = pose; a.colorDirty = true
  }
  let moving = false, detail = false, yaw = 0.25, pose = 'idle'
  let walkingFaces = false, walkingTime = 0, arrived = false
  for (const name of Object.keys(FACE).filter(name => FACE[name] >= FACE.stroll)) {
    const option = document.createElement('option'); option.value = name; option.textContent = name
    document.querySelector('#expression').append(option)
  }
  const walkAt = time => {
    walkingTime = time
    for (const a of crew.agents) {
      a.state = arrived ? 'at-site' : 'walking'; a.stateAge = time
      a.groundSpeed = arrived ? 0 : 2.1
      a.walkFaceTime = time
      a.blinkAt = 4.8 - ((time + a.walkPersonality * 5) % 5)
      a.frame = frameFor(rig.clips[arrived ? (a.status === 'sleeping' ? 'sit' : 'work') : 'walk'], time)
      animateFace(a, 0)
    }
    document.querySelector('#walk-time').value = time % 26
  }
  const view = (angle = yaw, close = detail) => {
    yaw = angle; detail = close
    for (const a of crew.agents) {
      a.yaw = yaw
      if (!moving && !walkingFaces) a.frame = frameFor(rig.clips[a.id === 'model-idle' ? pose : 'sit'], 0.4)
    }
    engine.camera.position.set(close ? -0.68 : 0, close ? 1.02 : 1.55, close ? 1.65 : 4.6)
    engine.camera.lookAt(close ? -0.68 : 0, close ? 0.96 : 0.73, 0)
    engine.camera.updateMatrixWorld()
    sky?.update(0, 0, engine.camera)
    crew._writeMatrices(0, 1); engine.renderFrame()
    // A static DOM snapshot survives background-tab compositor throttling and captures
    // the exact production drawing buffer without changing renderer preservation.
    let still = document.querySelector('#still')
    if (!still) {
      still = document.createElement('img'); still.id = 'still'; still.alt = 'Fixed-pose game render'
      Object.assign(still.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
      document.querySelector('#scene').appendChild(still)
    }
    still.src = engine.canvas.toDataURL('image/png')
  }
  document.querySelector('#front').onclick = () => view(0, false)
  document.querySelector('#angle').onclick = () => view(0.4, false)
  document.querySelector('#back').onclick = () => view(Math.PI + 0.4, false)
  document.querySelector('#close').onclick = () => view(0.35, true)
  document.querySelector('#expression').onchange = e => {
    const expression = e.target.value
    walkingFaces = expression === 'walkingSequence'
    document.querySelector('#walking-controls').hidden = !walkingFaces
    if (walkingFaces) {
      arrived = false; document.querySelector('#arrive').textContent = 'Arrive at destination'
      for (const [i, a] of crew.agents.entries()) {
        a.status = i ? 'sleeping' : 'working'; crew._applyStatus(a, a.status)
      }
      moving = true; document.querySelector('#motion').textContent = 'Freeze'
      walkAt(0); view()
      document.querySelector('#still').style.display = 'none'
      return
    }
    const status = ['wait', 'alert'].includes(expression) ? 'waiting'
      : expression === 'sleep' ? 'sleeping' : expression === 'work' ? 'working'
      : ['error', 'sad'].includes(expression) ? 'blocked'
      : ['happy', 'love', 'cheer', 'wink'].includes(expression) ? 'celebrating' : 'idle'
    for (const a of crew.agents) {
      a.status = status; crew._applyStatus(a, status); a.faceFrame = FACE[expression]
    }
    view()
  }
  document.querySelector('#pose').onchange = e => {
    pose = e.target.value; crew.agents[0].clipKey = pose; view()
  }
  document.querySelector('#walk-time').oninput = e => {
    moving = false; document.querySelector('#motion').textContent = 'Animate'
    walkAt(Number(e.target.value)); view()
    document.querySelector('#still').style.display = 'block'
  }
  document.querySelector('#arrive').onclick = e => {
    arrived = !arrived; e.target.textContent = arrived ? 'Set off again' : 'Arrive at destination'
    walkAt(walkingTime); view()
  }
  document.querySelector('#light').onclick = () => {
    if (sky) {
      sky.setTime(sky.time > 0.7 ? 0.34 : 0.94)
      sky._refreshEnvironment(true)
    }
    else engine.scene.environmentRotation.y += Math.PI / 3
    view()
  }
  document.querySelector('#motion').onclick = e => {
    moving = !moving; e.target.textContent = moving ? 'Freeze' : 'Animate'
    document.querySelector('#still').style.display = moving ? 'none' : 'block'
    if (!moving) view(0.4, detail)
  }
  engine.add({ update(dt, elapsed) {
    if (moving && walkingFaces) walkAt(walkingTime + dt)
    if (moving) for (const a of crew.agents) {
      if (!walkingFaces) a.frame = frameFor(rig.clips[a.id === 'model-idle' ? (pose === 'idle' ? 'walk' : pose) : 'sit'], elapsed)
      a.yaw = walkingFaces ? yaw : Math.sin(elapsed * 0.4) * 0.8
    }
    crew._writeMatrices(moving ? elapsed : 0, 1)
    output.textContent = JSON.stringify({ ready: true, moving, detail, calls: engine.renderer.info.render.calls,
      triangles: engine.renderer.info.render.triangles, bodyVertices: rig.geometry.attributes.position.count,
      ...(walkingFaces ? { walkingTime: Number(walkingTime.toFixed(2)), arrived,
        faces: crew.agents.map(a => Object.keys(FACE).find(key => FACE[key] === a.faceFrame)),
        glError: engine.renderer.getContext().getError() } : {}) }, null, 2)
  } })
  view(0.25, false); engine.start()
  if (new URLSearchParams(location.search).has('walking')) {
    const select = document.querySelector('#expression'); select.value = 'walkingSequence'
    select.dispatchEvent(new Event('change'))
  }
} catch (error) { output.textContent = error.stack }
