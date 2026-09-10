/**
 * Packs every source pack the colony needs into the four glbs it loads.
 *
 * The raw packs are not checked in and the built glbs are, so this is a no-op on a fresh
 * clone — it only has work to do when a pack has been re-downloaded into `assets-src/` or
 * one of the lists below has changed.
 */
import { spawnSync } from 'node:child_process'

/**
 * Which of the Forest Nature Pack's 105 models to keep.
 *
 * The pack ships every model in several sizes and colour variants; the colony wants a
 * handful of silhouettes and gets its variety from per-instance scale and rotation instead,
 * so packing the lot would be five times the file for no more to look at.
 */
const FOREST = [
  // Canopies: round, flat-top and fir, each in a common size, plus a rarer large one.
  'Tree_1_A', 'Tree_3_A', 'Tree_4_A', 'Tree_1_C', 'Tree_3_C', 'Tree_4_C',
  'Bush_1_E', 'Bush_3_B',
  'Grass_2_D',
  // Boulders. Painted neutral grey, which is what lets them be tinted per planet.
  'Rock_1_D', 'Rock_2_C', 'Rock_3_E', 'Rock_1_J', 'Rock_2_G', 'Rock_3_L', 'Rock_3_Q',
].map((n) => `${n}_Color1`)

const STEPS = [
  ['tools/build-kit.mjs', 'assets-src/KayKit_Space_Base_Bits_1.0_FREE/Assets/gltf', 'public/assets/spacebase.glb'],
  ['tools/build-kit.mjs', 'assets-src/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf', 'public/assets/forest.glb', FOREST.join(',')],
  [
    'tools/build-desert-kit.mjs',
    'assets-src/downloads/kenney_space-kit/Models/GLTF format',
    'assets-src/downloads/quaternius-selected',
    'public/assets/desertbase.glb',
  ],
  ['tools/build-crew.mjs'],
]

for (const [script, ...args] of STEPS) {
  const run = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
