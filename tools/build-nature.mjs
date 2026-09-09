/**
 * Packs a slice of Kenney's *Nature Kit* (CC0) into one glb with one material.
 *
 * Kenney's kit is built differently from KayKit's: instead of one gradient atlas that every
 * model UVs into, each model carries two or three flat-colour materials — bark, leaves,
 * stone — as separate primitives. Loaded as shipped that is a draw call per material per
 * model, and it breaks the colony's rule that a whole scatter recipe shares one material.
 * So the colours are baked into a COLOR_0 vertex attribute here and every primitive of every
 * model is merged into a single vertex-coloured primitive under a single material. The
 * runtime then treats the whole kit exactly like the atlas kits, with `vertexColors` in
 * place of `map`.
 *
 * Baking is also where the palette gets a second opinion: a model can be packed more than
 * once under different names with some of its materials recoloured — the same oak becomes a
 * cherry tree with pink leaves, and the same pine a snow-dusted one — so a world can have its
 * own flora without a second pack.
 *
 * Usage: build-nature.mjs <src-glb-dir> <out.glb>
 */
import { Document, NodeIO } from '@gltf-transform/core'
import { dedup, prune } from '@gltf-transform/functions'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [SRC, OUT] = process.argv.slice(2)
if (!SRC || !OUT) {
  console.error('usage: build-nature.mjs <src-glb-dir> <out.glb>')
  process.exit(1)
}

if (!existsSync(SRC)) {
  if (existsSync(OUT)) {
    console.log(`build-nature: no source pack, keeping the existing ${OUT}`)
    process.exit(0)
  }
  console.error(`build-nature: missing ${SRC} — see README, "Where the art comes from"`)
  process.exit(1)
}

/**
 * What to pack. `src` is the Kenney model, `name` what the colony calls it, `palette` maps a
 * Kenney material name to a replacement sRGB colour. Every model's own palette is also run
 * through BASE, which tones Kenney's teal-leaning greens toward something that sits happily
 * under the colony's warm sun.
 */
const BASE = {
  leafsGreen: '#5fb54f',
  leafsDark: '#3a8a52',
  leafsFall: '#e8873a',
  woodBark: '#9a6a48',
  woodBarkDark: '#6e4a34',
  woodBirch: '#efe3d1',
}

const SNOW = { leafsGreen: '#e9f1f4', leafsDark: '#dfe9ee', woodBarkDark: '#5a4638', woodBark: '#5a4638' }
const SAKURA = { leafsGreen: '#f4a9c9', leafsDark: '#e88fb8', leafsFall: '#f7bcd3', woodBark: '#7a5a48', woodBirch: '#7a5a48' }
const JUNGLE = { leafsGreen: '#3f9f48', leafsDark: '#2c7a3e' }
const DEAD = { leafsGreen: '#4a4340', leafsDark: '#3c3634', leafsFall: '#4a4340', woodBark: '#3a2f2a', woodBarkDark: '#2e2622', woodBirch: '#4a3e36' }

