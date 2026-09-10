/**
 * Packs the desert outpost kit — Kenney's Space Kit plus a hand-picked slice of
 * Quaternius' Ultimate Space Kit, both CC0 — into one glb in the house convention:
 * one scene of named nodes, one material, one 8x4 gradient atlas.
 *
 * Neither pack ships that way, which is what all the work below is. Kenney models carry
 * several flat `baseColorFactor` materials and no texture; Quaternius models UV into a
 * 512px pixel-palette PNG. Both get their colour identity rewritten into *atlas cells*:
 * every triangle is classified into one of the six desert swatches and its UVs collapsed
 * to that cell's centre, so the runtime's per-cell accent/PBR/night-glow machinery works
 * on this kit exactly as it does on the KayKit one.
 *
 * The palette is the point — greys and reds become adobe. Kenney maps by material name
 * (metal→plaster, metalRed→trim...); Quaternius maps by the palette colour sampled at
 * each triangle's UV centroid, which is safe because the palette is flat per swatch.
 * A primitive spanning several palette colours is handled per *triangle*: triangles are
 * unindexed, each gets its own cell, and identical vertices are welded back afterwards —
 * no dominant-colour flattening, no cluster splitting.
 *
 * Usage: build-desert-kit.mjs <kenney-glb-dir> <quaternius-glb-dir> <out.glb>
 */
import { Document, NodeIO } from '@gltf-transform/core'
import { KHRMaterialsUnlit } from '@gltf-transform/extensions'
import { PNG } from 'pngjs'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const [KENNEY_DIR, QUAT_DIR, OUT] = process.argv.slice(2)
if (!KENNEY_DIR || !QUAT_DIR || !OUT) {
  console.error('usage: build-desert-kit.mjs <kenney-glb-dir> <quaternius-glb-dir> <out.glb>')
  process.exit(1)
}

// The raw packs are not checked in — the built glb is. Re-running this without them is what
// happens on a fresh clone, and it should be a no-op rather than a broken install.
if (!existsSync(KENNEY_DIR) || !existsSync(QUAT_DIR)) {
  if (existsSync(OUT)) {
    console.log(`build-desert-kit: no source packs, keeping the existing ${OUT}`)
    process.exit(0)
  }
  console.error(`build-desert-kit: missing ${existsSync(KENNEY_DIR) ? QUAT_DIR : KENNEY_DIR} — see README, "Where the art comes from"`)
  process.exit(1)
}

// ── the desert atlas ──────────────────────────────────────────────────────────────────

/**
 * Cell indices in the 8x4 grid. Must match `DESERT_CELL` in `src/world/kit.js` — the
 * runtime looks accent, tint and PBR up by these numbers. TRIM and GLASS sit in the same
 * slots as the base kit's TRIM and SOLAR_A so the two atlases read alike side by side.
 */
const CELLS = { PLASTER: 1, CLAY: 2, SHADE: 3, METAL: 4, TRIM: 11, GLASS: 28 }

/** Mid-gradient colour per cell — the tone a face actually shows, since UVs land mid-cell. */
const CELL_COLOR = {
  [CELLS.PLASTER]: 0xd9c29a, // sun-bleached plaster
  [CELLS.CLAY]: 0xb99a70, // raw clay
  [CELLS.SHADE]: 0x574c3f, // warm dark — doorways, undersides
  [CELLS.METAL]: 0x8e9299, // the one cool swatch: masts and machine housings
  [CELLS.TRIM]: 0xc96f3c, // terracotta — the accent cell, and the one that glows at night
  [CELLS.GLASS]: 0x6f9aab, // dusty glass
}

const ATLAS = { cols: 8, rows: 4, size: 1024 }

/**
 * Draw the atlas: every cell a vertical light-to-dark gradient of its colour, the same
 * direction and roughly the same swing as the KayKit atlas (measured ~+18% at the top of a
 * cell, ~-20% at the bottom). Unnamed cells get a neutral sand so a stray UV never lands on
 * anything loud.
 */
function paintAtlas() {
  const png = new PNG({ width: ATLAS.size, height: ATLAS.size })
  const cellW = ATLAS.size / ATLAS.cols
  const cellH = ATLAS.size / ATLAS.rows
  for (let cy = 0; cy < ATLAS.rows; cy++) {
    for (let cx = 0; cx < ATLAS.cols; cx++) {
      const base = CELL_COLOR[cy * ATLAS.cols + cx] ?? 0xc9b491
      const r = (base >> 16) & 255
      const g = (base >> 8) & 255
      const b = base & 255
      for (let y = 0; y < cellH; y++) {
        const f = 1.18 - (y / (cellH - 1)) * 0.38
        for (let x = 0; x < cellW; x++) {
          const i = ((cy * cellH + y) * ATLAS.size + cx * cellW + x) * 4
          png.data[i] = Math.min(255, Math.round(r * f))
          png.data[i + 1] = Math.min(255, Math.round(g * f))
          png.data[i + 2] = Math.min(255, Math.round(b * f))
          png.data[i + 3] = 255
        }
      }
    }
  }
  return PNG.sync.write(png)
}

