import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Sky } from '../src/world/sky.js'
import { PLANETS } from '../src/world/planet.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor } from '../src/agents/crew.js'
import { FACE } from '../src/agents/faces.js'
import { installWorldCurve, setCurveView } from '../src/core/curve.js'

// Contact sheet from the production geometry/shaders, not a separate concept model.
// Synthetic agent only: no API, persistent settings or colony data are touched.
const walking = new URLSearchParams(location.search).has('walking')
const expressions = walking ? [
  ['stroll', 'Contented smile', 'idle'], ['whistleLeft', 'Whistle · left', 'idle'],
  ['whistle', 'Whistle · centre', 'idle'], ['whistleRight', 'Whistle · right', 'idle'],
  ['strollOpen', 'Looking · centre', 'idle'], ['strollLookLeft', 'Looking · left', 'idle'],
  ['strollLookRight', 'Looking · right', 'idle'], ['strollGrin', 'Little grin', 'idle'],
] : [
  ['idle', 'Idle', 'idle'], ['blink', 'Blink', 'idle'],
  ['happy', 'Happy', 'celebrating'], ['work', 'Working', 'working'],
  ['think1', 'Thinking · 1', 'idle'], ['think2', 'Thinking · 2', 'idle'],
  ['think3', 'Thinking · 3', 'idle'], ['wait', 'Waiting', 'waiting'],
  ['alert', 'Alert', 'waiting'], ['error', 'Error', 'blocked'],
  ['sleep', 'Sleeping', 'sleeping'], ['wink', 'Wink', 'celebrating'],
  ['love', 'Love', 'celebrating'], ['cheer', 'Cheering', 'celebrating'],
  ['boot', 'Starting up', 'spawning'], ['sad', 'Sad', 'blocked'],
]
const output = document.querySelector('#results')
if (walking) {
  document.querySelector('h1').textContent = 'Out for a stroll'
  document.querySelector('p').textContent = 'Walking smiles, whistles and curious glances · slow individual timing · no sound'
  document.querySelector('#mode').textContent = 'Status expressions'
  document.querySelector('#mode').href = '?'
  document.querySelector('#download').download = 'walking-face-sheet.png'
  document.querySelector('#sheet').alt = 'Eight walking expressions rendered with the actual game model'
}
try {
  await loadCrew()
  installWorldCurve(); setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, autoTime: false, clockTime: false,
    bloom: true, bloomStrength: 0.25, tiltShift: false, colorGrade: false,
    antialias: true, shadows: 'off', fov: 30, exposure: 1, ibl: true, iblIntensity: 1,
  })
  const engine = new Engine(settings).mount(document.querySelector('#render'))
  engine.renderer.setClearColor(0x070d16)
  const sky = new Sky(engine.scene, settings, engine.renderer)
  sky.setPlanet(PLANETS.ocean); sky.setTime(0.34)
  engine.camera.position.set(0, 1.02, 1.8)
  engine.camera.lookAt(0, 0.94, 0); engine.camera.updateMatrixWorld()
  sky.update(0, 0, engine.camera)
  sky._refreshEnvironment(true)
  // Keep the same lighting/reflections, but use a quiet background for comparisons.
  sky.dome.visible = false; sky.stars.visible = false; sky.companion.visible = false
  const crew = new Astronauts(engine.scene, settings), rig = crewRig()
  crew.setRig(rig)
  crew._spawnAgent({ id: 'face-review', status: 'idle', site: new THREE.Vector3(), thread: {} }, false)
  const agent = crew.byId.get('face-review')
  agent.pos.set(0, 0, 0); agent.scale = 1; agent.phase = 0; agent.suit = 0xf3f2ef
  agent.clipKey = 'idle'; agent.frame = frameFor(rig.clips.idle, 0.4)
  const sheet = document.createElement('canvas')
  sheet.width = 1760; sheet.height = 160 + Math.ceil(expressions.length / 4) * 478
  const ctx = sheet.getContext('2d')
  let angled = false
  const render = () => {
    ctx.fillStyle = '#111b2b'; ctx.fillRect(0, 0, sheet.width, sheet.height)
    ctx.fillStyle = '#eff5ff'; ctx.font = '600 38px system-ui'
    ctx.fillText(walking ? 'Out for a stroll' : 'Character expressions', 36, 64)
    ctx.fillStyle = '#a8bdd6'; ctx.font = '21px system-ui'
    ctx.fillText('Game model / curved CRT / original suit / ' + (angled ? 'three-quarter' : 'front') + ' view', 36, 102)
    const frames = []
    for (const [i, [key, label, status]] of expressions.entries()) {
      agent.status = status; crew._applyStatus(agent, status)
      agent.faceFrame = FACE[key]; agent.yaw = angled ? 0.38 : 0
      crew._writeMatrices(0, 1)
      engine.renderer.setClearColor(0x070d16)
      engine.renderFrame()
      const x = 28 + i % 4 * 432, y = 132 + Math.floor(i / 4) * 478
      ctx.fillStyle = '#17253a'; ctx.fillRect(x, y, 408, 458)
      ctx.drawImage(engine.canvas, x + 4, y + 4, 400, 400)
      ctx.fillStyle = '#8ea8c9'; ctx.font = '18px system-ui'
      ctx.fillText(String(i + 1).padStart(2, '0'), x + 17, y + 433)
      ctx.fillStyle = '#eaf2ff'; ctx.font = '500 23px system-ui'
      ctx.fillText(label, x + 53, y + 434)
      frames.push({ expression: key, status, glError: engine.renderer.getContext().getError() })
    }
    const url = sheet.toDataURL('image/png')
    document.querySelector('#sheet').src = url
    document.querySelector('#download').href = url
    output.textContent = JSON.stringify({ ready: true, frames, drawCalls: engine.renderer.info.render.calls }, null, 2)
  }
  document.querySelector('#angle').onclick = e => {
    angled = !angled; e.target.textContent = angled ? 'Front view' : 'Three-quarter view'; render()
  }
  render()
} catch (error) { output.textContent = error.stack }
