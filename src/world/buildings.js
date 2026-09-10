import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry } from './planet.js'
import { ATLAS, CELL, DESERT_CELL, atlasTexture, cellMask, part } from './kit.js'

/**
 * Colony buildings — one per thread, assembled out of KayKit's *Space Base Bits* (CC0), or
 * out of the desert outpost kit on a planet that declares one, and seeded from the thread's
 * own id, so a given session always builds the same structure on every reload.
 *
 * The pack is a modular one, which is the whole reason the ten kinds below can stay short:
 * a habitat is a base module with a roof module on it, a workshop is the garage variant
 * with a rover parked outside. Every part shares one gradient atlas, so a nine-part
 * greenhouse still merges down to a single geometry and a single draw call.
 *
 * Three things ride on top of the pack's own art:
 *
 * 1. **Construction progress sinks the building into the ground.** The vertex stage lowers
 *    the whole structure and the fragment stage discards whatever ends up below the deck, so
 *    a thread's building rises as it grows without ever touching a vertex buffer — and what
 *    is on screen is always a *complete* building, part of it buried. Slicing the top off
 *    instead, which is what this used to do, guts a kit of closed shells: at two-thirds
 *    finished a biodome loses its entire dome and becomes an empty ring.
 * 2. **The accent is a repainted atlas cell.** Kay's gold trim band is cell 11 of the 8x4
 *    atlas; the fragment stage swaps its hue for the repo's accent while keeping the
 *    swatch's own light-to-dark gradient. One repo, one colour, no extra material.
 * 3. **PBR comes from the atlas too.** Roughness and metalness are looked up per cell, so
 *    the grey structural swatch behaves like brushed metal and the solar swatch like glass
 *    even though both arrive as flat colour in a single texture.
 */

/** Shared across every building, so night falling is one uniform write for the whole colony. */
export const buildingUniforms = {
  uNight: { value: 0 },
  /** Seconds, for anything that turns. One write drives every rotor in the colony. */
  uTime: { value: 0 },
  /**
   * A planet's colour on the hull. The neutral structural swatches lean toward this when
   * the amount is up, and because it is shared, switching planet re-themes every standing
   * building with two writes and no rebuild. Amount 0 is a true no-op, so worlds without a
   * tint cost nothing — and a planet with its own kit (Karak's adobe) skips it entirely:
   * its kit's tint mask is empty, and swapping kits is a rebuild anyway.
   */
  uPlanetTint: { value: new THREE.Color(1, 1, 1) },
  uPlanetTintAmount: { value: 0 },
}

/**
 * Every structure is authored on the pack's 2-unit module grid and scaled once, here.
 *
 * The number is set against the crew, not the plot: an astronaut is about 1.1 units tall,
 * and a habitat you can see over is not a habitat. At 1.45 a base module clears the crew's
 * heads and a mast is three of them, while the widest footprint still leaves a walkable
 * gap at the plot's 4.4-unit slot spacing.
 */
const BUILDING_SCALE = 1.45

/** The top face of a base module — where roof modules and masts stack. */
const DECK = 1.0

/**
 * Surface response per atlas cell. The pack ships one material for everything; this is what
 * gives a colony made of it any specular variety at all under the environment map.
 *
 * Metalness is kept deliberately low almost everywhere. These are *painted* surfaces, and a
 * fully metallic one has no diffuse term at all — with only a soft sky to reflect, the grey
 * structural swatch is the largest surface in the pack and turns black the moment it is
 * treated as bare metal. A quarter is enough to pick up the horizon along an edge.
 *
 * Defaults are Kay's own (roughness 0.6, metalness 0) so an unlisted swatch still looks right.
 */
const SURFACE = {
  [CELL.WHITE]: [0.55, 0.0], // painted hull panel
  [CELL.GREY]: [0.46, 0.22], // structural frame — painted metal, not bare
  [CELL.SLATE]: [0.5, 0.3],
  [CELL.BLACK]: [0.6, 0.18],
  [CELL.ROCK]: [0.95, 0.0], // regolith and terrain chunks — never shiny
  [CELL.TRIM]: [0.42, 0.08], // painted trim, semi-gloss
  [CELL.RED]: [0.55, 0.04],
  [CELL.SOLAR_A]: [0.16, 0.7], // photovoltaic glass, and dark on purpose
  [CELL.SOLAR_B]: [0.16, 0.7],
}