const cellCenterUV = (cell) => [
  ((cell % ATLAS.cols) + 0.5) / ATLAS.cols,
  (Math.floor(cell / ATLAS.cols) + 0.5) / ATLAS.rows,
]

// ── palette classification ────────────────────────────────────────────────────────────

/** Kenney models name their materials; the mapping is a straight rename into adobe. */
const KENNEY_CELLS = {
  metal: CELLS.PLASTER, // the pack's white hull → sun-bleached plaster
  metalDark: CELLS.CLAY,
  metalRed: CELLS.TRIM, // the pack's own accent colour stays the accent
  dark: CELLS.SHADE,
  _defaultMat: CELLS.PLASTER,
}

/** Per-model exceptions. `_defaultMat` is usually filler white, but on the glass hangar it *is* the canopy. */
const KENNEY_OVERRIDES = {
  hangar_roundGlass: { _defaultMat: CELLS.GLASS },
}

/**
 * The sixteen Quaternius models use exactly six greys of their palette, keyed here by the
 * sampled rgb. The ramp goes light→plaster, mid→clay, dark→shade, with the near-black
 * window/panel swatch sent to TRIM so doors and glazing take the accent and light up after
 * dark — that swatch is what makes a desert house a *lit* house at night.
 */
const QUAT_CELLS = {
  '241,241,241': CELLS.PLASTER,
  '171,171,171': CELLS.PLASTER,
  '119,119,119': CELLS.CLAY,
  '102,102,102': CELLS.TRIM,
  '55,55,55': CELLS.SHADE,
  '33,33,33': CELLS.TRIM,
}

/**
 * Per-model exceptions to the ramp:
 * - Models where the mid-dark swatch covers a third of the skin go to CLAY instead of TRIM —
 *   a building that is one-third accent glows like a lantern rather than showing lit windows.
 * - Solar panels keep their cells glassy and their frames metal; nothing about them is adobe.
 * - Mast hardware (supports, antenna and radar heads) reads as metal against the clay.
 */
const QUAT_OVERRIDES = {
  House_Single: { '102,102,102': CELLS.CLAY },
  House_Open: { '102,102,102': CELLS.CLAY },
  Base_Large: { '102,102,102': CELLS.CLAY },
  SolarPanel_Ground: { '241,241,241': CELLS.METAL, '171,171,171': CELLS.METAL, '33,33,33': CELLS.GLASS },
  SolarPanel_Structure: { '241,241,241': CELLS.METAL, '171,171,171': CELLS.METAL, '102,102,102': CELLS.SHADE, '33,33,33': CELLS.GLASS },
  MetalSupport: { '119,119,119': CELLS.METAL },
  Roof_Antenna: { '171,171,171': CELLS.METAL, '102,102,102': CELLS.SHADE },
  Roof_Radar: { '171,171,171': CELLS.METAL, '102,102,102': CELLS.SHADE },
}

/**
 * Fallback for a palette colour the tables above have never seen (a re-exported pack, a new
 * model): bluish stays glass, orange goes to trim, and greys walk the adobe ramp by
 * luminance. Better a reasonable guess than a build that stops on new art.
 */
function classifyColor(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (max - min > 24) {
    if (b > r && b >= g) return CELLS.GLASS
    if (r > b && lum > 60) return CELLS.TRIM
  }
  if (lum >= 140) return CELLS.PLASTER
  if (lum >= 80) return CELLS.CLAY
  return CELLS.SHADE
}

// ── scale targets ─────────────────────────────────────────────────────────────────────

/**
 * Every model is measured, scaled and grounded here, so the recipes in `buildings.js` can
 * compose on the same 2-unit module grid the KayKit kit uses: a house ≈ 2 units tall, the
 * dome a little more, masts taller, clutter under one. `h` is the target height; `maxW`
 * caps the footprint where honouring the height alone would out-grow a plot slot (the base
 * kit's widest part is the 2.5-unit landing pad). The four rocket sections share one scale
 * so they still stack.
 */
