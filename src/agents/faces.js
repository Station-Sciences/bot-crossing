import * as THREE from 'three'

/**
 * The little digital faces.
 *
 * Every astronaut's visor is a tiny screen showing one of sixteen expressions. They are all
 * drawn once into a single canvas atlas as a white-on-black *mask*, never as finished
 * artwork — the colour arrives per-astronaut at draw time, so one texture gives every
 * agent its own eye colour without a second byte of memory.
 *
 * The mask is read out of the red channel and used to blend between the dark screen and the
 * astronaut's glow colour, which is why the atlas is deliberately pure black and pure white.
 *
 * Each species is a four-row block of the same sixteen expressions, redrawn with its own
 * eye layout — the drawing routines below take the layout as a parameter, so a new species
 * is a line in EYE_LAYOUTS, never sixteen hand-drawn frames. An agent selects its block by
 * adding `faceBase` (layout × FACE_COUNT) to the frame index; the row-major index math the
 * consumers already do then lands in the right block untouched.
 */

export const FRAME_COLS = 4

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

export const FACE_COUNT = Object.keys(FACE).length

/**
 * One entry per species face: where the eyes sit in the unit cell, and `s`, a size factor
 * every eye-shaped stroke is multiplied by. Layout 0 is the human face and its numbers are
 * load-bearing: they are the constants the sixteen expressions were originally authored
 * against, and with s = 1 every multiply below is exact — so the human rows come out
 * bit-identical to the pre-species atlas.
 *
 * Eyes are ordered left-to-right because a couple of expressions are handed (the wink is
 * always the first eye; chevrons and brows point toward the face's middle).
 */
export const EYE_LAYOUTS = [
  { eyes: [[0.31, 0.42], [0.69, 0.42]], s: 1 },
  // One big eye. Oversized on purpose: a lone human-sized eye reads as a smudge.
  { eyes: [[0.5, 0.42]], s: 1.4 },
  // Three eyes, smaller so the extra one fits above without touching the mouth work.
  { eyes: [[0.31, 0.44], [0.69, 0.44], [0.5, 0.28]], s: 0.8 },
  // Wide-set.
  { eyes: [[0.22, 0.4], [0.78, 0.4]], s: 0.92 },
]

export const FRAME_ROWS = (FACE_COUNT / FRAME_COLS) * EYE_LAYOUTS.length

/** Little loops the agent code plays instead of picking single frames. */
export const FACE_LOOPS = {
  thinking: [FACE.think1, FACE.think2, FACE.think3, FACE.think2],
  working: [FACE.work, FACE.work, FACE.work, FACE.happy],
  celebrating: [FACE.cheer, FACE.happy, FACE.cheer, FACE.love],
  waiting: [FACE.wait, FACE.wait, FACE.alert, FACE.wait],
  broken: [FACE.error, FACE.error, FACE.sad, FACE.error],
  sleeping: [FACE.sleep],
}

