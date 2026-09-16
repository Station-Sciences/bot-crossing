import * as THREE from 'three'

/**
 * The little digital faces.
 *
 * Every astronaut's visor is a tiny screen showing a status or walking expression. They are
 * drawn once into a single 4×7 canvas atlas as a white-on-black *mask*, never as finished
 * artwork — the colour arrives per-astronaut at draw time, so one shared atlas gives every
 * agent its own eye colour without a second byte of memory.
 *
 * The mask is read out of the red channel and used to blend between the dark screen and the
 * astronaut's glow colour, which is why the atlas is deliberately pure black and pure white.
 */

export const FRAME_COLS = 4
export const FRAME_ROWS = 7

/** Frame ids, in atlas order. The index is what gets pushed to the GPU per instance. */
export const FACE = {
  idle: 0,
  blink: 1,
  happy: 2,
  work: 3,
  think1: 4,
  think2: 5,
  think3: 6,
  wait: 7,
  alert: 8,
  error: 9,
  sleep: 10,
  wink: 11,
  love: 12,
  cheer: 13,
  boot: 14,
  sad: 15,
  stroll: 16,
  whistleLeft: 17,
  whistle: 18,
  whistleRight: 19,
  strollOpen: 20,
  strollBlink: 21,
  strollGrin: 22,
  strollLookLeft: 23,
  strollLookRight: 24,
  strollBlinkLeft: 25,
  strollBlinkRight: 26,
}

// Long, quiet holds with the occasional change of mood. Mouth positions go through the
// centre instead of jumping from cheek to cheek. Each bot gets its own offset and pace;
// this is sampled from time, never advanced by a frame counter or a per-frame random roll.
const STROLL_SEQUENCE = [
  [2.6, FACE.stroll], [4.2, FACE.whistleRight], [5.8, FACE.whistle],
  [7.3, FACE.whistleLeft], [10, FACE.stroll], [11.4, FACE.strollOpen],
  [13.1, FACE.strollLookLeft], [14.2, FACE.strollOpen], [16, FACE.strollLookRight],
  [17.2, FACE.strollOpen], [19.4, FACE.strollGrin], [21, FACE.stroll],
  [22.7, FACE.whistle], [24.2, FACE.whistleRight], [27, FACE.stroll],
]

/** `personality` is a stable per-agent value in [0, 1). No textures change at runtime. */
export function walkingFaceAt(seconds, personality) {
  const t = (seconds * (0.88 + personality * 0.24) + personality * 27) % 27
  for (const [end, face] of STROLL_SEQUENCE) if (t < end) return face
  return FACE.stroll
}

/** Little loops the agent code plays instead of picking single frames. */
export const FACE_LOOPS = {
  thinking: [FACE.think1, FACE.think2, FACE.think3, FACE.think2],
  working: [FACE.work, FACE.work, FACE.work, FACE.happy],
  celebrating: [FACE.cheer, FACE.happy, FACE.cheer, FACE.love],
  waiting: [FACE.wait, FACE.wait, FACE.alert, FACE.wait],
  broken: [FACE.error, FACE.error, FACE.sad, FACE.error],
  // The status is called `blocked`; the loop was only ever filed under `broken`, so a
  // blocked astronaut wore the idle face.
  blocked: [FACE.error, FACE.error, FACE.sad, FACE.error],
  sleeping: [FACE.sleep],
}

export function buildFaceAtlas(size = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  // Keep the existing pixels per expression when adding rows. The atlas is rectangular,
  // not rescaled into a square that would soften all the already-approved faces.
  canvas.height = size / FRAME_COLS * FRAME_ROWS
  const ctx = canvas.getContext('2d')
  const cell = size / FRAME_COLS

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  for (const [name, index] of Object.entries(FACE)) {
    const cx = (index % FRAME_COLS) * cell
    const cy = Math.floor(index / FRAME_COLS) * cell
    ctx.save()
    ctx.translate(cx, cy)
    // Every drawing routine works in a 0..1 box, so the atlas can change size freely.
    ctx.scale(cell, cell)
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Large solid eyes should not flood the whole visor with bloom. Sleep keeps its
    // existing luminance; each larger expression gets a restrained phosphor drive.
    ctx.globalAlpha = ({ wait: 0.60, alert: 0.55, happy: 0.85, love: 0.75, cheer: 0.85 })[name] ?? (index >= FACE.stroll ? 0.82 : 1)
    DRAW[name](ctx)
    ctx.restore()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace // it is a mask, not colour — no sRGB decode
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  // Clamping stops a frame from bleeding into its neighbour when mips get small.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

// ── drawing helpers, all in a 0..1 unit box ────────────────────────────────────────────

const EYE_L = 0.31
const EYE_R = 0.69
const EYE_Y = 0.55

function dot(ctx, x, y, r) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

/** A rounded capsule eye — the default cute shape, taller than it is wide. */
function eye(ctx, x, y, w, h) {
  const r = Math.min(w, h) / 2
  ctx.beginPath()
  ctx.moveTo(x - w / 2 + r, y - h / 2)
  ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r)
  ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r)
  ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r)
  ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r)
  ctx.closePath()
  ctx.fill()
}