const TARGETS = {
  // Quaternius
  GeodesicDome: { h: 2.5, maxW: 3.4 },
  Building_L: { h: 2.2, maxW: 3.6 },
  Connector: { h: 1.1 },
  House_Cylinder: { h: 2.2 },
  House_Long: { h: 2.0, maxW: 3.6 },
  House_Open: { h: 2.0 },
  House_Single: { h: 2.0 },
  House_Single_Support: { h: 0.44 },
  // Authored lying flat; stood upright here because the composer only yaws — a recipe
  // could never raise a mast out of a horizontal beam.
  MetalSupport: { h: 2.4, upright: true },
  Ramp: { h: 0.7 },
  Stairs: { h: 0.7 },
  Roof_Antenna: { h: 1.6 },
  Roof_Radar: { h: 1.3 },
  SolarPanel_Ground: { h: 0.85 },
  SolarPanel_Structure: { h: 1.6 },
  Base_Large: { h: 1.8, maxW: 3.4 },
  // Kenney
  hangar_smallA: { h: 1.3 },
  hangar_smallB: { h: 1.3 },
  hangar_largeA: { h: 1.3, maxW: 3.6 },
  hangar_largeB: { h: 1.3, maxW: 3.6 },
  hangar_roundA: { h: 1.6, maxW: 3.5 },
  hangar_roundB: { h: 1.8, maxW: 3.5 },
  hangar_roundGlass: { h: 1.55, maxW: 3.5 },
  machine_generator: { h: 0.62 },
  machine_generatorLarge: { h: 1.05 },
  machine_wireless: { h: 0.95 },
  machine_wirelessCable: { h: 1.25 },
  satelliteDish: { h: 1.05 },
  satelliteDish_large: { h: 2.0 },
  satelliteDish_detailed: { h: 1.25 },
  gate_simple: { h: 1.55 },
  gate_complex: { h: 1.5 },
  rocket_baseA: { h: 1.36 },
  rocket_fuelA: { h: 0.425 },
  rocket_sidesA: { h: 0.85 },
  rocket_topA: { h: 0.68 },
  craft_miner: { h: 0.55 },
  craft_speederA: { h: 0.6 },
  craft_speederD: { h: 0.6 },
  rover: { h: 0.75 },
  barrel: { h: 0.5 },
  barrels: { h: 0.65 },
  chimney_detailed: { h: 1.9 },
}

const KENNEY_KEEP = Object.keys(TARGETS).filter((n) => !/^[A-Z]/.test(n))
const QUAT_KEEP = Object.keys(TARGETS).filter((n) => /^[A-Z]/.test(n))

// ── source geometry ───────────────────────────────────────────────────────────────────

const io = new NodeIO().registerExtensions([KHRMaterialsUnlit])

const mat4Identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mat4Multiply(a, b) {
  const out = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}
const xformPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
]
// Both packs use only rotation, translation and uniform scale, so the normal transform is
// the rotation part re-normalised — no inverse-transpose needed.
const xformNormal = (m, x, y, z) => {
  const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]
  const len = Math.hypot(...v) || 1
  return v.map((c) => c / len)
}

/**
 * Flatten one source document into unindexed triangles in world space, each triangle
 * carrying the atlas cell it was classified into. `cellFor(prim, centroidUV)` does the
 * classifying — Kenney by material, Quaternius by palette sample.
 */
function collectTriangles(doc, cellFor) {
  const tris = []
  const walk = (node, parent) => {
    const m = mat4Multiply(parent, node.getMatrix())
    const mesh = node.getMesh()
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION')
        const nrm = prim.getAttribute('NORMAL')
        const uv = prim.getAttribute('TEXCOORD_0')
        const idx = prim.getIndices()
        const count = idx ? idx.getCount() : pos.getCount()
        for (let t = 0; t < count; t += 3) {
          const verts = []
          let cu = 0
          let cv = 0
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getScalar(t + k) : t + k
            const p = pos.getElement(vi, [])
            const n = nrm ? nrm.getElement(vi, []) : [0, 1, 0]
            const u = uv ? uv.getElement(vi, []) : [0, 0]
            cu += u[0] / 3
            cv += u[1] / 3
            verts.push({ p: xformPoint(m, ...p), n: xformNormal(m, ...n) })
          }
          tris.push({ verts, cell: cellFor(prim, cu, cv) })
        }
      }
    }
    for (const child of node.listChildren()) walk(child, m)
  }
  for (const child of doc.getRoot().getDefaultScene().listChildren()) walk(child, mat4Identity())
  return tris
}

/**
 * Normalise a model's triangles in place: optionally stand it upright, then scale to its
 * target, centre it on the origin in XZ and ground it at y=0 — so a recipe drops every part
 * in at its own foot, exactly like the KayKit parts arrive.
 */