/** The desert kit's surfaces are mostly mineral: rough plaster and clay, no sheen at all. */
const DESERT_SURFACE = {
  [DESERT_CELL.PLASTER]: [0.85, 0.0],
  [DESERT_CELL.CLAY]: [0.9, 0.0],
  [DESERT_CELL.SHADE]: [0.75, 0.0],
  [DESERT_CELL.METAL]: [0.45, 0.35], // masts and machine housings — the one hard surface
  [DESERT_CELL.TRIM]: [0.55, 0.04], // terracotta, matte like the rest
  [DESERT_CELL.GLASS]: [0.16, 0.7], // canopies and solar cells, same recipe as SOLAR_A
}

const CELL_COUNT = ATLAS.cols * ATLAS.rows
function bakeSurface(surface) {
  // Defaults are Kay's own (roughness 0.6, metalness 0) so an unlisted swatch still looks right.
  const roughness = new Float32Array(CELL_COUNT).fill(0.6)
  const metalness = new Float32Array(CELL_COUNT).fill(0.0)
  for (const [cell, [r, m]] of Object.entries(surface)) {
    roughness[cell] = r
    metalness[cell] = m
  }
  return { roughness, metalness }
}

/**
 * Everything cell-indexed, per kit: surface response, the one swatch the accent repaints
 * (and that lights up after dark), and the swatches the planet tint may touch.
 *
 * The base kit tints its neutral hull greys — everything with a colour of its own keeps it,
 * or the repaint flattens a building into a single-tone lump. The desert kit tints nothing:
 * it is natively adobe, and clay-on-clay only muddies it.
 */
const KIT_STYLE = {
  base: {
    ...bakeSurface(SURFACE),
    accent: cellMask([CELL.TRIM]),
    planetTint: cellMask([CELL.WHITE, CELL.GREY, CELL.SLATE]),
  },
  desertbase: {
    ...bakeSurface(DESERT_SURFACE),
    accent: cellMask([DESERT_CELL.TRIM]),
    planetTint: cellMask([]),
  },
}

// ── composition ───────────────────────────────────────────────────────────────────────

/**
 * A tiny placement helper. Parts are baked to the building's own frame as they are added,
 * each carrying a per-vertex emissive flag, so the whole lot merges into one buffer.
 */
class Composer {
  constructor(kit = 'base') {
    this.kit = kit
    this.parts = []
  }

  /**
   * @param {string} name  a node name from the kit
   * @param {object} [o]   `x`/`y`/`z` offset, `ry` yaw, `s` uniform scale, `emissive` 0..1
   */
  add(name, o = {}) {
    const geo = part(name, this.kit, { solo: o.solo })
    const s = o.s ?? 1
    if (s !== 1) geo.scale(s, s, s)
    if (o.ry) geo.rotateY(o.ry)
    geo.translate(o.x || 0, o.y || 0, o.z || 0)

    const count = geo.attributes.position.count
    geo.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(count).fill(o.emissive || 0), 1))

    // Rotors turn in the vertex shader rather than as child meshes, so a turbine is still
    // one merged geometry and one draw call. Each spinning vertex carries the hub it turns
    // about and how fast, which is what lets one building hold several of them.
    const rate = o.spin || 0
    const spin = new Float32Array(count).fill(rate)
    const pivot = new Float32Array(count * 3)
    if (rate) {
      for (let i = 0; i < count; i++) {
        pivot[i * 3] = o.x || 0
        pivot[i * 3 + 1] = o.y || 0
        pivot[i * 3 + 2] = o.z || 0
      }
    }
    geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1))
    geo.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3))

    this.parts.push(geo)
    return this
  }

  /** Scatter `count` copies of a part around a ring, jittered so it never reads as a pattern. */
  ring(name, count, radius, rand, o = {}) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.5
      const r = radius * (0.85 + rand() * 0.3)
      this.add(name, { ...o, x: Math.cos(a) * r, z: Math.sin(a) * r, ry: a + Math.PI / 2 })
    }
    return this
  }

  finish() {
    const merged = BufferGeometryUtils.mergeGeometries(this.parts, false)
    for (const p of this.parts) p.dispose()
    merged.computeBoundingBox()
    return merged
  }
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)]

// ── the building catalogue ────────────────────────────────────────────────────────────

/**
 * Each generator gets a placer, a seeded RNG and the repo's accent. They stay deliberately
 * varied in silhouette — dome, mast, slab, derrick — so a plot full of them reads as a town
 * rather than a row of the same shed.
 */