/** An arc eye: `up` gives a happy `^`, down gives a sleepy `‿`. */
function arcEye(ctx, x, y, w, up, thickness = 0.055) {
  ctx.lineWidth = thickness
  ctx.beginPath()
  if (up) {
    ctx.moveTo(x - w / 2, y + w * 0.32)
    ctx.quadraticCurveTo(x, y - w * 0.42, x + w / 2, y + w * 0.32)
  } else {
    ctx.moveTo(x - w / 2, y - w * 0.28)
    ctx.quadraticCurveTo(x, y + w * 0.42, x + w / 2, y - w * 0.28)
  }
  ctx.stroke()
}

function crossEye(ctx, x, y, w) {
  ctx.lineWidth = 0.055
  const h = w / 2
  ctx.beginPath()
  ctx.moveTo(x - h, y - h)
  ctx.lineTo(x + h, y + h)
  ctx.moveTo(x + h, y - h)
  ctx.lineTo(x - h, y + h)
  ctx.stroke()
}

function heartEye(ctx, x, y, s) {
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.55)
  ctx.bezierCurveTo(x - s * 1.15, y - s * 0.18, x - s * 0.5, y - s * 0.95, x, y - s * 0.32)
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.95, x + s * 1.15, y - s * 0.18, x, y + s * 0.55)
  ctx.fill()
}

/** Mouth curve. `curve` > 0 smiles, < 0 frowns, 0 is a flat line. */
function smile(ctx, y, w, curve, thickness = 0.05) {
  ctx.lineWidth = thickness
  ctx.beginPath()
  ctx.moveTo(0.5 - w / 2, y)
  ctx.quadraticCurveTo(0.5, y + curve, 0.5 + w / 2, y)
  ctx.stroke()
}

/** An open mouth — the `o` of surprise, or a big grin when wide. */
function openMouth(ctx, y, w, h) {
  ctx.beginPath()
  ctx.ellipse(0.5, y, w / 2, h / 2, 0, 0, Math.PI * 2)
  ctx.fill()
}

/** The lower half of an ellipse: a proper open-wide happy grin. */
function grin(ctx, y, w, h) {
  ctx.beginPath()
  ctx.ellipse(0.5, y, w / 2, h, 0, 0, Math.PI)
  ctx.fill()
}

function blush(ctx, y) {
  ctx.save()
  ctx.globalAlpha *= 0.42
  dot(ctx, 0.14, y, 0.05)
  dot(ctx, 0.86, y, 0.05)
  ctx.restore()
}

/** Tapered crescent, rather than a thick uniform stroke. The visual centre sits
 * below the middle of the round display, leaving clear glass above the eyes. */
function crescentEye(ctx, x, y) {
  ctx.beginPath()
  ctx.moveTo(x - 0.118, y - 0.016)
  ctx.bezierCurveTo(x - 0.134, y - 0.040, x - 0.106, y - 0.057, x - 0.090, y - 0.035)
  ctx.quadraticCurveTo(x, y + 0.036, x + 0.090, y - 0.035)
  ctx.bezierCurveTo(x + 0.109, y - 0.058, x + 0.133, y - 0.038, x + 0.117, y - 0.014)
  ctx.quadraticCurveTo(x, y + 0.118, x - 0.118, y - 0.016)
  ctx.fill()
}

