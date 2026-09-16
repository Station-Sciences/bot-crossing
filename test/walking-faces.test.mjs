import test from 'node:test'
import assert from 'node:assert/strict'
import { animateFace as face } from '../src/agents/face-animation.js'
import { FACE, FACE_LOOPS, FRAME_COLS, FRAME_ROWS, walkingFaceAt } from '../src/agents/faces.js'

const walker = (values = {}) => ({
  state: 'walking', status: 'idle', stateAge: 3, groundSpeed: 2,
  faceTimer: 0, faceIndex: 0, blinkAt: 100, walkFaceTime: 0,
  walkFaceHold: 0, walkPersonality: 0, loop: null, ...values,
})

test('boot becomes a cheerful walk, then restores the destination status on arrival', () => {
  for (const status of ['sleeping', 'working', 'waiting']) {
    const a = walker({ state: 'spawning', stateAge: 0.2, status, loop: FACE_LOOPS[status] })
    face(a, 1 / 60); assert.equal(a.faceFrame, FACE.boot)
    a.stateAge = 1; face(a, 1 / 60); assert.equal(a.faceFrame, FACE.stroll)
    a.state = 'walking'; face(a, 1 / 60); assert.ok(a.faceFrame >= FACE.stroll)
    // Even residual speed cannot delay the settled status.
    a.state = 'at-site'; face(a, 1 / 60)
    assert.ok(FACE_LOOPS[status].includes(a.faceFrame), status)
    assert.equal(a.walkFaceHold, 0)
  }
})

test('idle wandering smiles, work rounds and error states retain their meaning', () => {
  const idle = walker({ state: 'at-site' }); face(idle, 1 / 60)
  assert.equal(idle.faceFrame, FACE.stroll)
  for (const [state, status] of [['at-site', 'working'], ['walking', 'blocked'], ['spawning', 'broken']]) {
    const a = walker({ state, status, loop: FACE_LOOPS[status], blinkAt: status === 'working' ? 100 : -0.05 })
    face(a, 1 / 60)
    assert.ok(FACE_LOOPS[status].includes(a.faceFrame), `${state}/${status}`)
  }
})

test('brief waypoint pauses do not flash a status face; a full stop returns to idle', () => {
  const a = walker({ walkFaceTime: 4 })
  face(a, 1 / 60); const before = a.faceFrame
  a.groundSpeed = 0
  face(a, 0.1); face(a, 0.1)
  assert.equal(a.faceFrame, before)
  face(a, 0.15)
  assert.equal(a.faceFrame, FACE.idle)
  a.groundSpeed = 2; face(a, 1 / 60)
  assert.ok(a.faceFrame >= FACE.stroll)
})

test('walking timing is frame-rate independent, individual, and respects reduced motion', () => {
  const snapshots = []
  for (const fps of [30, 60, 120]) {
    const a = walker({ walkPersonality: 0.37 })
    for (let i = 0; i < 11 * fps; i++) face(a, 1 / fps)
    snapshots.push(a.faceFrame)
    assert.ok(Math.abs(a.walkFaceTime - 11) < 1e-9)
  }
  assert.equal(new Set(snapshots).size, 1)
  assert.ok(new Set([0, 0.2, 0.5, 0.7].map(p => walkingFaceAt(2, p))).size >= 3)
  const a = walker(); face(a, 1, 0.35)
  assert.equal(a.walkFaceTime, 0.35)
})

test('closed happy eyes preserve their whistling mouth during blinks', () => {
  const whistle = walker({ walkFaceTime: 4, blinkAt: -0.01 })
  face(whistle, 1 / 60); assert.equal(whistle.faceFrame, FACE.whistleRight)
  const awake = walker({ walkFaceTime: 12, blinkAt: -0.01 })
  face(awake, 1 / 60); assert.equal(awake.faceFrame, FACE.strollBlink)
  for (const [time, expected] of [[14, FACE.strollBlinkLeft], [17, FACE.strollBlinkRight]]) {
    const glance = walker({ walkFaceTime: time, blinkAt: -0.01 })
    face(glance, 1 / 60); assert.equal(glance.faceFrame, expected)
  }
})

test('walking sequence includes every mouth position and smile, all within the atlas', () => {
  const frames = new Set()
  for (let t = 0; t < 34; t += 0.05) frames.add(walkingFaceAt(t, 0))
  for (const frame of [FACE.whistleLeft, FACE.whistle, FACE.whistleRight, FACE.stroll, FACE.strollGrin, FACE.strollOpen, FACE.strollLookLeft, FACE.strollLookRight]) {
    assert.ok(frames.has(frame))
  }
  assert.equal(new Set(Object.values(FACE)).size, Object.keys(FACE).length)
  for (const frame of Object.values(FACE)) assert.ok(frame >= 0 && frame < FRAME_COLS * FRAME_ROWS)
})
