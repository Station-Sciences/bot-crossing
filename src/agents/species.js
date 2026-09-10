/**
 * Which species a thread's astronaut belongs to.
 *
 * Everything here is decided by the thread id's hash, the same way the suit tone already
 * is — deterministic, so the same thread steps off the ship as the same creature every
 * run, with nothing to store. A species is only a skin tint, a stature and a row block of
 * the face atlas: the meshes, materials and draw calls are the ones every astronaut
 * already shares, which is what makes a mixed crew free to render.
 *
 * This module stays pure data and pure functions — no THREE, no DOM — so the mapping can
 * be checked under plain node.
 */

/**
 * Skin palettes sit deeper than the suit whites so a species reads at the isometric rest
 * distance, but stay muted: saturated skin would compete with the status trim, and the
 * trim is information.
 *
 * `tones: null` means "skin is the suit" — a human's body is the suit tone it always was,
 * so a colony with no aliens in it renders exactly as before species existed.
 *
 * `faceLayout` indexes EYE_LAYOUTS in faces.js; the pairings lean on each other — the one
 * big eye goes on the short one, the extra eye on the tall one — so height and face agree
 * about which species you are looking at.
 */
export const SPECIES = [
  { tones: null, height: 1, faceLayout: 0 },
  // Short and sage-green, one big eye.
  { tones: [0xaebfa4, 0x9db3a0, 0xbcc8ab], height: 0.88, faceLayout: 1 },
  // Tall and warm ochre, three eyes.
  { tones: [0xd8b98c, 0xcaa87a, 0xe0c69e], height: 1.12, faceLayout: 2 },
  // Pale blue, eyes set wide.
  { tones: [0xb6c6d8, 0xa7bbd0, 0xc3cfdf], height: 0.96, faceLayout: 3 },
]

/**
 * Half the crew stays human. Humans are the baseline the aliens read against — a crowd
 * that is mostly alien has no baseline, it is just a crowd — so the spread gives species
 * 0 half the table and splits the rest evenly.
 */
const SPREAD = [0, 0, 0, 1, 2, 3]

/**
 * Species index for an id hash. A different bit window from the suit pick (>>> 3) and the
 * skin pick (>>> 7), so a species is not welded to one suit tone.
 */
export function speciesFor(h) {
  return SPREAD[(h >>> 5) % SPREAD.length]
}

/** FNV-1a. Everything an astronaut is born with is carved out of this one number. */
export function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
