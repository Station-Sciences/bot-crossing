import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { installWorldCurve, setCurveView, CURVE_FULL } from '../src/core/curve.js'
import { Colony } from '../src/game/colony.js'
import { loadKit } from '../src/world/kit.js'
import { loadCrew, crewRig } from '../src/agents/crew.js'
import { checkOverlays } from './overlay-check.js'

const output = document.querySelector('#results')
const results = []
const report = (result) => {
  results.push(result)
  output.textContent = JSON.stringify(results, null, 2)
}
const nextFrame = () => new Promise(requestAnimationFrame)

try {
  await Promise.all([loadKit(), loadCrew()])
  installWorldCurve()
  checkOverlays(report)
  const settings = new Settings()
  // Read defaults, then pin every setting relevant to this fixture without persisting.
  Object.assign(settings.values, PRESETS.balanced.values, {
    planet: 'ocean', autoQuality: false, autoTime: false, clockTime: false,
    timeOfDay: 0.34, worldCurve: 0.45, renderScale: 1 / devicePixelRatio,
    exposure: 1, bloomStrength: 0.25, tiltShiftStrength: 0.2, tiltShiftAngle: 0,
    saturation: 1, vignette: 0.3, iblIntensity: 1, fov: 38,
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)
  colony.astronauts.setRig(crewRig())
  colony.onAssetsReady()
  const threads = Array.from({ length: 24 }, (_, i) => ({
    id: `render-check-${i}`, project: `fixture-${Math.floor(i / 6)}`, title: `Fixture ${i}`,
    lastActivityAt: Date.now(), createdAt: Date.now(), sizeBytes: 100000,
    unread: i % 3 === 0, running: i % 3 === 1,
  }))
  colony.setThreads(threads)
  const focus = new THREE.Vector3(0, 0, 0)
  engine.camera.position.set(32, 27, 38)
  engine.camera.lookAt(focus)
  engine.setFocusDistance(engine.camera.position.length())
  setCurveView(focus, Math.atan2(32, 38), CURVE_FULL * 0.45)
  for (let i = 0; i < 180; i++) colony.update(1 / 60, i / 60, focus)
  await nextFrame()

  const gl = engine.renderer.getContext()
  const renderScene = engine.renderer.render
  engine.renderer.render = function(scene, camera) {
    renderScene.call(this, scene, camera)
    const error = gl.getError()
    if (error) report({ check: 'WebGL render error location', error, planet: settings.get('planet'),
      cube: Boolean(this.getRenderTarget()?.isWebGLCubeRenderTarget), probeFace: colony.reflections.face,
      captures: colony.reflections.stats.captures, scene: scene.type, camera: camera.type })
  }
  const pixels = () => {
    const data = new Uint8Array(engine.canvas.width * engine.canvas.height * 4)
    gl.readPixels(0, 0, engine.canvas.width, engine.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return data
  }
  const difference = (a, b) => {
    let changed = 0, total = 0
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      if (delta > 3) changed++
      total += delta
    }
    return { changedPercent: +(100 * changed / (a.length / 4)).toFixed(3), meanDelta: +(total / (a.length / 4) / 3).toFixed(4) }
  }
  const invalidByPass = {}
  let isolated = false
  let inspectHdr = true
  for (const [index, pass] of engine.composer.passes.entries()) {
    const render = pass.render
    pass.render = function(renderer, write, read, ...args) {
      render.call(this, renderer, write, read, ...args)
      if (this.renderToScreen || !inspectHdr) return
      const target = this.needsSwap ? write : read
      const data = new Uint16Array(target.width * target.height * 4)
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, data)
      let invalid = 0
      for (let i = 0; i < data.length; i++) if ((data[i] & 0x7c00) === 0x7c00) invalid++
      if (invalid) invalidByPass[`${index}:${pass.constructor.name}`] = Math.max(invalidByPass[`${index}:${pass.constructor.name}`] || 0, invalid)
      if (invalid && index === 0 && !isolated) {
        isolated = true
        const positions = []
        for (let i = 0; i < data.length && positions.length < 10; i += 4) {
          if ((data[i] & 0x7c00) === 0x7c00) positions.push({ x: (i / 4) % target.width, y: Math.floor(i / 4 / target.width), values: Array.from(data.slice(i, i + 4)) })
        }
        const isolation = []
        for (const object of [colony.water?.mesh, colony.grass?.mesh, ...engine.scene.children].filter(Boolean)) {
          const visible = object.visible
          object.visible = false
          render.call(this, renderer, write, read, ...args)
          renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, data)
          let bad = 0
          for (let i = 0; i < data.length; i++) if ((data[i] & 0x7c00) === 0x7c00) bad++
          isolation.push({ hidden: object.name || object.type, invalid: bad })
          object.visible = visible
        }
        report({ check: 'first invalid scene pixel', positions, camera: engine.camera.position.toArray(), isolation })
        render.call(this, renderer, write, read, ...args)
      }
    }
  }
  for (const planet of ['ocean', 'moon', 'terra']) {
    settings.values.planet = planet
    colony.setPlanet(planet)
    colony.update(0, 3, focus)
    for (const preset of ['low', 'balanced', 'high', 'ultra']) {
      for (const key of Object.keys(invalidByPass)) delete invalidByPass[key]
      Object.assign(settings.values, PRESETS[preset].values, { renderScale: 1 / devicePixelRatio })
      engine.applySettings()
      colony.onSettingsChanged(new Set(['shadows', 'ibl']), { world: true })
      colony.update(0, 3, focus)
      for (let i = 0; i < 3; i++) engine.renderFrame()
      const frames = []
      for (let i = 0; i < 4; i++) {
        engine.renderFrame()
        frames.push(pixels())
      }
      report({ planet, preset, frozenFrameDifferences: frames.slice(1).map((frame, i) => difference(frames[i], frame)), invalidByPass: { ...invalidByPass }, glError: gl.getError(), drawCalls: engine.renderer.info.render.calls })
      await nextFrame()
    }
  }
  for (const [planet, preset] of [['ocean', 'balanced'], ['ocean', 'high'], ['ocean', 'ultra'], ['terra', 'balanced']]) {
    for (const key of Object.keys(invalidByPass)) delete invalidByPass[key]
    settings.values.planet = planet
    Object.assign(settings.values, PRESETS[preset].values, { renderScale: 1 / devicePixelRatio })
    engine.applySettings()
    colony.onSettingsChanged(new Set(['planet', 'shadows', 'ibl']), { world: true })
    // A newly selected planet builds its own terrain; presets on the same planet need
    // an explicit rebuild to exercise their grass density and water tessellation too.
    colony.onSettingsChanged(new Set(), { world: true })
    for (let i = 0; i < 60; i++) {
      const angle = i * Math.PI / 30
      const distance = 10 + i * 0.9
      focus.set(Math.sin(angle) * 8, 0, Math.cos(angle) * 8)
      engine.camera.position.set(focus.x + Math.sin(angle) * distance, 4 + i * 0.4, focus.z + Math.cos(angle) * distance)
      engine.camera.lookAt(focus)
      setCurveView(focus, angle, CURVE_FULL * 0.45)
      engine.setFocusDistance(engine.camera.position.distanceTo(focus))
      colony.update(1 / 30, 3 + i / 30, focus)
      engine.renderFrame()
      if (i % 10 === 0) await nextFrame()
    }
    report({ check: 'HDR pixels stay finite during camera motion', planet, preset, invalidByPass: { ...invalidByPass }, glError: gl.getError(), reflections: { ...colony.reflections.stats } })
  }
  inspectHdr = false
  settings.values.planet = 'ocean'
  Object.assign(settings.values, PRESETS.balanced.values)
  engine.applySettings()
  colony.onSettingsChanged(new Set(['planet', 'shadows', 'ibl']), { world: true })
  colony.update(0, 5, focus)
  engine.camera.position.set(32, 27, 38)
  focus.set(0, 0, 0)
  engine.camera.lookAt(focus)
  setCurveView(focus, Math.atan2(32, 38), CURVE_FULL * 0.45)
  engine.setFocusDistance(engine.camera.position.length())
  settings.values.renderScale = 2 / devicePixelRatio
  engine.resize()
  for (let i = 0; i < 5; i++) engine.renderFrame()
  const timings = []
  for (let batch = 0; batch < 3; batch++) {
    await nextFrame()
    gl.finish()
    const start = performance.now()
    for (let i = 0; i < 20; i++) engine.renderFrame()
    gl.finish()
    timings.push(+((performance.now() - start) / 20).toFixed(2))
  }
  report({ check: 'Archipelago Balanced render time, 1280x800, fixed scene, GPU synchronized (ms/frame)', timings })
  engine.renderFrame()
  const before = pixels()
  engine.resize()
  const after = pixels()
  report({ check: 'unchanged resize preserves the rendered canvas', ...difference(before, after), allZero: after.every(v => v === 0) })
  engine.renderFrame()
  engine.perf.fps = 30
  engine._slow = 2
  engine._lastGovern = -Infinity
  engine._governQuality()
  report({ check: 'adaptive resize preserves the previous frame until drawing', allZero: pixels().every(v => v === 0) })
  engine.renderFrame()
  report({ check: 'adaptive resize draws at the new size', sizeMatches: engine.canvas.width === engine.viewport.bw && engine.canvas.height === engine.viewport.bh, allZero: pixels().every(v => v === 0) })
  // Measure the additional capture work near a real agent, with the full colony intact.
  const subject = colony.astronauts._drawnAgents[0]
  focus.copy(subject.pos); focus.y += 0.9
  engine.camera.position.copy(focus).add(new THREE.Vector3(2, 1.5, 5))
  engine.camera.lookAt(focus); engine.camera.updateMatrixWorld()
  setCurveView(focus, Math.atan2(2, 5), CURVE_FULL * 0.45)
  colony.sky.update(0, 7, engine.camera)
  engine.renderFrame()
  colony.reflections.invalidate()
  const captureTimes = [], captureCalls = []
  for (let i = 0; i < 18; i++) {
    if (colony.reflections.face < 0) {
      colony.reflections.lastCapture = -Infinity; colony.reflections.blend = 1
    }
    gl.finish()
    const start = performance.now()
    colony.reflections.update(1 / 60, focus, engine.camera)
    gl.finish()
    captureTimes.push(+(performance.now() - start).toFixed(2))
    captureCalls.push(colony.reflections.stats.lastFaceCalls)
    engine.renderFrame()
    if (i % 6 === 5) await nextFrame()
  }
  report({ check: 'Archipelago Balanced additional reflection capture, one face per frame, GPU synchronized',
    milliseconds: captureTimes, drawCalls: captureCalls, reflections: { ...colony.reflections.stats }, glError: gl.getError() })
    const passed = results.every(r => !r.error && r.passed !== false && !r.glError && !r.allZero && r.sizeMatches !== false &&
    (!r.invalidByPass || !Object.keys(r.invalidByPass).length) &&
    (!r.frozenFrameDifferences || r.frozenFrameDifferences.every(d => d.changedPercent === 0)))
  report({ complete: true, passed })
} catch (error) {
  report({ error: error.stack })
}