/** Soft upside-down U eyes, with more arch than the squeezed celebration expression. */
function contentEye(ctx, x) {
  ctx.lineWidth = 0.048
  ctx.beginPath()
  ctx.moveTo(x - 0.095, EYE_Y + 0.035)
  ctx.bezierCurveTo(x - 0.055, EYE_Y - 0.105, x + 0.055, EYE_Y - 0.105, x + 0.095, EYE_Y + 0.035)
  ctx.stroke()
}

function contentEyes(ctx) {
  contentEye(ctx, EYE_L)
  contentEye(ctx, EYE_R)
}

function whistle(ctx, x, y = 0.75) {
  contentEyes(ctx)
  dot(ctx, x, y, 0.038)
}

/** Move the display's whole gaze, like a small robot checking either side of its path. */
function lookAround(ctx, direction) {
  const shift = direction * 0.065
  eye(ctx, EYE_L + shift, EYE_Y, direction > 0 ? 0.09 : 0.105, 0.125)
  eye(ctx, EYE_R + shift, EYE_Y, direction < 0 ? 0.09 : 0.105, 0.125)
  ctx.save(); ctx.translate(direction * 0.025, 0)
  smile(ctx, 0.725, 0.19, 0.07, 0.038)
  ctx.restore()
}

function walkingBlink(ctx, direction) {
  const shift = direction * 0.065
  arcEye(ctx, EYE_L + shift, EYE_Y, 0.16, false, 0.038)
  arcEye(ctx, EYE_R + shift, EYE_Y, 0.16, false, 0.038)
  ctx.save(); ctx.translate(direction * 0.025, 0)
  smile(ctx, 0.725, 0.19, 0.07, 0.038)
  ctx.restore()
}