const KINDS = {
  habitat(c, rand) {
    c.add(pick(rand, ['basemodule_A', 'basemodule_B', 'basemodule_C', 'basemodule_D']))
    c.add(pick(rand, ['roofmodule_base', 'roofmodule_cargo_A', 'roofmodule_cargo_B']), { y: DECK })
    if (rand() > 0.45) c.add('lights', { x: 1.15, z: 0.85, s: 0.85, ry: rand() * 6.28 })
    if (rand() > 0.6) c.add('containers_A', { x: -1.15, z: 0.9, ry: rand() * 6.28 })
    return 'Habitat'
  },

  solar(c, rand) {
    const cols = 2 + Math.floor(rand() * 2)
    const rows = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        c.add('solarpanel', {
          x: (i - (cols - 1) / 2) * 1.05,
          z: (j - (rows - 1) / 2) * 0.62,
          // A whole field tilted the same way is what makes an array read as an array.
          ry: 0.06 * (rand() - 0.5),
        })
      }
    }
    c.add('lights', { x: cols * 0.6, z: -rows * 0.4, s: 0.8 })
    c.add('containers_B', { x: -cols * 0.6, z: rows * 0.35, ry: 0.4 })
    return 'Solar array'
  },

  antenna(c, rand) {
    // The tall turbine mast — the only silhouette in the pack that breaks the skyline. The
    // tower is taken *solo* so the rotor can be put back on as a part that turns.
    const tall = rand() > 0.3
    const [tower, hub] = tall ? ['windturbine_tall', 2.05] : ['windturbine_low', 0.89]
    c.add(tower, { solo: true })
    // Slow: a turbine that whips round reads as a desk fan. A little over half a minute a
    // turn, jittered so a row of them never falls into step.
    c.add(`${tower}_fan`, { y: hub, spin: 0.17 + rand() * 0.09 })
    c.add('containers_C', { x: 0.9, z: 0.75, ry: rand() * 6.28 })
    if (rand() > 0.5) c.add('lights', { x: -0.95, z: -0.7, s: 0.8 })
    return 'Relay mast'
  },

  silo(c, rand) {
    c.add(pick(rand, ['cargodepot_A', 'cargodepot_B', 'cargodepot_C']))
    if (rand() > 0.5) c.add(pick(rand, ['cargo_A_stacked', 'cargo_B_stacked']), { x: 1.35, z: 0.4, ry: rand() * 6.28 })
    return 'Storage'
  },

  greenhouse(c, rand) {
    // The geodesic-topped module — the pack's own biodome.
    c.add('basemodule_E')
    c.ring('containers_D', 2 + Math.floor(rand() * 2), 1.45, rand)
    return 'Greenhouse'
  },

  reactor(c, rand) {
    c.add('drill_structure')
    c.ring('cargo_A', 3, 1.35, rand)
    if (rand() > 0.5) c.add('lights', { x: -1.2, z: 1.0, s: 0.9 })
    return 'Reactor'
  },

  tower(c, rand) {
    c.add('structure_tall')
    c.add('lights', { y: 2.0, s: 0.7 })
    if (rand() > 0.5) c.add('containers_A', { x: 1.15, z: 0.95, ry: rand() * 6.28 })
    return 'Tower'
  },

  workshop(c, rand) {
    c.add('basemodule_garage')
    c.add('roofmodule_solarpanels', { y: DECK })
    // Something parked outside: an empty forecourt reads as unfinished.
    if (rand() > 0.3) {
      c.add(pick(rand, ['spacetruck', 'spacetruck_large']), { x: 1.55, z: 0.3, ry: Math.PI / 2 + (rand() - 0.5) * 0.5 })
    }
    if (rand() > 0.5) c.add('spacetruck_trailer', { x: 1.55, z: 1.35, ry: Math.PI / 2 })
    return 'Workshop'
  },

  pad(c, rand) {
    c.add(rand() > 0.35 ? 'landingpad_large' : 'landingpad_small')
    if (rand() > 0.4) c.add(pick(rand, ['lander_A', 'lander_B']), { y: 0.5, ry: rand() * 6.28 })
    else c.add('lander_base', { y: 0.5, ry: rand() * 6.28 })
    return 'Landing pad'
  },

  lab(c, rand) {
    c.add(pick(rand, ['basemodule_C', 'basemodule_A']))
    c.add('roofmodule_cargo_C', { y: DECK })
    c.ring(pick(rand, ['containers_B', 'containers_C']), 2, 1.4, rand)
    return 'Lab'
  },
}

