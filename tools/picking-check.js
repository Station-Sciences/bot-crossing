import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor, attachMatrixAt } from '../src/agents/crew.js'
import { installWorldCurve, setCurveView, bendPoint, CURVE_FULL } from '../src/core/curve.js'

const output = document.querySelector('#results')
try {
  await loadCrew()
  installWorldCurve()
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.low.values, { renderScale: 1 / devicePixelRatio, autoQuality: false,
    bloom: false, tiltShift: false, colorGrade: false, antialias: false, fov: 38 })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  engine.scene.add(new THREE.HemisphereLight(0xffffff, 0x657087, 2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(2, 6, 4); engine.scene.add(sun)
  const crew = new Astronauts(engine.scene, settings)
  const rig = crewRig()
  crew.setRig(rig)
  crew._spawnAgent({ id: 'click-test', status: 'idle', site: new THREE.Vector3(), thread: {} }, false)
  const agent = crew.byId.get('click-test')
  const root = new THREE.Matrix4(), bone = new THREE.Matrix4(), posed = new THREE.Vector3(), point = new THREE.Vector3()
  const src = rig.geometry.attributes.position, indices = rig.geometry.attributes.skinIndex, weights = rig.geometry.attributes.skinWeight
  const data = rig.boneTexture.image.data
  const failures = []
  let checks = 0, oldHeadMisses = 0
  const setView = (distance, curve) => {
    const target = new THREE.Vector3(agent.pos.x, 0.6, agent.pos.z)
    setCurveView(new THREE.Vector3(), 0.5, curve)
    bendPoint(target)
    engine.camera.position.copy(target).add(new THREE.Vector3(distance * 0.4, distance * 0.3, distance))
    engine.camera.lookAt(target)
    engine.camera.updateMatrixWorld()
  }
  const testPoint = (world, name) => {
    const screen = bendPoint(world.clone()).project(engine.camera)
    if (Math.abs(screen.x) > 1 || Math.abs(screen.y) > 1) return
    const picked = crew.pick(engine.camera, screen.x, screen.y, engine.camera.aspect)
    checks++
    if (picked !== agent && failures.length < 12) failures.push({ name, picked: picked?.id, point: screen.toArray() })
    const head = bendPoint(new THREE.Vector3(agent.pos.x, agent.pos.y + crew.headHeight, agent.pos.z)).project(engine.camera)
    if (Math.hypot((head.x - screen.x) * engine.camera.aspect, head.y - screen.y) > 0.075) oldHeadMisses++
  }
  for (const pose of ['idle', 'walk', 'run', 'sit', 'wave', 'work']) {
    for (const distance of [3, 10, 40]) {
      for (const curve of [0, CURVE_FULL]) {
        agent.pos.set(curve ? 18 : 0, 0, curve ? -15 : 0)
        agent.yaw = 0.7
        agent.frame = frameFor(rig.clips[pose], rig.clips[pose].duration * 0.35)
        agent.clipKey = pose
        agent.badgeSize = 0
        crew._writeMatrices(0, 1)
        setView(distance, curve)
        engine.renderFrame()
        crew.crew.getMatrixAt(0, root)
        for (const name of ['head', 'chest', 'hand.r', 'hand.l', 'foot.r', 'foot.l']) {
          attachMatrixAt(rig, agent.frame, rig.attachSlot.get(name), bone)
          testPoint(point.set(0, 0, 0).applyMatrix4(bone).applyMatrix4(root), `${pose}/${distance}/${curve}/${name}`)
        }
        // Sample actual GPU-skinned vertices, not only the landmarks used by the picker.
        const f = Math.floor(agent.frame), mix = agent.frame - f
        for (let i = 0; i < src.count; i += 23) {
          posed.set(0, 0, 0)
          for (let j = 0; j < 4; j++) {
            const w = weights.array[i * 4 + j]
            if (!w) continue
            const b = indices.array[i * 4 + j]
            for (const [frame, share] of [[f, 1 - mix], [Math.min(f + 1, rig.frameCount - 1), mix]]) {
              bone.fromArray(data, (frame * rig.boneCount + b) * 16)
              posed.addScaledVector(point.fromBufferAttribute(src, i).applyMatrix4(bone), w * share)
            }
          }
          testPoint(posed.applyMatrix4(root), `${pose}/${distance}/${curve}/vertex-${i}`)
        }
      }
    }
  }
  const expectPick = (name, world, expected) => {
    const screen = bendPoint(world.clone()).project(engine.camera)
    const picked = crew.pick(engine.camera, screen.x, screen.y, engine.camera.aspect)
    checks++
    if (picked !== expected) failures.push({ name, expected: expected?.id, picked: picked?.id })
  }
  agent.pos.set(0, 0, 0); agent.yaw = 0; agent.frame = frameFor(rig.clips.idle, 0)
  crew._spawnAgent({ id: 'rear', status: 'idle', site: new THREE.Vector3(), thread: {} }, false)
  const rear = crew.byId.get('rear')
  rear.pos.set(0, 0, -1); rear.frame = agent.frame
  setCurveView(new THREE.Vector3(), 0, 0)
  engine.camera.position.set(0, 0.6, 6); engine.camera.lookAt(0, 0.6, 0); engine.camera.updateMatrixWorld()
  crew._writeMatrices(0, 1)
  expectPick('nearer overlapping body wins', new THREE.Vector3(0, 0.6, 0), agent)
  rear.pos.set(1.5, 0, 0)
  const capacity = crew.capacity
  crew.capacity = 1; crew._writeMatrices(0, 1)
  expectPick('agent outside render capacity cannot intercept clicks', new THREE.Vector3(1.5, 0.6, 0), null)
  crew.capacity = capacity; rear.scale = 0.1; crew._writeMatrices(0, 1)
  expectPick('hidden agent cannot intercept clicks', new THREE.Vector3(1.5, 0.6, 0), null)
  agent.badgeSize = 0.166; agent.badgeY = 1.42
  const badge = new THREE.Vector3(0, agent.badgeY, 0).applyMatrix4(engine.camera.matrixWorldInverse)
  badge.y += agent.badgeSize * (2 - badge.z * 0.22) * 0.5
  badge.applyMatrix4(engine.camera.projectionMatrix)
  checks++
  if (crew.pick(engine.camera, badge.x, badge.y, engine.camera.aspect) !== agent) failures.push({ name: 'badge remains clickable' })
  agent.badgeSize = 0
  crew.agents.pop(); crew.byId.delete('rear')
  // Leave a static close-up for real pointer interaction.
  agent.pos.set(0, 0, 0); agent.yaw = 0; agent.frame = frameFor(rig.clips.idle, 0); agent.clipKey = 'idle'
  crew._writeMatrices(0, 1); setView(3, 0); engine.renderFrame()
  const controls = {}
  crew.crew.getMatrixAt(0, root)
  for (const name of ['head', 'chest', 'foot.r', 'foot.l']) {
    attachMatrixAt(rig, agent.frame, rig.attachSlot.get(name), bone)
    point.set(0, name === 'head' ? 0.46 : 0, 0).applyMatrix4(bone).applyMatrix4(root).project(engine.camera)
    controls[name] = { x: Math.round((point.x * 0.5 + 0.5) * 640), y: Math.round((-point.y * 0.5 + 0.5) * 480) }
  }
  output.textContent = JSON.stringify({ complete: true, passed: failures.length === 0, checks, oldHeadMisses, failures, clickLocationsWithinCanvas: controls }, null, 2)
  engine.canvas.addEventListener('pointerup', e => {
    const box = engine.canvas.getBoundingClientRect()
    const x = ((e.clientX - box.left) / box.width) * 2 - 1, y = 1 - ((e.clientY - box.top) / box.height) * 2
    const picked = crew.pick(engine.camera, x, y, box.width / box.height)
    document.querySelector('#selection').textContent = `Selected: ${picked?.id || 'none'} (${Math.round(e.clientX - box.left)}, ${Math.round(e.clientY - box.top)})`
    crew.setSelected(picked); crew.updateRings(0); engine.renderFrame()
  })
  engine.start()
} catch (error) { output.textContent = JSON.stringify({ error: error.stack }, null, 2) }