export function buildFaceAtlas(size = 512) {
  const canvas = document.createElement('canvas')
  const cell = size / FRAME_COLS
  // Taller, not denser: the species blocks stack below the human one, so a cell keeps the
  // pixels it always had and the human rows land at exactly their old coordinates.
  canvas.width = size
  canvas.height = cell * FRAME_ROWS
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  for (let l = 0; l < EYE_LAYOUTS.length; l++) {
    const layout = EYE_LAYOUTS[l]
    for (const [name, index] of Object.entries(FACE)) {
      const f = l * FACE_COUNT + index
      const cx = (f % FRAME_COLS) * cell
      const cy = Math.floor(f / FRAME_COLS) * cell
      ctx.save()
      ctx.translate(cx, cy)
      // Every drawing routine works in a 0..1 box, so the atlas can change size freely.
      ctx.scale(cell, cell)
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#fff'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      DRAW[name](ctx, layout)
      ctx.restore()
    }
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

/**
 * Which way a feature that has a direction should point, given where its eye sits. The
 * face's middle is the reference, not "left eye / right eye" — a centred eye has to pick a
 * side, and it picks the left form so a one-eyed cheer still reads as squeezed shut.
 */
const inward = (x) => (x <= 0.5 ? -1 : 1)

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

/**
 * The sixteen expressions, each drawn for whatever eye layout `L` it is handed. Eye
 * shapes, their offsets and their highlights scale by `L.s`; mouths, blush and the boot
 * screen do not — they are the part of an expression every species shares, which is what
 * keeps a status readable no matter who is showing it.
 */
const DRAW = {
  idle(ctx, L) {
    for (const [x, y] of L.eyes) eye(ctx, x, y, 0.17 * L.s, 0.22 * L.s)
    smile(ctx, 0.66, 0.26, 0.13)
  },

  blink(ctx, L) {
    for (const [x, y] of L.eyes) arcEye(ctx, x, y, 0.19 * L.s, false)
    smile(ctx, 0.66, 0.26, 0.13)
  },

  happy(ctx, L) {
    for (const [x, y] of L.eyes) arcEye(ctx, x, y, 0.21 * L.s, true, 0.06)
    grin(ctx, 0.62, 0.3, 0.12)
    blush(ctx, 0.54)
  },

  // Focused: eyes squashed to a determined squint, mouth set in a small line.
  work(ctx, L) {
    for (const [x, y] of L.eyes) eye(ctx, x, y + 0.01 * L.s, 0.19 * L.s, 0.12 * L.s)
    smile(ctx, 0.68, 0.16, 0.03)
  },

  think1(ctx, L) {
    thinking(ctx, L, 1)
  },
  think2(ctx, L) {
    thinking(ctx, L, 2)
  },
  think3(ctx, L) {
    thinking(ctx, L, 3)
  },

  // Waiting on you: wide open eyes with a highlight, small patient `o`.
  wait(ctx, L) {
    for (const [x, y] of L.eyes) eye(ctx, x, y, 0.2 * L.s, 0.26 * L.s)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    for (const [x, y] of L.eyes) dot(ctx, x + 0.045 * L.s, y - 0.06 * L.s, 0.032 * L.s)
    ctx.restore()
    openMouth(ctx, 0.69, 0.1, 0.1)
  },

  alert(ctx, L) {
    for (const [x, y] of L.eyes) eye(ctx, x, y, 0.23 * L.s, 0.29 * L.s)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    for (const [x, y] of L.eyes) dot(ctx, x + 0.05 * L.s, y - 0.07 * L.s, 0.036 * L.s)
    ctx.restore()
    openMouth(ctx, 0.71, 0.15, 0.13)
  },

  error(ctx, L) {
    for (const [x, y] of L.eyes) crossEye(ctx, x, y, 0.17 * L.s)
    // A wobbly mouth — three little humps.
    ctx.lineWidth = 0.05
    ctx.beginPath()
    ctx.moveTo(0.36, 0.68)
    ctx.quadraticCurveTo(0.43, 0.61, 0.5, 0.68)
    ctx.quadraticCurveTo(0.57, 0.75, 0.64, 0.68)
    ctx.stroke()
  },

  sleep(ctx, L) {
    for (const [x, y] of L.eyes) arcEye(ctx, x, y, 0.19 * L.s, false)
    openMouth(ctx, 0.69, 0.09, 0.11)
    zzz(ctx)
  },

  wink(ctx, L) {
    // The first eye winks, whoever it belongs to; the rest stay open.
    L.eyes.forEach(([x, y], i) => {
      if (i === 0) arcEye(ctx, x, y, 0.2 * L.s, true, 0.06)
      else eye(ctx, x, y, 0.17 * L.s, 0.22 * L.s)
    })
    smile(ctx, 0.66, 0.28, 0.15)
    blush(ctx, 0.54)
  },

  love(ctx, L) {
    for (const [x, y] of L.eyes) heartEye(ctx, x, y, 0.15 * L.s)
    grin(ctx, 0.63, 0.26, 0.1)
  },

  cheer(ctx, L) {
    // `> <` squeezed-shut delight, each chevron pointing in at the face's middle.
    ctx.lineWidth = 0.055
    ctx.beginPath()
    for (const [x, y] of L.eyes) {
      const out = inward(x)
      ctx.moveTo(x + out * 0.09 * L.s, y - 0.08 * L.s)
      ctx.lineTo(x - out * 0.04 * L.s, y)
      ctx.lineTo(x + out * 0.09 * L.s, y + 0.08 * L.s)
    }
    ctx.stroke()
    grin(ctx, 0.6, 0.34, 0.16)
    blush(ctx, 0.52)
  },

  // Booting up: a scanning bar, shown for the first moment out of the ship. The screen is
  // the same for every species — nobody's eyes are open yet.
  boot(ctx) {
    ctx.globalAlpha = 0.55
    for (let i = 0; i < 4; i++) ctx.fillRect(0.16, 0.3 + i * 0.06, 0.68, 0.022)
    ctx.globalAlpha = 1
    ctx.fillRect(0.16, 0.62, 0.4, 0.055)
    ctx.globalAlpha = 0.3
    ctx.fillRect(0.56, 0.62, 0.28, 0.055)
  },

  sad(ctx, L) {
    for (const [x, y] of L.eyes) eye(ctx, x, y + 0.02 * L.s, 0.16 * L.s, 0.19 * L.s)
    // Droopy brows.
    ctx.lineWidth = 0.045
    ctx.beginPath()
    for (const [x, y] of L.eyes) {
      const out = inward(x)
      ctx.moveTo(x + out * 0.1 * L.s, y - 0.17 * L.s)
      ctx.lineTo(x - out * 0.08 * L.s, y - 0.12 * L.s)
    }
    ctx.stroke()
    smile(ctx, 0.72, 0.24, -0.11)
  },
}

/** Eyes rolled up and to the side, with a growing run of dots. */
function thinking(ctx, L, dots) {
  for (const [x, y] of L.eyes) eye(ctx, x, y - 0.03 * L.s, 0.16 * L.s, 0.19 * L.s)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (const [x, y] of L.eyes) dot(ctx, x - 0.03 * L.s, y - 0.09 * L.s, 0.045 * L.s)
  ctx.restore()
  for (let i = 0; i < dots; i++) dot(ctx, 0.38 + i * 0.12, 0.69, 0.032)
}