/**
 * The desert catalogue — same contract as `KINDS`, composed out of the desert kit's parts.
 * Adobe houses, a dome, masts and a hangar; the launch pad is the one skyline-breaker.
 */
const DESERT_KINDS = {
  dome(c, rand) {
    c.add('GeodesicDome')
    // The entry corridor pokes out from under the dome's rim.
    c.add('Connector', { x: 1.25 })
    if (rand() > 0.5) c.add('barrels', { x: -1.35, z: 1.05, ry: rand() * 6.28 })
    return 'Dome habitat'
  },

  pod(c, rand) {
    // The stilt houses, put back on the platform they were authored to stand on.
    c.add('House_Single_Support')
    c.add(pick(rand, ['House_Single', 'House_Open']), { y: 0.42, ry: rand() > 0.5 ? Math.PI / 2 : 0 })
    c.add('Ramp', { x: 1.35, ry: Math.PI / 2 })
    if (rand() > 0.55) c.add('SolarPanel_Ground', { x: -1.5, z: 0.9, ry: rand() * 6.28 })
    return 'Pod house'
  },

  longhouse(c, rand) {
    c.add(pick(rand, ['House_Long', 'Building_L']), { ry: rand() > 0.5 ? Math.PI / 2 : 0 })
    c.add(rand() > 0.5 ? 'SolarPanel_Ground' : 'SolarPanel_Structure', { x: 1.55, z: 1.15, ry: rand() * 6.28 })
    if (rand() > 0.5) c.add('barrel', { x: -1.6, z: 0.95 })
    return 'Long house'
  },

  roundhouse(c, rand) {
    c.add('House_Cylinder')
    c.add('Stairs', { x: 1.55, ry: Math.PI / 2 })
    if (rand() > 0.45) c.add('machine_wireless', { x: -1.5, z: 0.9, ry: rand() * 6.28, emissive: 0.4 })
    return 'Round house'
  },

  vaporator(c, rand) {
    // Three uprights in a tight triangle read as a lattice mast; one alone is a flagpole.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      c.add('MetalSupport', { x: Math.cos(a) * 0.22, z: Math.sin(a) * 0.22, ry: a })
    }
    // No `spin` on the head: botSpin turns about Z through the pivot, which is right for a
    // turbine rotor facing along Z and a tumble for a dish that should sweep about Y.
    c.add(rand() > 0.5 ? 'Roof_Antenna' : 'Roof_Radar', { y: 2.25, s: 0.75 })
    c.add('machine_generator', { x: 0.85, z: 0.55, ry: rand() * 6.28 })
    if (rand() > 0.5) c.add('barrel', { x: -0.8, z: 0.6 })
    return 'Moisture rig'
  },

  hangar(c, rand) {
    c.add(
      pick(rand, [
        'hangar_roundA',
        'hangar_roundB',
        'hangar_roundGlass',
        'hangar_smallA',
        'hangar_smallB',
        'hangar_largeA',
        'hangar_largeB',
      ]),
      { ry: rand() > 0.5 ? Math.PI / 2 : 0 }
    )
    c.add('barrels', { x: 1.75, z: 0.85, ry: rand() * 6.28 })
    if (rand() > 0.5) c.add('rover', { x: -1.75, z: 1.0, ry: rand() * 6.28 })
    else c.add('satelliteDish', { x: -1.7, z: -0.95, ry: rand() * 6.28 })
    return 'Hangar bay'
  },

  dish(c, rand) {
    c.add('satelliteDish_large', { ry: rand() * 6.28 })
    c.add(rand() > 0.5 ? 'machine_wirelessCable' : 'satelliteDish_detailed', {
      x: 1.35,
      z: 0.6,
      ry: rand() * 6.28,
      emissive: 0.5,
    })
    if (rand() > 0.4) c.add('barrel', { x: -1.3, z: 0.85 })
    return 'Comms dish'
  },

  launchpad(c, rand) {
    // The rocket stands beside the service structure, not on it: Base_Large is a terraced
    // building with no flat deck, and a rocket floating on its roofline reads as a bug.
    c.add('Base_Large', { x: -0.6, s: 0.75, ry: rand() > 0.5 ? Math.PI : 0 })
    const x = 1.25
    c.add('rocket_baseA', { x })
    c.add('rocket_sidesA', { x, y: 1.36 })
    c.add('rocket_fuelA', { x, y: 2.21 })
    c.add('rocket_topA', { x, y: 2.63 })
    return 'Launch pad'
  },

  workshop(c, rand) {
    c.add('machine_generatorLarge')
    c.add('chimney_detailed', { x: 0.95, z: -0.6 })
    c.add('machine_generator', { x: -1.15, z: 0.7, ry: rand() * 6.28 })
    if (rand() > 0.4) c.add('barrels', { x: 0.95, z: 1.1, ry: rand() * 6.28 })
    return 'Workshop'
  },

  speeder(c, rand) {
    c.add(pick(rand, ['craft_speederA', 'craft_speederD', 'craft_miner']), { x: 0.55, ry: rand() * 6.28 })
    c.add(pick(rand, ['gate_simple', 'gate_complex']), { x: -1.2, ry: Math.PI / 2 })
    c.add('barrel', { x: -0.9, z: 1.05 })
    if (rand() > 0.5) c.add('rover', { x: 0.2, z: -1.35, ry: rand() * 6.28 })
    return 'Speeder yard'
  },
}