const DRAW = {
  stroll(ctx) {
    contentEyes(ctx)
    smile(ctx, 0.725, 0.19, 0.07, 0.038)
  },
  whistleLeft(ctx) { whistle(ctx, 0.40, 0.735) },
  whistle(ctx) { whistle(ctx, 0.50) },
  whistleRight(ctx) { whistle(ctx, 0.60, 0.735) },
  strollOpen(ctx) {
    lookAround(ctx, 0)
  },
  strollBlink(ctx) { walkingBlink(ctx, 0) },
  strollBlinkLeft(ctx) { walkingBlink(ctx, -1) },
  strollBlinkRight(ctx) { walkingBlink(ctx, 1) },
  strollGrin(ctx) {
    contentEyes(ctx)
    grin(ctx, 0.72, 0.20, 0.06)
  },
  strollLookLeft(ctx) { lookAround(ctx, -1) },
  strollLookRight(ctx) { lookAround(ctx, 1) },
  idle(ctx) {
    eye(ctx, EYE_L, EYE_Y, 0.145, 0.18)
    eye(ctx, EYE_R, EYE_Y, 0.145, 0.18)
    smile(ctx, 0.73, 0.23, 0.09)
  },

  blink(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.19, false)
    arcEye(ctx, EYE_R, EYE_Y, 0.19, false)
    smile(ctx, 0.73, 0.23, 0.09)
  },

  happy(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.20, true, 0.055)
    arcEye(ctx, EYE_R, EYE_Y, 0.20, true, 0.055)
    grin(ctx, 0.71, 0.26, 0.085)
    blush(ctx, 0.65)
  },

  // Focused: eyes squashed to a determined squint, mouth set in a small line.
  work(ctx) {
    eye(ctx, EYE_L, EYE_Y + 0.01, 0.18, 0.095)
    eye(ctx, EYE_R, EYE_Y + 0.01, 0.18, 0.095)
    smile(ctx, 0.73, 0.15, 0.025)
  },

  think1(ctx) {
    thinking(ctx, 1)
  },
  think2(ctx) {
    thinking(ctx, 2)
  },
  think3(ctx) {
    thinking(ctx, 3)
  },

  // Waiting on you: wide open eyes with a highlight, small patient `o`.
  wait(ctx) {
    eye(ctx, EYE_L, EYE_Y, 0.155, 0.20)
    eye(ctx, EYE_R, EYE_Y, 0.155, 0.20)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    dot(ctx, EYE_L + 0.03, EYE_Y - 0.045, 0.024)
    dot(ctx, EYE_R + 0.03, EYE_Y - 0.045, 0.024)
    ctx.restore()
    openMouth(ctx, 0.755, 0.075, 0.075)
  },

  alert(ctx) {
    eye(ctx, EYE_L, EYE_Y, 0.17, 0.22)
    eye(ctx, EYE_R, EYE_Y, 0.17, 0.22)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    dot(ctx, EYE_L + 0.035, EYE_Y - 0.05, 0.026)
    dot(ctx, EYE_R + 0.035, EYE_Y - 0.05, 0.026)
    ctx.restore()
    openMouth(ctx, 0.755, 0.09, 0.085)
  },

  error(ctx) {
    crossEye(ctx, EYE_L, EYE_Y, 0.17)
    crossEye(ctx, EYE_R, EYE_Y, 0.17)
    // A wobbly mouth — three little humps.
    ctx.lineWidth = 0.05
    ctx.beginPath()
    ctx.moveTo(0.38, 0.74)
    ctx.quadraticCurveTo(0.44, 0.68, 0.5, 0.74)
    ctx.quadraticCurveTo(0.56, 0.80, 0.62, 0.74)
    ctx.stroke()
  },

  sleep(ctx) {
    crescentEye(ctx, 0.29, 0.55)
    crescentEye(ctx, 0.71, 0.55)
    dot(ctx, 0.5, 0.755, 0.043)
  },

  wink(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.2, true, 0.06)
    eye(ctx, EYE_R, EYE_Y, 0.145, 0.18)
    smile(ctx, 0.73, 0.24, 0.09)
    blush(ctx, 0.65)
  },

  love(ctx) {
    heartEye(ctx, EYE_L, EYE_Y, 0.13)
    heartEye(ctx, EYE_R, EYE_Y, 0.13)
    grin(ctx, 0.72, 0.24, 0.075)
  },

  cheer(ctx) {
    // `> <` squeezed-shut delight.
    ctx.lineWidth = 0.055
    ctx.beginPath()
    ctx.moveTo(EYE_L - 0.09, EYE_Y - 0.08)
    ctx.lineTo(EYE_L + 0.04, EYE_Y)
    ctx.lineTo(EYE_L - 0.09, EYE_Y + 0.08)
    ctx.moveTo(EYE_R + 0.09, EYE_Y - 0.08)
    ctx.lineTo(EYE_R - 0.04, EYE_Y)
    ctx.lineTo(EYE_R + 0.09, EYE_Y + 0.08)
    ctx.stroke()
    grin(ctx, 0.71, 0.27, 0.09)
    blush(ctx, 0.65)
  },

  // Booting up: a scanning bar, shown for the first moment out of the ship.
  boot(ctx) {
    ctx.globalAlpha = 0.55
    for (let i = 0; i < 4; i++) ctx.fillRect(0.16, 0.40 + i * 0.06, 0.68, 0.022)
    ctx.globalAlpha = 1
    ctx.fillRect(0.16, 0.73, 0.4, 0.055)
    ctx.globalAlpha = 0.3
    ctx.fillRect(0.56, 0.73, 0.28, 0.055)
  },

  sad(ctx) {
    eye(ctx, EYE_L, EYE_Y + 0.01, 0.145, 0.17)
    eye(ctx, EYE_R, EYE_Y + 0.01, 0.145, 0.17)
    // Droopy brows.
    ctx.lineWidth = 0.045
    ctx.beginPath()
    ctx.moveTo(EYE_L - 0.1, EYE_Y - 0.12)
    ctx.lineTo(EYE_L + 0.08, EYE_Y - 0.17)
    ctx.moveTo(EYE_R + 0.1, EYE_Y - 0.12)
    ctx.lineTo(EYE_R - 0.08, EYE_Y - 0.17)
    ctx.stroke()
    smile(ctx, 0.79, 0.22, -0.09)
  },
}

/** Eyes rolled up and to the side, with a growing run of dots. */
function thinking(ctx, dots) {
  eye(ctx, EYE_L, EYE_Y - 0.025, 0.145, 0.18)
  eye(ctx, EYE_R, EYE_Y - 0.025, 0.145, 0.18)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
  dot(ctx, EYE_L - 0.03, EYE_Y - 0.09, 0.045)
  dot(ctx, EYE_R - 0.03, EYE_Y - 0.09, 0.045)
  ctx.restore()
  for (let i = 0; i < dots; i++) dot(ctx, 0.38 + i * 0.12, 0.75, 0.032)
}