const MODELS = [
  // Beach and ocean: palms.
  ...['tree_palm', 'tree_palmBend', 'tree_palmDetailedShort', 'tree_palmDetailedTall', 'tree_palmShort', 'tree_palmTall'].map((src) => ({ src })),
  // Desert.
  { src: 'cactus_short' },
  { src: 'cactus_tall' },
  { src: 'plant_flatShort' },
  { src: 'plant_flatTall' },
  ...['rock_tallA', 'rock_tallC', 'rock_tallF', 'rock_largeA', 'rock_smallC', 'stone_tallB', 'stone_tallD', 'stone_largeB'].map((src) => ({ src })),
  { src: 'statue_column' },
  { src: 'statue_columnDamaged' },
  { src: 'statue_obelisk' },
  { src: 'statue_ring' },
  // Tundra: pines, and the same pines under snow.
  ...['tree_pineSmallA', 'tree_pineSmallB', 'tree_pineTallA', 'tree_pineTallB', 'tree_pineRoundA', 'tree_pineRoundC', 'tree_pineDefaultA'].map((src) => ({ src })),
  ...['tree_pineSmallA', 'tree_pineSmallB', 'tree_pineTallA', 'tree_pineTallB', 'tree_pineRoundA', 'tree_pineDefaultA'].map((src) => ({ src, name: `${src}_snow`, palette: SNOW })),
  { src: 'log_stack' },
  { src: 'stump_round' },
  // Autumn.
  ...['tree_default_fall', 'tree_detailed_fall', 'tree_oak_fall', 'tree_fat_fall', 'tree_thin_fall', 'tree_small_fall', 'tree_tall_fall'].map((src) => ({ src })),
  { src: 'mushroom_red' },
  { src: 'mushroom_redGroup' },
  { src: 'mushroom_tanGroup' },
  { src: 'mushroom_tanTall' },
  { src: 'log' },
  { src: 'log_large' },
  { src: 'stump_square' },
  // Jungle: the broad canopies, big bushes, understorey.
  ...['tree_fat', 'tree_detailed', 'tree_oak', 'tree_plateau', 'tree_blocks', 'tree_tall'].map((src) => ({ src, name: `${src}_jungle`, palette: JUNGLE })),
  { src: 'plant_bushLarge' },
  { src: 'plant_bushDetailed' },
  { src: 'plant_bush' },
  { src: 'grass_leafsLarge' },
  { src: 'grass_leafs' },
  { src: 'grass_large' },
  { src: 'hanging_moss' },
  { src: 'lily_large' },
  { src: 'lily_small' },
  ...['flower_purpleA', 'flower_redA', 'flower_yellowA', 'flower_purpleC', 'flower_yellowC'].map((src) => ({ src })),
  // Sakura: ordinary broadleaf trees, in bloom.
  ...['tree_default', 'tree_detailed', 'tree_oak', 'tree_small', 'tree_fat'].map((src) => ({ src, name: `${src}_sakura`, palette: SAKURA })),
  // Volcanic: dead, blackened trees.
  ...['tree_thin', 'tree_tall', 'tree_simple'].map((src) => ({ src, name: `${src}_dead`, palette: DEAD })),
  { src: 'campfire_stones' },
  { src: 'canoe' },
  { src: 'tent_smallClosed' },
]

/** sRGB hex → linear rgb, which is what glTF vertex colours are. */
function linear(hex) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)]
}

const io = new NodeIO()
const out = new Document()
const buffer = out.createBuffer()
const scene = out.createScene('nature')
const material = out
  .createMaterial('nature')
  .setBaseColorFactor([1, 1, 1, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.85)

let packed = 0
for (const entry of MODELS) {
  const file = join(SRC, `${entry.src}.glb`)
  if (!existsSync(file)) throw new Error(`${SRC}: no such model: ${entry.src}`)
  const src = await io.read(file)
  const palette = { ...BASE, ...(entry.palette || {}) }

  // Every primitive of every mesh, in world space, merged into one.
  const positions = []
  const normals = []
  const colors = []
  const indices = []
  let base = 0
  for (const node of src.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const m = node.getWorldMatrix()
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()
      const name = mat?.getName() || ''
      const rgb = palette[name] ? linear(palette[name]) : (mat?.getBaseColorFactor() || [0.8, 0.8, 0.8, 1]).slice(0, 3)
      const pos = prim.getAttribute('POSITION').getArray()
      const nrm = prim.getAttribute('NORMAL')?.getArray()
      const idx = prim.getIndices()?.getArray()
      const count = pos.length / 3
      for (let i = 0; i < count; i++) {
        const p = transform(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1)
        positions.push(p[0], p[1], p[2])
        if (nrm) {
          const n = transform(m, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], 0)
          const len = Math.hypot(n[0], n[1], n[2]) || 1
          normals.push(n[0] / len, n[1] / len, n[2] / len)
        } else normals.push(0, 1, 0)
        colors.push(rgb[0], rgb[1], rgb[2])
      }
      if (idx) for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base)
      else for (let i = 0; i < count; i++) indices.push(i + base)
      base += count
    }
  }
  if (!base) throw new Error(`${entry.src}: no geometry`)

  const prim = out
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
    .setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setArray(new Float32Array(colors)).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(base > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)).setBuffer(buffer))
  const name = entry.name || entry.src
  const mesh = out.createMesh(name).addPrimitive(prim)
  scene.addChild(out.createNode(name).setMesh(mesh))
  packed++
}

await out.transform(dedup(), prune())
console.log(`${OUT.split('/').pop()}: ${packed} nodes, 1 material, vertex-coloured`)
mkdirSync(dirname(OUT), { recursive: true })
await io.write(OUT, out)

/** Column-major 4x4 times a point (w=1) or a direction (w=0). */
function transform(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
  ]
}