const KIND_IDS = Object.keys(KINDS)
/**
 * Ids may repeat, and the pick is uniform over the list — so listing the houses twice makes
 * the launch pad the rare skyline-breaker rather than one building in ten.
 */
const DESERT_KIND_IDS = [...Object.keys(DESERT_KINDS), 'dome', 'pod', 'longhouse', 'roundhouse']

/** Catalogue and style per kit — what `createBuilding` swaps when a planet brings its own kit. */
const CATALOGUE = {
  base: { kinds: KINDS, ids: KIND_IDS },
  desertbase: { kinds: DESERT_KINDS, ids: DESERT_KIND_IDS },
}

// ── the reveal shader ─────────────────────────────────────────────────────────────────

/**
 * Everything the atlas makes possible, in one `onBeforeCompile`.
 *
 * Progress lowers the building and discards whatever falls below ground, with the band just
 * above that line painted in the accent — the "under construction" glow.
 * The accent also replaces the gold trim swatch outright, and per-cell roughness and
 * metalness turn one flat texture into a surface with metal, paint and glass in it.
 */
function decorate(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aEmissive;
         attribute float aSpin;
         attribute vec3 aPivot;
         varying float vEmissive;
         varying vec2 vAtlasUv;
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;
         uniform float uTime;

         // Turn a point about the Z axis through a hub. The pack's rotors are modelled as
         // vertical discs facing along Z, which is the axis a wind turbine actually turns on.
         vec3 botSpin( vec3 p, vec3 hub, float angle ) {
           vec3 r = p - hub;
           float s = sin( angle );
           float c = cos( angle );
           return hub + vec3( r.x * c - r.y * s, r.x * s + r.y * c, r.z );
         }`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         if ( aSpin > 0.0 ) objectNormal = botSpin( objectNormal, vec3( 0.0 ), uTime * aSpin );`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vEmissive = aEmissive;
         // Our own copy of the UV: three renames its map varying between versions, and the
         // cell lookup below has to survive that.
         vAtlasUv = uv;
         if ( aSpin > 0.0 ) transformed = botSpin( transformed, aPivot, uTime * aSpin );
         // Measured *after* the rotor has turned, so a blade sweeping past the ground line
         // is revealed and hidden by the same rule as everything else.
         vLocalY = transformed.y;
         // The whole structure is lowered into the ground, and the fragment stage throws
         // away whatever ends up below the deck. What is on screen is therefore always a
         // *complete* building, part of it buried — never a sliced one.
         transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vEmissive;
         varying vec2 vAtlasUv;
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;
         uniform vec3 uAccent;
         uniform float uNight;
         uniform vec3 uPlanetTint;
         uniform float uPlanetTintAmount;
         uniform float uCellAccent[ ${CELL_COUNT} ];
         uniform float uCellPlanetTint[ ${CELL_COUNT} ];
         uniform float uCellRoughness[ ${CELL_COUNT} ];
         uniform float uCellMetalness[ ${CELL_COUNT} ];

         // Which swatch of the 8x4 gradient atlas this fragment landed in.
         int atlasCell() {
           int cx = int( clamp( floor( vAtlasUv.x * ${ATLAS.cols}.0 ), 0.0, ${ATLAS.cols - 1}.0 ) );
           int cy = int( clamp( floor( vAtlasUv.y * ${ATLAS.rows}.0 ), 0.0, ${ATLAS.rows - 1}.0 ) );
           return cy * ${ATLAS.cols} + cx;
         }`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         // Ground level, in the building's own frame, as it sinks. Measured from the
         // geometry's real floor rather than from zero: a few parts of the kit — a rover's
         // wheels, a crate's skids — sit a little proud of it, and testing against zero
         // would cut them off a building that is otherwise finished.
         float ground = uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY );
         if ( vLocalY < ground - 0.001 ) discard;
         int cell = atlasCell();`
      )
      // The accent repaint. Luminance carries the swatch's own gradient across, so the trim
      // keeps its shading instead of going flat the moment it changes colour.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // The planet's own colour on the neutral hull swatches, before the accent gets
         // its say — same luminance trick, so panels keep their shading as they change.
         float tintAmount = uCellPlanetTint[ cell ] * uPlanetTintAmount;
         if ( tintAmount > 0.0 ) {
           float tintLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
           diffuseColor.rgb = mix( diffuseColor.rgb, uPlanetTint * clamp( tintLum * 1.9, 0.3, 1.5 ), tintAmount );
         }
         float accentAmount = uCellAccent[ cell ];
         if ( accentAmount > 0.0 ) {
           float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
           diffuseColor.rgb = mix( diffuseColor.rgb, uAccent * clamp( lum * 1.9, 0.3, 1.5 ), accentAmount );
         }`
      )
      // Per-cell PBR: painted panels, brushed metal and photovoltaic glass in one texture.
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = uCellRoughness[ cell ];')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = uCellMetalness[ cell ];')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Lamps and beacons, flagged per vertex when the recipe placed them.
         totalEmissiveRadiance += diffuseColor.rgb * vEmissive * ( 0.25 + uNight * 2.4 );
         // Window strips and trim come on after dark, in the repo's own colour.
         totalEmissiveRadiance += uAccent * uCellAccent[ cell ] * uNight * 1.15;
         // The construction line: a bright band riding just above the ground it rises from.
         float band = 1.0 - smoothstep( 0.0, 0.22, vLocalY - ground );
         totalEmissiveRadiance += uAccent * band * ( 1.0 - step( 0.999, uProgress ) ) * 1.5;`
      )
  }
  return material
}

