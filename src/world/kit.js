import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The model kits — KayKit's *Space Base Bits* and *Forest Nature Pack*, plus a desert
 * outpost kit assembled from Kenney's *Space Kit* and Quaternius' *Ultimate Space Kit*
 * (all CC0), each packed into one glb by the tools under `tools/` and loaded exactly
 * once here.
 *
 * Their shared design is what makes them worth building on: every model in a pack UVs into
 * a single 1024px gradient atlas and therefore shares a single material, so a colony
 * assembled out of one collapses to the same one-draw-call-per-building shape the
 * procedural generators had. Nothing downstream needs to know a model came from a file
 * rather than a primitive — `part()` hands back a plain BufferGeometry with its node
 * transform already baked in.
 *
 * The base kit's atlas is an 8x4 grid of gradient swatches and every model UVs into it, so
 * a *cell index* is a stable name for a material. That is what lets the building shader
 * repaint one swatch — the gold trim band, cell 11 — into each repo's accent colour without
 * touching a texture or splitting the mesh.
 *
 * Kits keep separate part registries because they have separate atlases: a geometry can
 * only carry one material, so a habitat and a fir tree can never merge into one mesh.
 */

/** Columns and rows in the gradient atlas. */
export const ATLAS = { cols: 8, rows: 4 }

/**
 * Cells worth naming. Everything else is structure and stays the colour Kay painted it.
 *
 * `TRIM` is the gold band that runs round the habitats, edges the airlocks and fills the
 * window strips — the one swatch that reads as "this building's colour", which is why it
 * is the one the accent replaces and the one that lights up after dark.
 */
export const CELL = {
  WHITE: 1,
  GREY: 2,
  SLATE: 3,
  BLACK: 4,
  ROCK: 7,
  TRIM: 11,
  RED: 12,
  SOLAR_A: 28,
  SOLAR_B: 29,
}

/**
 * The desert kit's cells. Its atlas is *generated* — `tools/build-desert-kit.mjs` paints
 * these swatches and rewrites every model's UVs into them, so the two definitions must
 * stay in step. TRIM and GLASS sit in the base kit's TRIM and SOLAR_A slots on purpose:
 * the two atlases read alike, and TRIM is the accent/night-glow cell in both.
 */
export const DESERT_CELL = {
  PLASTER: 1,
  CLAY: 2,
  SHADE: 3,
  METAL: 4,
  TRIM: 11,
  GLASS: 28,
}

// Served straight out of `public/`, not bundled — a glb is opaque to Vite and there is
// nothing to gain from hashing a file the loader fetches by hand anyway.
const KITS = {
  /** Space Base Bits: every building, and the colony's hard surfaces. */
  base: { file: 'spacebase.glb', parts: new Map(), solo: new Map(), atlas: null },
  /** Forest Nature Pack: trees, bushes, grass, and the boulders on every world. */
  forest: { file: 'forest.glb', parts: new Map(), solo: new Map(), atlas: null },
  /** The desert outpost kit — Kenney + Quaternius models repainted adobe at build time. */
  desertbase: { file: 'desertbase.glb', parts: new Map(), solo: new Map(), atlas: null },
}

let loading = null

/**
 * Load every kit. Idempotent, and safe to call from several places — the first call owns
 * the requests and everybody else awaits the same promise.
 */
export function loadKit() {
  if (!loading) {
    const loader = new GLTFLoader()
    loading = Promise.all(
      Object.values(KITS).map((kit) =>
        loader.loadAsync(`${import.meta.env.BASE_URL}assets/${kit.file}`).then((gltf) => {
          gltf.scene.updateMatrixWorld(true)
          for (const node of gltf.scene.children) harvest(node, kit)
          kit.atlas = findAtlas(gltf.scene)
        })
      )
    ).then(() => KITS)
  }
  return loading
}

