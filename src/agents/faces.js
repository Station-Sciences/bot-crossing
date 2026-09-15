import * as THREE from 'three'

/**
 * The little digital faces.
 *
 * Every astronaut's visor is a tiny screen showing one of sixteen expressions. They are all
 * drawn once into a single 4×4 canvas atlas as a white-on-black *mask*, never as finished
 * artwork — the colour arrives per-astronaut at draw time, so one 512px texture gives every
 * agent its own eye colour without a second byte of memory.
 *
 * The mask is read out of the red channel and used to blend between the dark screen and the
 * astronaut's glow colour, which is why the atlas is deliberately pure black and pure white.
 */

export const FRAME_COLS = 4
export const FRAME_ROWS = 4

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
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const cell = size / FRAME_COLS

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)

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
const EYE_Y = 0.42

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
  ctx.globalAlpha = 0.42
  dot(ctx, 0.14, y, 0.05)
  dot(ctx, 0.86, y, 0.05)
  ctx.restore()
}

function zzz(ctx) {
  ctx.lineWidth = 0.035
  const z = (x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x - s, y - s)
    ctx.lineTo(x + s, y - s)
    ctx.lineTo(x - s, y + s)
    ctx.lineTo(x + s, y + s)
    ctx.stroke()
  }
  z(0.845, 0.2, 0.045)
  z(0.93, 0.33, 0.03)
}

const DRAW = {
  idle(ctx) {
    eye(ctx, EYE_L, EYE_Y, 0.17, 0.22)
    eye(ctx, EYE_R, EYE_Y, 0.17, 0.22)
    smile(ctx, 0.66, 0.26, 0.13)
  },

  blink(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.19, false)
    arcEye(ctx, EYE_R, EYE_Y, 0.19, false)
    smile(ctx, 0.66, 0.26, 0.13)
  },

  happy(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.21, true, 0.06)
    arcEye(ctx, EYE_R, EYE_Y, 0.21, true, 0.06)
    grin(ctx, 0.62, 0.3, 0.12)
    blush(ctx, 0.54)
  },

  // Focused: eyes squashed to a determined squint, mouth set in a small line.
  work(ctx) {
    eye(ctx, EYE_L, EYE_Y + 0.01, 0.19, 0.12)
    eye(ctx, EYE_R, EYE_Y + 0.01, 0.19, 0.12)
    smile(ctx, 0.68, 0.16, 0.03)
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
    eye(ctx, EYE_L, EYE_Y, 0.2, 0.26)
    eye(ctx, EYE_R, EYE_Y, 0.2, 0.26)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    dot(ctx, EYE_L + 0.045, EYE_Y - 0.06, 0.032)
    dot(ctx, EYE_R + 0.045, EYE_Y - 0.06, 0.032)
    ctx.restore()
    openMouth(ctx, 0.69, 0.1, 0.1)
  },

  alert(ctx) {
    eye(ctx, EYE_L, EYE_Y, 0.23, 0.29)
    eye(ctx, EYE_R, EYE_Y, 0.23, 0.29)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    dot(ctx, EYE_L + 0.05, EYE_Y - 0.07, 0.036)
    dot(ctx, EYE_R + 0.05, EYE_Y - 0.07, 0.036)
    ctx.restore()
    openMouth(ctx, 0.71, 0.15, 0.13)
  },

  error(ctx) {
    crossEye(ctx, EYE_L, EYE_Y, 0.17)
    crossEye(ctx, EYE_R, EYE_Y, 0.17)
    // A wobbly mouth — three little humps.
    ctx.lineWidth = 0.05
    ctx.beginPath()
    ctx.moveTo(0.36, 0.68)
    ctx.quadraticCurveTo(0.43, 0.61, 0.5, 0.68)
    ctx.quadraticCurveTo(0.57, 0.75, 0.64, 0.68)
    ctx.stroke()
  },

  sleep(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.19, false)
    arcEye(ctx, EYE_R, EYE_Y, 0.19, false)
    openMouth(ctx, 0.69, 0.09, 0.11)
    zzz(ctx)
  },

  wink(ctx) {
    arcEye(ctx, EYE_L, EYE_Y, 0.2, true, 0.06)
    eye(ctx, EYE_R, EYE_Y, 0.17, 0.22)
    smile(ctx, 0.66, 0.28, 0.15)
    blush(ctx, 0.54)
  },

  love(ctx) {
    heartEye(ctx, EYE_L, EYE_Y, 0.15)
    heartEye(ctx, EYE_R, EYE_Y, 0.15)
    grin(ctx, 0.63, 0.26, 0.1)
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
    grin(ctx, 0.6, 0.34, 0.16)
    blush(ctx, 0.52)
  },

  // Booting up: a scanning bar, shown for the first moment out of the ship.
  boot(ctx) {
    ctx.globalAlpha = 0.55
    for (let i = 0; i < 4; i++) ctx.fillRect(0.16, 0.3 + i * 0.06, 0.68, 0.022)
    ctx.globalAlpha = 1
    ctx.fillRect(0.16, 0.62, 0.4, 0.055)
    ctx.globalAlpha = 0.3
    ctx.fillRect(0.56, 0.62, 0.28, 0.055)
  },

  sad(ctx) {
    eye(ctx, EYE_L, EYE_Y + 0.02, 0.16, 0.19)
    eye(ctx, EYE_R, EYE_Y + 0.02, 0.16, 0.19)
    // Droopy brows.
    ctx.lineWidth = 0.045
    ctx.beginPath()
    ctx.moveTo(EYE_L - 0.1, EYE_Y - 0.17)
    ctx.lineTo(EYE_L + 0.08, EYE_Y - 0.12)
    ctx.moveTo(EYE_R + 0.1, EYE_Y - 0.17)
    ctx.lineTo(EYE_R - 0.08, EYE_Y - 0.12)
    ctx.stroke()
    smile(ctx, 0.72, 0.24, -0.11)
  },
}

/** Eyes rolled up and to the side, with a growing run of dots. */
function thinking(ctx, dots) {
  eye(ctx, EYE_L, EYE_Y - 0.03, 0.16, 0.19)
  eye(ctx, EYE_R, EYE_Y - 0.03, 0.16, 0.19)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  dot(ctx, EYE_L - 0.03, EYE_Y - 0.09, 0.045)
  dot(ctx, EYE_R - 0.03, EYE_Y - 0.09, 0.045)
  ctx.restore()
  for (let i = 0; i < dots; i++) dot(ctx, 0.38 + i * 0.12, 0.69, 0.032)
}