/**
 * Shadows are rendered with three's own depth material, which knows nothing about the
 * sink — so without this a building at ten percent still casts its finished silhouette from
 * its finished position. The depth pass gets the same offset and the same discard, reading
 * the very same uniform objects.
 */
function depthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSpin;
         attribute vec3 aPivot;
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;
         uniform float uTime;

         vec3 botSpin( vec3 p, vec3 hub, float angle ) {
           vec3 r = p - hub;
           float s = sin( angle );
           float c = cos( angle );
           return hub + vec3( r.x * c - r.y * s, r.x * s + r.y * c, r.z );
         }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         if ( aSpin > 0.0 ) transformed = botSpin( transformed, aPivot, uTime * aSpin );
         vLocalY = transformed.y;
         transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if ( vLocalY < uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY ) - 0.001 ) discard;`
      )
  }
  return mat
}

/**
 * Build one structure. `seed` is derived from the thread id, so the same session always
 * gets the same building; `kind` can be forced, otherwise the seed picks it. `kit` selects
 * a whole catalogue — a planet that brings its own architecture swaps it here.
 *
 * Requires `loadKit()` to have resolved — boot awaits it before the first roster arrives.
 */
export function createBuilding({ seed = 1, accent = 0xc96442, kind = null, kit = 'base' } = {}) {
  if (!CATALOGUE[kit]) kit = 'base'
  const { kinds, ids } = CATALOGUE[kit]
  const style = KIT_STYLE[kit]
  const rand = mulberry(seed)
  const chosen = kind && kinds[kind] ? kind : ids[Math.floor(rand() * ids.length)]

  const c = new Composer(kit)
  const label = kinds[chosen](c, rand, accent)
  const geo = c.finish()
  // Trimmed to fit a slot: the catalogue is authored on the pack's module grid and scaled
  // once here, so tuning the plot lattice never means re-tuning ten recipes.
  geo.scale(BUILDING_SCALE, BUILDING_SCALE, BUILDING_SCALE)
  // `scale()` transforms position and normal and nothing else, so a custom attribute that
  // holds a *position* has to be taken along by hand. Miss this and a rotor turns about a
  // hub left behind at the unscaled height — the blades orbit a point below themselves.
  const pivot = geo.getAttribute('aPivot')
  if (pivot) {
    for (let i = 0; i < pivot.count * 3; i++) pivot.array[i] *= BUILDING_SCALE
    pivot.needsUpdate = true
  }
  geo.computeBoundingBox()
  const height = geo.boundingBox.max.y
  const footprint = Math.max(
    Math.abs(geo.boundingBox.max.x),
    Math.abs(geo.boundingBox.min.x),
    Math.abs(geo.boundingBox.max.z),
    Math.abs(geo.boundingBox.min.z)
  )

  // One uniform block, shared by the surface pass and the shadow pass.
  const uniforms = {
    uProgress: { value: 1 },
    uMaxY: { value: height },
    uMinY: { value: geo.boundingBox.min.y },
    uAccent: { value: new THREE.Color(accent) },
    uNight: buildingUniforms.uNight,
    uTime: buildingUniforms.uTime,
    uPlanetTint: buildingUniforms.uPlanetTint,
    uPlanetTintAmount: buildingUniforms.uPlanetTintAmount,
    uCellAccent: { value: style.accent },
    uCellPlanetTint: { value: style.planetTint },
    uCellRoughness: { value: style.roughness },
    uCellMetalness: { value: style.metalness },
  }

  const material = decorate(
    new THREE.MeshStandardMaterial({
      map: atlasTexture(kit),
      // Roughness and metalness arrive per atlas cell; these are only the fallback values.
      roughness: 0.6,
      metalness: 0,
      emissive: 0x000000, // additions in the shader are the only emission
      // Single-sided, unlike the procedural buildings this replaced.
      //
      // The pack's models are closed solids, so there is nothing to see through — and being
      // closed is exactly why they must not be drawn double-sided. They are modelled as
      // stacked boxes, which leaves a floor and the ceiling under it sharing a plane all
      // over the kit: a landing pad and the lander standing on it put 38 up-facing and 17
      // down-facing triangles at one height. Drawn double-sided both halves of every such
      // pair rasterise at identical depth and the winner is decided by floating-point
      // noise, which is a whole colony of surfaces flickering. Back-face culling throws the
      // downward half away before it can fight.
      side: THREE.FrontSide,
    }),
    uniforms
  )

  const mesh = new THREE.Mesh(geo, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  const depth = depthMaterial(uniforms)
  depth.side = THREE.BackSide
  mesh.customDepthMaterial = depth

  mesh.userData.kind = chosen
  mesh.userData.label = label
  mesh.userData.height = height
  mesh.userData.footprint = footprint
  mesh.userData.uniforms = uniforms
  mesh.userData.progress = 1
  mesh.userData.setProgress = (p) => {
    const v = THREE.MathUtils.clamp(p, 0, 1)
    mesh.userData.progress = v
    uniforms.uProgress.value = v
    mesh.visible = v > 0.02
  }

  return mesh
}

/** Scaffolding around anything still going up. One instanced mesh for the whole colony. */
export class Scaffolds {
  constructor(scene, capacity = 256) {
    const geo = new THREE.CylinderGeometry(0.045, 0.045, 1, 5)
    geo.translate(0, 0.5, 0) // pivot at the foot, so scaling grows it upward
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xb08d52, roughness: 0.85, flatShading: true }),
      capacity
    )
    this.mesh.castShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(this.mesh)
    this.scene = scene
    this.capacity = capacity
    this._dummy = new THREE.Object3D()
  }

  /** `sites` are `{ x, y, z, radius, height }` for every building not yet finished. */
  update(sites) {
    const d = this._dummy
    let n = 0
    for (const site of sites) {
      for (let i = 0; i < 4 && n < this.capacity; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.78
        d.position.set(site.x + Math.cos(a) * site.radius, site.y, site.z + Math.sin(a) * site.radius)
        d.rotation.set(0, a, 0)
        d.scale.set(1, Math.max(0.4, site.height), 1)
        d.updateMatrix()
        this.mesh.setMatrixAt(n++, d.matrix)
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.scene.remove(this.mesh)
  }
}