/**
 * Bake one node into geometry in its own local frame, twice.
 *
 * `parts` gets the node *with* everything under it, which is what a recipe usually wants —
 * a rover arrives with its wheels on. `solo` gets the node's own mesh alone, which is what
 * a recipe wants when a sub-part has to move independently: the pack names a turbine's
 * rotor and a garage's door separately precisely because those are the bits that turn and
 * slide, and a spinning rotor has to be built from a tower that has not already got one.
 *
 * Sub-nodes are harvested as parts in their own right as well.
 */
function harvest(node, kit) {
  const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert()
  const bake = (mesh) => {
    const geo = mesh.geometry.clone()
    // Into the *node's* frame, not the scene's, so a part drops in at its own origin.
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld))
    return normalize(geo)
  }

  const all = []
  node.traverse((child) => {
    if (child.isMesh) all.push(bake(child))
  })

  if (all.length) {
    const merged = all.length === 1 ? all[0].clone() : BufferGeometryUtils.mergeGeometries(all, false)
    merged.computeBoundingBox()
    kit.parts.set(node.name, merged)
  }
  if (node.isMesh) {
    const own = bake(node)
    own.computeBoundingBox()
    kit.solo.set(node.name, own)
  }
  all.forEach((g) => g.dispose())

  for (const child of node.children) harvest(child, kit)
}

/**
 * Reduce a loaded primitive to exactly `position`, `normal` and `uv`, each a plain float
 * attribute of its own.
 *
 * Merging is unforgiving about this. glTF is free to interleave attributes into one buffer
 * view, to store UVs as normalised shorts, and to omit a channel a given mesh does not use
 * — and `mergeGeometries` refuses any set that does not match exactly, which is how a
 * building of eight parts ends up as no building at all. Rebuilding each channel is cheap
 * (it happens once, at load) and it means a recipe can mix any two models in the pack.
 */
function normalize(geo) {
  const out = new THREE.BufferGeometry()
  const count = geo.attributes.position.count

  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
  ]) {
    const src = geo.getAttribute(name)
    const data = new Float32Array(count * size)
    if (src) {
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) data[i * size + k] = src.getComponent(i, k)
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size))
  }

  if (geo.index) out.setIndex(Array.from(geo.index.array))
  if (!geo.getAttribute('normal')) out.computeVertexNormals()
  geo.dispose()
  return out
}

function findAtlas(scene) {
  let texture = null
  scene.traverse((o) => {
    if (!texture && o.isMesh && o.material?.map) texture = o.material.map
  })
  if (texture) {
    texture.colorSpace = THREE.SRGBColorSpace
    // Swatches are gradients that fill a whole cell; filtering across a cell boundary
    // bleeds one material into the next along every UV seam in the pack.
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.generateMipmaps = true
    texture.anisotropy = 4
  }
  return texture
}

/**
 * A part's geometry, cloned so callers may transform it freely. Unknown names throw.
 *
 * `solo` leaves the node's children behind — the tower without its rotor, the garage
 * without its door.
 */
export function part(name, kit = 'base', { solo = false } = {}) {
  const geo = (solo ? KITS[kit]?.solo : KITS[kit]?.parts)?.get(name)
  if (!geo) throw new Error(`kit: no ${solo ? 'solo ' : ''}part named "${name}" in the ${kit} kit`)
  return geo.clone()
}

export function hasPart(name, kit = 'base') {
  return KITS[kit]?.parts.has(name) ?? false
}

export function atlasTexture(kit = 'base') {
  return KITS[kit]?.atlas ?? null
}

/**
 * A 32-entry mask, one float per atlas cell, uploaded as a uniform array. Shaders index it
 * by cell rather than sampling a second texture, which keeps the whole idea to 128 bytes.
 */
export function cellMask(cells, value = 1) {
  const mask = new Float32Array(ATLAS.cols * ATLAS.rows)
  for (const cell of cells) mask[cell] = value
  return mask
}
