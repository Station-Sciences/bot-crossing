import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Indicators, BADGE } from '../src/agents/indicators.js'
import { createLabel } from '../src/world/plots.js'

/** Pixel regression: black geometry changes scene depth without changing its colour.
 * Neither the depth behind a badge nor the aperture may change the overlay image. */
export function checkOverlays(report) {
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, tiltShift: true,
    tiltShiftStrength: 0, tiltShiftAngle: 0, bloom: true, colorGrade: false,
    antialias: false, exposure: 1, fov: 38,
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  engine.renderer.setClearColor(0x000000, 1)
  engine.camera.position.set(0, 0, 12)
  engine.camera.lookAt(0, 0, 0)
  engine.setFocusDistance(12)
  const badges = new Indicators(engine.scene, settings, 2)
  badges.update([-2, 2].map(x => ({
    pos: new THREE.Vector3(x, -2, 0), scale: 1, state: 'at-site', phase: 0,
  })), 0, () => BADGE.waiting)
  const label = createLabel('Project label', 0x7ab9dd)
  label.visible = true
  label.material.opacity = 1
  label.position.set(0, -2, 0)
  engine.scene.add(label)
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: 0x000000 }))
  engine.scene.add(backdrop)
  const gl = engine.renderer.getContext()
  const capture = () => {
    engine.renderFrame()
    const bytes = new Uint8Array(engine.canvas.width * engine.canvas.height * 4)
    gl.readPixels(0, 0, engine.canvas.width, engine.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    return bytes
  }
  try {
    const cases = []
    for (const background of ['sky', 'focused building', 'distant building']) {
      backdrop.visible = background !== 'sky'
      backdrop.position.z = background === 'focused building' ? -0.2 : -40
      engine.tiltShift.enabled = false
      const sharp = capture()
      const visiblePixels = sharp.reduce((n, v, i) => n + (i % 4 !== 3 && v > 20 ? 1 : 0), 0)
      for (const [strength, angle] of [[0.2, 0], [1, 0], [1, 35]]) {
        engine.tiltShift.enabled = true
        engine.tiltShift.setStrength(strength)
        engine.tiltShift.setAngle(angle)
        // Exercise both read/write buffer parities, not just one lucky frame.
        for (let frame = 0; frame < 2; frame++) {
          const blurred = capture()
          let changed = 0
          for (let i = 0; i < sharp.length; i++) if (i % 4 !== 3 && sharp[i] !== blurred[i]) changed++
          cases.push({ background, strength, angle, frame, changedChannels: changed, visiblePixels })
        }
      }
    }
    // Guard against a false pass caused by disabling depth of field for the whole scene.
    badges.mesh.visible = false
    label.visible = false
    backdrop.visible = true
    backdrop.material.color.set(0xffffff)
    backdrop.scale.setScalar(0.03)
    backdrop.position.set(0, 0, -20)
    engine.tiltShift.enabled = false
    const worldSharp = capture()
    engine.tiltShift.enabled = true
    engine.tiltShift.setAngle(0)
    const worldBlurred = capture()
    let worldChangedChannels = 0
    for (let i = 0; i < worldSharp.length; i++) {
      if (i % 4 !== 3 && worldSharp[i] !== worldBlurred[i]) worldChangedChannels++
    }
    const glError = gl.getError()
    const passed = cases.every(c => c.changedChannels === 0 && c.visiblePixels > 100) && worldChangedChannels > 0 && glError === 0
    report({ check: 'badges and labels are unchanged by tilt-shift and background depth', passed, cases, worldChangedChannels, glError })
  } finally {
    badges.dispose()
    label.geometry.dispose()
    label.material.map?.dispose()
    label.material.dispose()
    backdrop.geometry.dispose()
    backdrop.material.dispose()
    engine.dispose()
    engine.canvas.remove()
  }
}