function normalizeTriangles(name, tris) {
  const target = TARGETS[name]
  const each = (fn) => {
    for (const tri of tris) for (const v of tri.verts) fn(v)
  }
  if (target.upright) {
    each((v) => {
      v.p = [v.p[0], v.p[2], -v.p[1]]
      v.n = [v.n[0], v.n[2], -v.n[1]]
    })
  }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  each((v) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v.p[k])
      max[k] = Math.max(max[k], v.p[k])
    }
  })
  const size = max.map((v, i) => v - min[i])
  let s = target.h / size[1]
  if (target.maxW) s = Math.min(s, target.maxW / Math.max(size[0], size[2]))
  const cx = (min[0] + max[0]) / 2
  const cz = (min[2] + max[2]) / 2
  each((v) => {
    v.p = [(v.p[0] - cx) * s, (v.p[1] - min[1]) * s, (v.p[2] - cz) * s]
  })
}

/**
 * Triangles back into an indexed primitive: UVs collapse to each triangle's cell centre,
 * then vertices weld on exact position+normal+cell so the unindexing above costs nothing
 * in the file.
 */
function emitModel(out, buffer, material, scene, name, tris) {
  const key = (v, cell) => `${v.p.map((c) => c.toFixed(5))}|${v.n.map((c) => c.toFixed(3))}|${cell}`
  const lookup = new Map()
  const positions = []
  const normals = []
  const uvs = []
  const indices = []
  for (const tri of tris) {
    const [u, v] = cellCenterUV(tri.cell)
    for (const vert of tri.verts) {
      const k = key(vert, tri.cell)
      let i = lookup.get(k)
      if (i === undefined) {
        i = positions.length / 3
        lookup.set(k, i)
        positions.push(...vert.p)
        normals.push(...vert.n)
        uvs.push(u, v)
      }
      indices.push(i)
    }
  }
  const accessor = (type, array) => out.createAccessor().setType(type).setArray(array).setBuffer(buffer)
  const prim = out
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', accessor('VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(uvs)))
    .setIndices(accessor('SCALAR', positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)))
  scene.addChild(out.createNode(name).setMesh(out.createMesh(name).addPrimitive(prim)))
}

// ── build ─────────────────────────────────────────────────────────────────────────────

const out = new Document()
const buffer = out.createBuffer()
const scene = out.createScene('Scene')
out.getRoot().setDefaultScene(scene)
const material = out
  .createMaterial('desertbase_texture')
  .setBaseColorTexture(out.createTexture('desertbase_atlas').setImage(paintAtlas()).setMimeType('image/png'))
  .setRoughnessFactor(0.6)
  .setMetallicFactor(0)

for (const name of KENNEY_KEEP) {
  const file = join(KENNEY_DIR, `${name}.glb`)
  if (!existsSync(file)) throw new Error(`${KENNEY_DIR}: no such model: ${name}`)
  const doc = await io.read(file)
  const tris = collectTriangles(doc, (prim) => {
    const mat = prim.getMaterial()?.getName() ?? '_defaultMat'
    const cell = KENNEY_OVERRIDES[name]?.[mat] ?? KENNEY_CELLS[mat]
    if (cell === undefined) throw new Error(`${name}: unmapped material "${mat}"`)
    return cell
  })
  normalizeTriangles(name, tris)
  emitModel(out, buffer, material, scene, name, tris)
}

const quatFiles = new Set(readdirSync(QUAT_DIR).filter((f) => f.endsWith('.glb')).map((f) => basename(f, '.glb')))
for (const name of QUAT_KEEP) {
  if (!quatFiles.has(name)) throw new Error(`${QUAT_DIR}: no such model: ${name}`)
  const doc = await io.read(join(QUAT_DIR, `${name}.glb`))
  const palette = PNG.sync.read(Buffer.from(doc.getRoot().listTextures()[0].getImage()))
  const sample = (u, v) => {
    const x = Math.min(palette.width - 1, Math.max(0, Math.floor(u * palette.width)))
    const y = Math.min(palette.height - 1, Math.max(0, Math.floor(v * palette.height)))
    const i = (y * palette.width + x) * 4
    return [palette.data[i], palette.data[i + 1], palette.data[i + 2]]
  }
  const tris = collectTriangles(doc, (prim, cu, cv) => {
    const rgb = sample(cu, cv)
    const k = rgb.join(',')
    return QUAT_OVERRIDES[name]?.[k] ?? QUAT_CELLS[k] ?? classifyColor(...rgb)
  })
  normalizeTriangles(name, tris)
  emitModel(out, buffer, material, scene, name, tris)
}

const root = out.getRoot()
console.log(
  `${basename(OUT)}: ${scene.listChildren().length} nodes, ${root.listMaterials().length} material, ${root.listTextures().length} texture`
)

mkdirSync(dirname(OUT), { recursive: true })
await io.write(OUT, out)
