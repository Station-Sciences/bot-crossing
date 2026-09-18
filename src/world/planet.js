import * as THREE from 'three'
import { atlasTexture, hasPart, kitReady, kitUsesVertexColors, part } from './kit.js'
import { withCurve } from '../core/curve.js'

/**
 * The worlds you can put the colony on, and the terrain generator that draws them.
 *
 * A planet is a bag of colours and a few switches — terrain, scatter, sky, water, weather,
 * fauna, ambience and lighting all read from the same preset, so a new world is a data
 * change rather than a code change. The one structural knob is `shape`, which is how a
 * preset says "this is an island" or "the sea is over there": a handful of named ways of
 * bending the same height field, rather than a terrain generator per world.
 *
 * Every field with a default is optional; the three original worlds carry only what they
 * always carried.
 *
 *   water    { level, shallow, deep, foam, ... }   a sea, lakes, or lava — see water.js
 *   shape    'plain' | 'island' | 'coast' | 'dunes' | 'sky'   (sky: a floating island, nothing below)
 *   shore    { color, band }    the sand: how far *above* the waterline, in height, it reaches
 *   weather  [{ kind, rate }]   what drifts through the air — see particles.js
 *   clouds   { amount, color, speed }   cumulus on the sky dome
 *   fauna    { birds, butterflies, fish, drones }   — see fauna.js
 *   audio    { beds, events, shore }   — see audio/ambience.js
 *   grade    { saturation, warmth }   a nudge to the colour grade
 *   grass    { root, tip, height, width, sway }   a field of wispy blades — see grass.js
 */

const DRONES = { count: 3 }

export const PLANETS = {
  moon: {
    id: 'moon',
    name: 'Luna',
    blurb: 'Airless, high contrast, very long shadows.',
    ground: { low: 0x4a4a52, high: 0x8f8d90, tint: 0xb9b4ae },
    rock: 0x6d6a70,
    horizon: 0x14141c,
    sky: { top: 0x05060c, bottom: 0x101018 },
    fog: { color: 0x07080e, near: 100, far: 235 },
    sun: { color: 0xfff4e2, intensity: 2.6, night: 0.05 },
    ambient: { sky: 0x3a4258, ground: 0x4a423a, intensity: 0.7 },
    // No atmosphere: shadows stay black and the stars never wash out.
    atmosphere: 0,
    craters: 26,
    roughness: 0.9,
    scatter: 'rocks',
    companion: { name: 'Earth', color: 0x4a7fc9, size: 5.4, glow: 0x6ea8ff },
    dust: 0,
    fauna: { drones: DRONES },
    audio: {
      beds: [{ sound: 'lunar-silence', gain: 0.5 }],
      events: [],
    },
    grade: { saturation: 0.95, warmth: 0 },
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    blurb: 'Rust, dust, and a pink sky at noon.',
    ground: { low: 0x6b3320, high: 0xb56b40, tint: 0xd89464 },
    rock: 0x8a4a2c,
    horizon: 0x3a2118,
    sky: { top: 0x2b1a1e, bottom: 0xc4703c },
    fog: { color: 0x50301f, near: 82, far: 205 },
    sun: { color: 0xffd9b0, intensity: 2.2, night: 0.09 },
    ambient: { sky: 0xc07a52, ground: 0x4a2418, intensity: 0.75 },
    atmosphere: 0.55,
    craters: 12,
    roughness: 1.15,
    scatter: 'rocks',
    companion: { name: 'Phobos', color: 0x9a8878, size: 1.5, glow: 0xb8a494 },
    dust: 1,
    weather: [{ kind: 'dust', rate: 1 }],
    clouds: { amount: 0.12, color: 0xd8a888, speed: 0.6 },
    fauna: { drones: DRONES },
    audio: {
      beds: [{ sound: 'mars-wind', gain: 0.7 }],
      events: [{ sound: 'wind-gust', every: [14, 40], gain: 0.5, where: 'ring' }],
    },
    grade: { saturation: 1.05, warmth: 0.04 },
  },
  terra: {
    id: 'terra',
    name: 'Terra',
    blurb: 'An earthlike one. Grass, blue hour, fireflies.',
    ground: { low: 0x2f5a34, high: 0x6d9a4a, tint: 0x86ae5c },
    rock: 0x6b6f63,
    horizon: 0x6fa8d8,
    sky: { top: 0x1d4d8f, bottom: 0x9ec8e8 },
    fog: { color: 0x6b8fa8, near: 92, far: 230 },
    sun: { color: 0xfff0d4, intensity: 2.4, night: 0.13 },
    ambient: { sky: 0x88bfe8, ground: 0x3f5a30, intensity: 0.95 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.75,
    scatter: 'flora',
    grass: { sway: 0.6 },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0.25,
    weather: [
      { kind: 'pollen', rate: 0.25 },
      { kind: 'fireflies', rate: 0.6 },
    ],
    clouds: { amount: 0.45, color: 0xffffff, speed: 1 },
    fauna: {
      birds: { kind: 'swallow', count: 8, altitude: [7, 14], colors: [0x3a3a4a, 0x2a2a3a], size: 0.9 },
      butterflies: { count: 12, colors: [0xffd45a, 0xffffff, 0xff9a5a] },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'wind-soft', gain: 0.45 },
        { sound: 'meadow-birds', gain: 0.5, night: 0 },
        { sound: 'crickets', gain: 0, night: 0.6 },
      ],
      events: [
        { sound: 'songbird', every: [7, 20], gain: 0.6, when: 'day', where: 'ring' },
        { sound: 'owl', every: [25, 70], gain: 0.5, when: 'night', where: 'ring' },
        { sound: 'wind-gust', every: [20, 60], gain: 0.35, where: 'ring' },
      ],
    },
    grade: { saturation: 1.12, warmth: 0.03 },
  },

  // ── the eight new ones ────────────────────────────────────────────────────────────

  desert: {
    id: 'desert',
    name: 'Dune',
    blurb: 'Sand seas, heat haze, and a sky that goes on forever.',
    ground: { low: 0xc2884a, high: 0xefc07a, tint: 0xfbe0a8 },
    // Clay on the hull. The neutral structural swatches lean toward this, so the same kit
    // reads as adobe here without a second set of models — see `buildingTint` in buildings.js.
    buildingTint: 0xc9a176,
    rock: 0xb0703f,
    horizon: 0xf6d6a8,
    sky: { top: 0x3a86d8, bottom: 0xf8dfb8 },
    fog: { color: 0xecc99c, near: 95, far: 250 },
    sun: { color: 0xfff2d8, intensity: 2.7, night: 0.1 },
    ambient: { sky: 0xb0d0f2, ground: 0x9a6a38, intensity: 0.95 },
    atmosphere: 0.9,
    craters: 0,
    roughness: 1.25,
    shape: 'dunes',
    scatter: 'desert',
    companion: { name: 'Moon', color: 0xe8e0d0, size: 3.0, glow: 0xfff0d8 },
    dust: 0.5,
    weather: [{ kind: 'sand', rate: 0.6 }],
    clouds: { amount: 0.14, color: 0xffffff, speed: 1.2 },
    fauna: {
      birds: { kind: 'crow', count: 5, altitude: [12, 22], colors: [0x2a2420, 0x3a302a], size: 1.2 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'wind-desert', gain: 0.6 },
        { sound: 'crickets', gain: 0, night: 0.45 },
      ],
      events: [
        { sound: 'wind-gust', every: [10, 30], gain: 0.55, where: 'ring' },
        { sound: 'coyote', every: [40, 120], gain: 0.4, when: 'night', where: 'ring' },
        { sound: 'crow', every: [15, 45], gain: 0.4, when: 'day', where: 'ring' },
      ],
    },
    grade: { saturation: 1.08, warmth: 0.08 },
  },

  jungle: {
    id: 'jungle',
    name: 'Canopy',
    blurb: 'Humid, loud, and green all the way down. Lakes in the hollows.',
    ground: { low: 0x1f4f2b, high: 0x4f8f3c, tint: 0x83b64c },
    rock: 0x5c6552,
    horizon: 0xa8d8c8,
    sky: { top: 0x2a70b4, bottom: 0xc4e6da },
    fog: { color: 0x8fbfa8, near: 62, far: 195 },
    sun: { color: 0xfff6dc, intensity: 2.3, night: 0.12 },
    ambient: { sky: 0x7fbfa0, ground: 0x2a4a22, intensity: 1.0 },
    atmosphere: 1,
    craters: 9,
    roughness: 1.0,
    scatter: 'jungle',
    grass: { root: 0x1f5a2e, tip: 0x6fbf4c, height: [0.45, 0.95], sway: 0.45 },
    water: { level: -1.0, shallow: 0x46c8b0, deep: 0x175a62, foam: 0xe8fff4, waveHeight: 0.05, sparkle: 0.5 },
    shore: { color: 0x7a6a44, band: 0.5 },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0.35,
    weather: [
      { kind: 'pollen', rate: 0.5 },
      { kind: 'fireflies', rate: 1 },
    ],
    clouds: { amount: 0.55, color: 0xffffff, speed: 0.8 },
    fauna: {
      birds: { kind: 'parrot', count: 9, altitude: [6, 13], colors: [0xe83a3a, 0x3ac0e8, 0xf5c542, 0x3ae86a], size: 1.0 },
      butterflies: { count: 26, colors: [0x4ad0ff, 0xffd84a, 0xff6ab0, 0xffffff] },
      fish: { count: 5 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'jungle-insects', gain: 0.55, night: 0.75 },
        { sound: 'jungle-birds', gain: 0.5, night: 0.05 },
        { sound: 'rainforest-rain', gain: 0.2 },
      ],
      events: [
        { sound: 'parrot', every: [6, 18], gain: 0.55, when: 'day', where: 'ring' },
        { sound: 'thunder-distant', every: [50, 160], gain: 0.5, where: 'ring' },
        { sound: 'fish-splash', every: [20, 50], gain: 0.3, where: 'water' },
      ],
      shore: true,
    },
    grade: { saturation: 1.15, warmth: 0.0 },
  },

  beach: {
    id: 'beach',
    name: 'Shoreline',
    blurb: 'Green ground, white sand, and the sea along one side.',
    ground: { low: 0x4d9a48, high: 0x8fcc5c, tint: 0xb9e072 },
    rock: 0xb4ac9c,
    horizon: 0xc4e9f2,
    sky: { top: 0x2f88dc, bottom: 0xd2ecf6 },
    fog: { color: 0xb4dcec, near: 150, far: 330 },
    sun: { color: 0xfff4e0, intensity: 2.5, night: 0.13 },
    ambient: { sky: 0x9fd4f0, ground: 0x6a8a48, intensity: 1.0 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.6,
    shape: 'coast',
    scatter: 'beach',
    grass: { sway: 0.7 },
    water: { level: -1.6, shallow: 0x52dcd4, deep: 0x1c6fba, foam: 0xffffff, waveHeight: 0.14, sparkle: 1 },
    shore: { color: 0xf3e4b4, band: 1.0 },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0,
    weather: [{ kind: 'spray', rate: 0.25 }],
    clouds: { amount: 0.55, color: 0xffffff, speed: 1 },
    fauna: {
      birds: { kind: 'gull', count: 10, altitude: [5, 14], colors: [0xffffff, 0xf2f2f2], size: 1.1 },
      butterflies: { count: 8, colors: [0xffd45a, 0xffffff] },
      fish: { count: 6 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'surf', gain: 0.6, shore: true },
        { sound: 'wind-soft', gain: 0.35 },
        { sound: 'crickets', gain: 0, night: 0.3 },
      ],
      events: [
        { sound: 'gull', every: [6, 18], gain: 0.55, when: 'day', where: 'ring' },
        { sound: 'wave-crash', every: [9, 22], gain: 0.5, where: 'water' },
        { sound: 'fish-splash', every: [15, 40], gain: 0.3, where: 'water' },
      ],
      shore: true,
    },
    grade: { saturation: 1.15, warmth: 0.04 },
  },

  ocean: {
    id: 'ocean',
    name: 'Archipelago',
    blurb: 'One island, a few more on the horizon, and water everywhere else.',
    ground: { low: 0x3f8a44, high: 0x7fbf55, tint: 0xa8d868 },
    rock: 0xb0a898,
    horizon: 0xc0e4f4,
    sky: { top: 0x2470c8, bottom: 0xd4ecfa },
    fog: { color: 0xaed4ea, near: 150, far: 330 },
    sun: { color: 0xfff6e4, intensity: 2.5, night: 0.13 },
    ambient: { sky: 0x98cff0, ground: 0x4c7a4a, intensity: 1.0 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.7,
    shape: 'island',
    scatter: 'ocean',
    grass: { sway: 0.8 },
    water: { level: -1.7, shallow: 0x3fd4cc, deep: 0x0e4c98, foam: 0xffffff, waveHeight: 0.18, sparkle: 1 },
    shore: { color: 0xf3e6ba, band: 1.0 },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0,
    weather: [{ kind: 'spray', rate: 0.35 }],
    clouds: { amount: 0.6, color: 0xffffff, speed: 1.1 },
    fauna: {
      birds: { kind: 'gull', count: 12, altitude: [5, 16], colors: [0xffffff, 0xf0f0f0], size: 1.1 },
      fish: { count: 9 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'ocean-swell', gain: 0.55, shore: true },
        { sound: 'surf-gentle', gain: 0.4, shore: true },
        { sound: 'wind-soft', gain: 0.4 },
      ],
      events: [
        { sound: 'gull', every: [5, 15], gain: 0.55, when: 'day', where: 'ring' },
        { sound: 'wave-crash', every: [7, 18], gain: 0.5, where: 'water' },
        { sound: 'fish-splash', every: [10, 30], gain: 0.35, where: 'water' },
      ],
      shore: true,
    },
    grade: { saturation: 1.15, warmth: 0.02 },
  },

  tundra: {
    id: 'tundra',
    name: 'Frost',
    blurb: 'Snow, frozen lakes, and pines holding their breath.',
    ground: { low: 0xc4d4e0, high: 0xf4f8fc, tint: 0xe4eef6 },
    rock: 0x6c7684,
    horizon: 0xdbe8f2,
    sky: { top: 0x3f70ac, bottom: 0xdceaf4 },
    fog: { color: 0xd4e2ec, near: 95, far: 245 },
    sun: { color: 0xfff8f0, intensity: 2.2, night: 0.14 },
    ambient: { sky: 0xa8c4e0, ground: 0x8fa0b0, intensity: 0.95 },
    atmosphere: 0.85,
    craters: 6,
    roughness: 0.9,
    scatter: 'tundra',
    water: { level: -1.1, shallow: 0xc4ecf6, deep: 0x5aa6d2, foam: 0xffffff, waveHeight: 0.015, speed: 0.25, sparkle: 0.8, opacity: 0.96 },
    shore: { color: 0xe8f0f4, band: 0.4 },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0,
    weather: [{ kind: 'snow', rate: 1 }],
    clouds: { amount: 0.5, color: 0xe4ecf2, speed: 0.7 },
    fauna: {
      birds: { kind: 'crow', count: 5, altitude: [8, 16], colors: [0x1e1e24, 0x2c2a30], size: 1.1 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'snow-wind', gain: 0.55 },
        { sound: 'wind-arctic', gain: 0.35, night: 0.5 },
      ],
      events: [
        // A frozen lake groans now and then, from far off; it does not crunch underfoot.
        { sound: 'ice-crack', every: [50, 140], gain: 0.35, where: 'water' },
        { sound: 'crow', every: [15, 45], gain: 0.35, when: 'day', where: 'ring' },
        { sound: 'owl', every: [30, 90], gain: 0.4, when: 'night', where: 'ring' },
        { sound: 'wind-gust', every: [12, 35], gain: 0.5, where: 'ring' },
      ],
    },
    grade: { saturation: 0.95, warmth: -0.05 },
  },

  sky: {
    id: 'sky',
    name: 'Aerie',
    blurb: 'A floating island. Roots and vines over the edge, clouds all the way down.',
    ground: { low: 0x4f9450, high: 0x93cc64, tint: 0xbfe08a },
    rock: 0x8c8478,
    horizon: 0xd8ecf8,
    sky: { top: 0x3a86dc, bottom: 0xdcecf8 },
    fog: { color: 0xc8e0f2, near: 120, far: 300 },
    sun: { color: 0xfff4e0, intensity: 2.5, night: 0.14 },
    ambient: { sky: 0xa8d4f4, ground: 0x6a8a58, intensity: 1.05 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.7,
    shape: 'sky',
    scatter: 'flora',
    grass: { sway: 0.85 },
    skyIsland: { rock: 0x6e6256, soil: 0x7a5a3c, vine: 0x4f8f3a, cloud: 0xffffff, cloudLevel: -60, depth: 74 },
    companion: { name: 'Moon', color: 0xe8e4dc, size: 3.0, glow: 0xfff6e0 },
    dust: 0.15,
    weather: [
      { kind: 'pollen', rate: 0.3 },
      { kind: 'fireflies', rate: 0.6 },
    ],
    clouds: { amount: 0.7, color: 0xffffff, speed: 1.3 },
    fauna: {
      birds: { kind: 'swallow', count: 14, altitude: [4, 12], colors: [0x3a3a4a, 0x2a2a3a], size: 0.9 },
      butterflies: { count: 10, colors: [0xffd45a, 0xffffff, 0x9ad0ff] },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'wind-high', gain: 0.45 },
        { sound: 'wind-soft', gain: 0.4 },
        { sound: 'meadow-birds', gain: 0.4, night: 0 },
        { sound: 'crickets', gain: 0, night: 0.4 },
      ],
      events: [
        { sound: 'wind-gust', every: [8, 24], gain: 0.55, where: 'ring' },
        { sound: 'songbird', every: [9, 25], gain: 0.5, when: 'day', where: 'ring' },
      ],
    },
    grade: { saturation: 1.15, warmth: 0.02 },
  },

  volcanic: {
    id: 'volcanic',
    name: 'Cinder',
    blurb: 'Ash, embers, and lava pooling in every hollow.',
    ground: { low: 0x2a2422, high: 0x5c4c46, tint: 0x7e5e4c },
    rock: 0x3c3432,
    horizon: 0x5a2c20,
    sky: { top: 0x2c1c22, bottom: 0x9a4e30 },
    fog: { color: 0x4c3028, near: 58, far: 175 },
    sun: { color: 0xffc890, intensity: 1.9, night: 0.22 },
    ambient: { sky: 0x8a5a48, ground: 0x3c2218, intensity: 0.95 },
    atmosphere: 0.7,
    craters: 14,
    roughness: 1.4,
    scatter: 'volcanic',
    water: {
      level: -1.4,
      shallow: 0xff8a20,
      deep: 0x8c1c06,
      foam: 0xffd878,
      waveHeight: 0.05,
      waveScale: 0.5,
      speed: 0.3,
      sparkle: 0,
      opacity: 1,
      glow: 1.8,
    },
    shore: { color: 0x1c1614, band: 0.6 },
    companion: { name: 'Ember', color: 0xc85a3a, size: 2.4, glow: 0xff7a50 },
    dust: 0.5,
    weather: [
      { kind: 'embers', rate: 1 },
      { kind: 'ash', rate: 0.7 },
    ],
    clouds: { amount: 0.35, color: 0x5a3c34, speed: 0.9 },
    fauna: { drones: DRONES },
    audio: {
      beds: [
        { sound: 'lava-rumble', gain: 0.6 },
        { sound: 'volcanic-hiss', gain: 0.35 },
        { sound: 'wind-high', gain: 0.25 },
      ],
      events: [
        { sound: 'ember-pop', every: [3, 10], gain: 0.4, where: 'water' },
        { sound: 'geyser', every: [25, 70], gain: 0.55, where: 'ring' },
        { sound: 'thunder-distant', every: [40, 120], gain: 0.45, where: 'ring' },
      ],
      shore: false,
    },
    grade: { saturation: 1.05, warmth: 0.1 },
  },

  autumn: {
    id: 'autumn',
    name: 'Harvest',
    blurb: 'Gold light, red leaves, and a pond with something in it.',
    ground: { low: 0x55702e, high: 0xa4a640, tint: 0xd0b44c },
    rock: 0xa89a88,
    horizon: 0xf4cc94,
    sky: { top: 0x3f7fc4, bottom: 0xf8dcbc },
    fog: { color: 0xdcbc9c, near: 88, far: 225 },
    sun: { color: 0xffe2b4, intensity: 2.3, night: 0.12 },
    ambient: { sky: 0xa8bcd8, ground: 0x6c4c28, intensity: 0.95 },
    atmosphere: 1,
    craters: 4,
    roughness: 0.85,
    scatter: 'autumn',
    grass: { root: 0x6a5a26, tip: 0xd8b24a, height: [0.3, 0.6], sway: 0.65 },
    water: { level: -1.05, shallow: 0x74b4a4, deep: 0x2c5c6c, foam: 0xf4f8f0, waveHeight: 0.04, sparkle: 0.6 },
    shore: { color: 0x8c7448, band: 0.5 },
    companion: { name: 'Moon', color: 0xe8dcc4, size: 3.4, glow: 0xffe8c0 },
    dust: 0.2,
    weather: [{ kind: 'leaves', rate: 0.8 }],
    clouds: { amount: 0.4, color: 0xfff4e8, speed: 0.9 },
    fauna: {
      birds: { kind: 'crow', count: 6, altitude: [7, 15], colors: [0x1e1a1a, 0x2e2828], size: 1.1 },
      butterflies: { count: 6, colors: [0xffb84a, 0xffffff] },
      fish: { count: 2 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'autumn-rustle', gain: 0.5 },
        { sound: 'wind-soft', gain: 0.35 },
        { sound: 'crickets', gain: 0, night: 0.5 },
      ],
      events: [
        { sound: 'crow', every: [10, 30], gain: 0.45, when: 'day', where: 'ring' },
        { sound: 'songbird', every: [12, 35], gain: 0.4, when: 'day', where: 'ring' },
        { sound: 'owl', every: [25, 70], gain: 0.5, when: 'night', where: 'ring' },
        { sound: 'fish-splash', every: [30, 80], gain: 0.3, where: 'water' },
      ],
      shore: true,
    },
    grade: { saturation: 1.12, warmth: 0.1 },
  },

  sakura: {
    id: 'sakura',
    name: 'Blossom',
    blurb: 'Cherry trees in full bloom, and petals on everything.',
    ground: { low: 0x5e9a56, high: 0xa2d26c, tint: 0xc8e48e },
    rock: 0xb4b4bc,
    horizon: 0xfad8e4,
    sky: { top: 0x5f8fda, bottom: 0xfce6ee },
    fog: { color: 0xeaccd8, near: 96, far: 238 },
    sun: { color: 0xfff2ea, intensity: 2.4, night: 0.14 },
    ambient: { sky: 0xd4c4ec, ground: 0x5c7c42, intensity: 1.0 },
    atmosphere: 1,
    craters: 2,
    roughness: 0.7,
    scatter: 'sakura',
    grass: { root: 0x4a8a3c, tip: 0xb8e07a, sway: 0.55 },
    water: { level: -0.95, shallow: 0x92dcdc, deep: 0x3a7cb4, foam: 0xffffff, waveHeight: 0.04, sparkle: 0.8 },
    shore: { color: 0xbcae86, band: 0.5 },
    companion: { name: 'Moon', color: 0xf0e4e0, size: 3.4, glow: 0xffe4ec },
    dust: 0.1,
    weather: [{ kind: 'petals', rate: 1 }],
    clouds: { amount: 0.35, color: 0xffffff, speed: 0.8 },
    fauna: {
      birds: { kind: 'swallow', count: 8, altitude: [6, 13], colors: [0x3a3a4a, 0x2a2a3a], size: 0.9 },
      butterflies: { count: 22, colors: [0xffffff, 0xffc6dc, 0xfff0a0] },
      fish: { count: 2 },
      drones: DRONES,
    },
    audio: {
      beds: [
        { sound: 'cherry-breeze', gain: 0.5 },
        { sound: 'meadow-birds', gain: 0.45, night: 0 },
        { sound: 'crickets', gain: 0, night: 0.5 },
        { sound: 'stream', gain: 0.2 },
      ],
      events: [
        { sound: 'songbird', every: [6, 18], gain: 0.55, when: 'day', where: 'ring' },
        { sound: 'wind-gust', every: [18, 50], gain: 0.3, where: 'ring' },
      ],
      shore: true,
    },
    grade: { saturation: 1.15, warmth: 0.04 },
  },
}

/** Display order for the picker: home first, then outward, then the pretty ones. */
export const PLANET_ORDER = ['moon', 'mars', 'terra', 'beach', 'ocean', 'jungle', 'desert', 'tundra', 'autumn', 'sakura', 'volcanic', 'sky']

export const GROUND_SIZE = 340
/** Everything inside this radius is the buildable colony, and is kept nearly flat. */
export const COLONY_RADIUS = 46
const DETAIL_SEGMENTS = { low: 72, medium: 128, high: 190 }

/** Where the sea is, on a coast: the far side of the default view, so you look out to it. */
const COAST_DIR = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }
/** How far out the land ends on a coast. Past the colony, before the far hills. */
const COAST_OFFSET = 58
/** The island's outer islets start past here; the island itself is the colony's footprint. */
const ISLAND_RADIUS = 60
/** How far the beach runs out from the last hex cell before the bed drops into the sea. */
const ISLAND_BEACH = 5
const ISLAND_SHELF = 26
/** The hex cells the island is built around — the colony hands them over as it grows. */
let _islandCells = []
let _islandReach = ISLAND_RADIUS
/** How far under the sea the bed settles, on either shape. Deep enough to read as sea. */
const SEA_DEPTH = 7
/** How far past the plots a floating island's ground reaches: a grass margin, then nothing. */
export const SKY_MARGIN = 3.2
/** The most hex cells the sky terrain's cut-out can be told about. */
export const SKY_MAX_CELLS = 96

/**
 * Terrain is one plane, displaced and vertex-coloured on the CPU at build time. Doing it
 * once and baking it into the buffer means the GPU only ever sees static geometry — no
 * displacement map sample, no per-frame work — and vertex colours give the surface its
 * mottling for free rather than costing a texture fetch.
 */
export function createTerrain(planet, detail, seed = 1337) {
  const segments = DETAIL_SEGMENTS[detail] || DETAIL_SEGMENTS.medium
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, segments, segments)
  geo.rotateX(-Math.PI / 2)

  const field = fieldFor(planet, seed)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)

  const low = new THREE.Color(planet.ground.low)
  const high = new THREE.Color(planet.ground.high)
  const tint = new THREE.Color(planet.ground.tint)
  const sand = planet.shore ? new THREE.Color(planet.shore.color) : null
  const bed = planet.water ? new THREE.Color(planet.water.deep).multiplyScalar(0.45) : null
  const c = new THREE.Color()
  const level = planet.water?.level ?? -Infinity
  const band = planet.shore?.band ?? 0

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.hypot(x, z)
    const y = sampleHeight(x, z, field, planet)
    pos.setY(i, y)

    // Colour: height-driven blend, mottled with a second noise band so it never bands.
    const shade = THREE.MathUtils.clamp(0.42 + y * 0.09 + fbm(field.noise, x * 0.09, z * 0.09, 2) * 0.5, 0, 1)
    c.copy(low).lerp(high, shade)
    const speck = fbm(field.noise, x * 0.55, z * 0.55, 1)
    c.lerp(tint, Math.max(0, speck) * 0.22)

    // The sand band, then the bed: ground within reach of the water goes to the shore
    // colour, strongest right at the waterline, and anything under the surface darkens
    // toward the deep colour so the shallows read as shallows through the water.
    if (sand && band > 0) {
      const above = y - level
      const dry = 1 - THREE.MathUtils.smoothstep(above, band * 0.55, band * 1.25)
      const wet = 1 - THREE.MathUtils.smoothstep(-above, 0, 2.5)
      c.lerp(sand, THREE.MathUtils.clamp(dry * wet, 0, 1) * 0.92)
    }
    if (bed && y < level) {
      c.lerp(bed, THREE.MathUtils.clamp((level - y) / 6, 0, 1))
    }
    // Darken the far field so the eye settles on the colony and the hills read as a
    // silhouette rather than as more ground competing with the plots for attention.
    // Gentler than it was: a bright little world should stay bright to its edges.
    c.multiplyScalar(1 - THREE.MathUtils.smoothstep(dist, COLONY_RADIUS * 0.8, GROUND_SIZE * 0.36) * 0.55)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    // Flat-ish shading keeps the low-poly read; a dielectric surface with no spec highlight
    // is what sells "dust" rather than "plastic".
    envMapIntensity: 0.3,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'

  if (planet.shape === 'sky') {
    // A floating island has ground exactly where the colony's hex cells are, plus a margin
    // of grass, and nothing anywhere else. The plane still has to exist — the height field
    // is sampled off it — so the fragments outside the footprint are thrown away instead,
    // measured in the shader as the distance to the nearest cell centre. The footprint is
    // handed in by the colony whenever a zone grows or shrinks; the island grows with it.
    const cells = { value: Array.from({ length: SKY_MAX_CELLS }, () => new THREE.Vector2(1e6, 1e6)) }
    const uniforms = { uSkyCells: cells, uSkyCellCount: { value: 0 }, uSkyReach: { value: 8 } }
    mat.onBeforeCompile = (shader) => {
      withCurve(shader)
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n varying vec2 vSkyXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vSkyXZ = transformed.xz;')
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec2 vSkyXZ;
           uniform vec2 uSkyCells[ ${SKY_MAX_CELLS} ];
           uniform int uSkyCellCount;
           uniform float uSkyReach;
           float bcHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
           float bcNoise( vec2 p ) {
             vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
             return mix( mix( bcHash( i ), bcHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( bcHash( i + vec2( 0.0, 1.0 ) ), bcHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
           }`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           {
             float bcNear = 1e9;
             for ( int i = 0; i < ${SKY_MAX_CELLS}; i++ ) {
               if ( i >= uSkyCellCount ) break;
               bcNear = min( bcNear, distance( vSkyXZ, uSkyCells[ i ] ) );
             }
             // The edge is ragged, not a run of arcs: the reach wanders with a little noise,
             // so the grass frays over the rock lip in bites and tongues.
             float bcFray = bcNoise( vSkyXZ * 0.55 ) * 0.7 + bcNoise( vSkyXZ * 1.7 ) * 0.3;
             if ( bcNear > uSkyReach * ( 0.78 + 0.34 * bcFray ) ) discard;
           }`
        )
    }
    mat.customProgramCacheKey = () => 'bc-terrain-sky'
    mesh.userData.setFootprint = (list, reach) => {
      const n = Math.min(list.length, SKY_MAX_CELLS)
      for (let i = 0; i < SKY_MAX_CELLS; i++) {
        if (i < n) cells.value[i].set(list[i].x, list[i].z)
        else cells.value[i].set(1e6, 1e6)
      }
      uniforms.uSkyCellCount.value = n
      uniforms.uSkyReach.value = reach
    }
  }

  // Sampler so anything placed later can sit exactly on the surface.
  mesh.userData.heightAt = (x, z) => sampleHeight(x, z, field, planet)
  return mesh
}

/**
 * The height field, in full.
 *
 * Flat where the colony lives, then hills that ramp in over the next forty metres — so
 * nothing ever builds on a slope but the horizon still has shape to it. The named shapes
 * then reshape the far field: an island drops the ground into the sea past a radius, a
 * coast does the same past a line, dunes lay long ridges over everything.
 */
function sampleHeight(x, z, field, planet) {
  const { noise, craters, islets } = field
  const dist = Math.hypot(x, z)
  const outside = THREE.MathUtils.smoothstep(dist, COLONY_RADIUS - 6, COLONY_RADIUS + 40)
  const gentle = fbm(noise, x * 0.035, z * 0.035, 3) * 0.5
  let broad = fbm(noise, x * 0.012, z * 0.012, 4)
  // On a world whose water is meant to sit in its hollows — lakes, ponds, lava pools —
  // the far field has to stay *above* the waterline, or every dip in the hills floods and
  // the colony ends up on an island it was never meant to be on. Folding the broad noise
  // turns its valleys into ridges, so only the crater bowls dip below the surface.
  const lakes = planet.water && planet.shape !== 'island' && planet.shape !== 'coast'
  if (lakes) broad = Math.abs(broad) * 0.9 + 0.08
  let hills = broad * 9 + fbm(noise, x * 0.05, z * 0.05, 2) * 1.4

  let sea = 0 // 0 on land, 1 where the sea bed has fully taken over
  if (planet.shape === 'island') {
    // Land is the colony's own hex footprint plus a beach, and the sea takes over past
    // that — so a repo claiming a tile pushes the coast out, and a repo folding away lets
    // the water back in. The waterline wanders a little so it is a coast, not a stencil.
    let near = dist
    for (let i = 0; i < _islandCells.length; i++) {
      const c = _islandCells[i]
      const d = Math.hypot(x - c.x, z - c.z)
      if (d < near || i === 0) near = d
    }
    const wobble = fbm(noise, x * 0.03 + 5, z * 0.03 + 9, 2) * 6
    sea = THREE.MathUtils.smoothstep(near + wobble, _islandReach, _islandReach + ISLAND_SHELF)
  } else if (planet.shape === 'coast') {
    const along = x * COAST_DIR.x + z * COAST_DIR.z
    // The waterline wanders, or the beach is a ruler.
    const wobble = fbm(noise, x * 0.02 + 7, z * 0.02 + 3, 2) * 9
    sea = THREE.MathUtils.smoothstep(along + wobble, COAST_OFFSET - 4, COAST_OFFSET + 32)
  }
  // A floating island is only as big as the colony on it, and everything past that is cut
  // away in the terrain shader (see createTerrain); the field itself stays gentle out there
  // so the rim is level with the plots, and nothing needs to know where the edge is here.
  if (planet.shape === 'sky') hills *= 0.15
  if (planet.shape === 'dunes') {
    // Long ridges running one way, bent by noise so they read as wind-blown rather than
    // corrugated. Faint inside the colony, tall past it.
    const bend = fbm(noise, x * 0.01, z * 0.01, 2) * 18
    const ridge = Math.pow(0.5 + 0.5 * Math.sin((x * 0.7 + z * 0.3) * 0.13 + bend), 1.6)
    hills += ridge * 4.5 - 1.5
  }

  let y = gentle * planet.roughness * (1 - outside) + hills * outside * planet.roughness
  if (sea > 0) {
    // Hills sink with the land rather than poking up out of the water as pinnacles. The bed
    // falls away slowly at first and steeply later, which is what makes a beach a beach:
    // a long shallow run before the drop, and a broad band of sand above the waterline.
    y = y * (1 - sea) - SEA_DEPTH * Math.pow(sea, 1.7)
    for (const islet of islets) {
      const d = Math.hypot(x - islet.x, z - islet.z)
      if (d > islet.r) continue
      const t = 1 - d / islet.r
      y += islet.h * t * t * (3 - 2 * t) * sea
    }
  }

  for (const crater of craters) {
    const d = Math.hypot(x - crater.x, z - crater.z)
    if (d > crater.r * 1.5) continue
    // A bowl with a raised rim — the rim is what makes it read as an impact.
    const t = d / crater.r
    if (t < 1) {
      if (lakes) {
        // On a lake world the bowl is dug down to the *water*, not down from the ground:
        // the folded hills stand anything up to nine units proud of the waterline, and a
        // bowl measured from the ground would be a dry dent on top of a hill. The floor
        // sits half the crater's depth under the surface and the sides run up to meet
        // whatever ground is there, so every crater is a lake and none is a puddle.
        const floor = planet.water.level - crater.depth * 0.5
        y = Math.min(y, floor + (y - floor) * t * t)
      } else {
        y -= (1 - t * t) * crater.depth
      }
    } else {
      y += (1 - Math.abs(t - 1.22) / 0.28) * crater.depth * 0.32
    }
  }
  return y
}

/** Craters only ever land outside the colony, so they never eat a build plot. */
function makeCraters(count, seed) {
  const rand = mulberry(seed ^ 0x9e37)
  const out = []
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const d = COLONY_RADIUS + 14 + rand() * 110
    const r = 4 + rand() * 16
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r, depth: r * (0.18 + rand() * 0.16) })
  }
  return out
}

/** The smaller islands out past the main one. Fixed per seed, like everything else here. */
function makeIslets(planet, seed) {
  if (planet.shape !== 'island') return []
  const rand = mulberry(seed ^ 0x51ed)
  const out = []
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2
    const d = ISLAND_RADIUS + ISLAND_SHELF + 18 + rand() * 60
    const r = 9 + rand() * 14
    // Tall enough to clear the sea bed *and* the waterline with room for a palm or two.
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r, h: SEA_DEPTH + 1.6 + rand() * 2.2 })
  }
  return out
}

// ── scatter ───────────────────────────────────────────────────────────────────────────

const SCATTER_BUDGET = 2400

/**
 * What grows on a world, and how it is planted.
 *
 * `weight` is how often a shape comes up relative to its siblings, `size` the range of its
 * base scale, and `sink` how far into the ground it settles as a fraction of that scale.
 * A boulder half-buried reads as bedrock; a tree buried by the same amount reads as a
 * mistake, so the two want very different numbers.
 *
 * `kit` says which pack a part comes from — KayKit's Forest pack, or Kenney's Nature Kit,
 * which is authored about a third the size and so wants about three times the scale.
 * `zone` keeps a part to the ground it belongs on: `shore` within the sand band, `water`
 * standing in the shallows, everything else on dry land clear of the water.
 *
 * Boulders are painted neutral grey in both packs, so a per-instance tint takes the same
 * rock to lunar dust, Martian rust or cinder without touching a texture.
 */
const N = 'nature'
const SCATTER = {
  flora: [
    { part: 'Tree_1_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_3_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_4_A_Color1', weight: 2, size: [0.3, 0.55], sink: 0.02, upright: true },
    { part: 'Tree_1_C_Color1', weight: 1, size: [0.25, 0.4], sink: 0.02, upright: true },
    { part: 'Tree_3_C_Color1', weight: 1, size: [0.22, 0.38], sink: 0.02, upright: true },
    { part: 'Tree_4_C_Color1', weight: 1, size: [0.2, 0.35], sink: 0.02, upright: true },
    { part: 'Bush_1_E_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Bush_3_B_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.3], sink: 0.05, upright: true },
    { part: 'Rock_1_D_Color1', weight: 2, size: [0.4, 0.9], sink: 0.3, tint: true },
  ],
  rocks: [
    { part: 'Rock_1_D_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_2_C_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_3_E_Color1', weight: 3, size: [0.6, 1.4], sink: 0.15, tint: true },
    { part: 'Rock_1_J_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_2_G_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_3_L_Color1', weight: 2, size: [0.4, 0.9], sink: 0.12, tint: true },
    { part: 'Rock_3_Q_Color1', weight: 1, size: [0.25, 0.55], sink: 0.1, tint: true },
  ],
  desert: [
    { part: 'cactus_tall', kit: N, weight: 4, size: [1.4, 2.4], sink: 0.03, upright: true },
    { part: 'cactus_short', kit: N, weight: 3, size: [1.2, 2.0], sink: 0.03, upright: true },
    { part: 'plant_flatShort', kit: N, weight: 3, size: [1.6, 2.6], sink: 0.04, upright: true },
    { part: 'plant_flatTall', kit: N, weight: 2, size: [1.6, 2.6], sink: 0.04, upright: true },
    { part: 'rock_tallA', kit: N, weight: 2, size: [1.4, 3.0], sink: 0.1, tint: true },
    { part: 'rock_tallC', kit: N, weight: 2, size: [1.4, 2.6], sink: 0.1, tint: true },
    { part: 'stone_tallB', kit: N, weight: 1, size: [1.6, 3.2], sink: 0.12, tint: true },
    { part: 'stone_largeB', kit: N, weight: 2, size: [1.6, 3.2], sink: 0.2, tint: true },
    { part: 'statue_columnDamaged', kit: N, weight: 0.4, size: [1.8, 2.6], sink: 0.1, upright: true, tint: true },
    { part: 'statue_obelisk', kit: N, weight: 0.2, size: [2.0, 3.0], sink: 0.1, upright: true, tint: true },
    { part: 'Rock_1_D_Color1', weight: 3, size: [0.5, 1.3], sink: 0.3, tint: true },
    { part: 'Rock_3_E_Color1', weight: 2, size: [0.6, 1.4], sink: 0.15, tint: true },
  ],
  jungle: [
    { part: 'tree_fat_jungle', kit: N, weight: 3, size: [1.6, 2.6], sink: 0.03, upright: true },
    { part: 'tree_detailed_jungle', kit: N, weight: 3, size: [1.5, 2.5], sink: 0.03, upright: true },
    { part: 'tree_oak_jungle', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_plateau_jungle', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_tall_jungle', kit: N, weight: 2, size: [1.6, 2.6], sink: 0.03, upright: true },
    { part: 'tree_palmDetailedTall', kit: N, weight: 1, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'plant_bushLarge', kit: N, weight: 4, size: [1.6, 3.0], sink: 0.05, upright: true },
    { part: 'plant_bushDetailed', kit: N, weight: 3, size: [1.4, 2.4], sink: 0.05, upright: true },
    { part: 'grass_leafsLarge', kit: N, weight: 4, size: [1.6, 2.8], sink: 0.05, upright: true },
    { part: 'flower_redA', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'flower_purpleA', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'lily_large', kit: N, weight: 2, size: [1.6, 2.6], sink: 0, upright: true, zone: 'water' },
    { part: 'lily_small', kit: N, weight: 2, size: [1.6, 2.6], sink: 0, upright: true, zone: 'water' },
    { part: 'Rock_2_C_Color1', weight: 1, size: [0.5, 1.1], sink: 0.3, tint: true },
  ],
  beach: [
    { part: 'tree_palm', kit: N, weight: 3, size: [1.5, 2.3], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmBend', kit: N, weight: 3, size: [1.5, 2.3], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmDetailedTall', kit: N, weight: 2, size: [1.6, 2.4], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmShort', kit: N, weight: 2, size: [1.3, 2.0], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'Tree_1_A_Color1', weight: 2, size: [0.35, 0.55], sink: 0.02, upright: true },
    { part: 'Tree_3_A_Color1', weight: 2, size: [0.35, 0.55], sink: 0.02, upright: true },
    { part: 'Bush_1_E_Color1', weight: 3, size: [0.5, 1.0], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.2], sink: 0.05, upright: true },
    { part: 'flower_yellowA', kit: N, weight: 2, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'rock_smallC', kit: N, weight: 2, size: [1.6, 3.0], sink: 0.2, tint: true, zone: 'shore' },
    { part: 'Rock_1_D_Color1', weight: 2, size: [0.4, 0.9], sink: 0.3, tint: true },
    { part: 'canoe', kit: N, weight: 0.3, size: [1.8, 2.2], sink: 0.05, upright: true, zone: 'shore' },
  ],
  ocean: [
    { part: 'tree_palm', kit: N, weight: 3, size: [1.5, 2.3], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmBend', kit: N, weight: 3, size: [1.5, 2.3], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmTall', kit: N, weight: 2, size: [1.6, 2.4], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmDetailedShort', kit: N, weight: 2, size: [1.3, 2.0], sink: 0.03, upright: true, zone: 'shore' },
    { part: 'tree_palmShort', kit: N, weight: 2, size: [1.3, 1.9], sink: 0.03, upright: true },
    { part: 'Tree_1_A_Color1', weight: 1, size: [0.6, 0.9], sink: 0.02, upright: true },
    { part: 'Bush_3_B_Color1', weight: 3, size: [0.5, 1.0], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.2], sink: 0.05, upright: true },
    { part: 'flower_yellowC', kit: N, weight: 2, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'rock_smallC', kit: N, weight: 2, size: [1.6, 3.0], sink: 0.2, tint: true, zone: 'shore' },
    { part: 'Rock_3_E_Color1', weight: 2, size: [0.5, 1.1], sink: 0.15, tint: true },
  ],
  tundra: [
    { part: 'tree_pineTallA_snow', kit: N, weight: 3, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_pineTallB_snow', kit: N, weight: 2, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_pineSmallA_snow', kit: N, weight: 3, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_pineRoundA_snow', kit: N, weight: 2, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_pineDefaultA_snow', kit: N, weight: 2, size: [1.5, 2.3], sink: 0.03, upright: true },
    { part: 'tree_pineSmallB', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.03, upright: true },
    { part: 'log_stack', kit: N, weight: 0.5, size: [1.6, 2.2], sink: 0.05, upright: true },
    { part: 'stone_largeB', kit: N, weight: 2, size: [1.6, 3.0], sink: 0.25, tint: true },
    { part: 'Rock_1_D_Color1', weight: 3, size: [0.5, 1.2], sink: 0.35, tint: true },
    { part: 'Rock_2_C_Color1', weight: 2, size: [0.5, 1.2], sink: 0.35, tint: true },
  ],
  volcanic: [
    { part: 'tree_thin_dead', kit: N, weight: 2, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_tall_dead', kit: N, weight: 1, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_simple_dead', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.03, upright: true },
    { part: 'rock_tallA', kit: N, weight: 3, size: [1.6, 3.4], sink: 0.1, tint: true },
    { part: 'stone_tallD', kit: N, weight: 2, size: [1.6, 3.0], sink: 0.12, tint: true },
    { part: 'Rock_1_D_Color1', weight: 4, size: [0.5, 1.3], sink: 0.3, tint: true },
    { part: 'Rock_2_C_Color1', weight: 4, size: [0.5, 1.3], sink: 0.3, tint: true },
    { part: 'Rock_3_E_Color1', weight: 3, size: [0.6, 1.5], sink: 0.15, tint: true },
    { part: 'Rock_3_L_Color1', weight: 2, size: [0.4, 0.9], sink: 0.12, tint: true },
  ],
  autumn: [
    { part: 'tree_default_fall', kit: N, weight: 3, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_detailed_fall', kit: N, weight: 3, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_oak_fall', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_fat_fall', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_thin_fall', kit: N, weight: 1, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_tall_fall', kit: N, weight: 1, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'mushroom_redGroup', kit: N, weight: 2, size: [1.6, 2.6], sink: 0.02, upright: true },
    { part: 'mushroom_tanGroup', kit: N, weight: 2, size: [1.6, 2.6], sink: 0.02, upright: true },
    { part: 'log_large', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'stump_square', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'Grass_2_D_Color1', weight: 3, size: [0.6, 1.2], sink: 0.05, upright: true },
    { part: 'Rock_1_D_Color1', weight: 2, size: [0.4, 0.9], sink: 0.3, tint: true },
  ],
  sakura: [
    { part: 'tree_default_sakura', kit: N, weight: 3, size: [1.4, 2.2], sink: 0.03, upright: true },
    { part: 'tree_detailed_sakura', kit: N, weight: 3, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_oak_sakura', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_fat_sakura', kit: N, weight: 2, size: [1.5, 2.4], sink: 0.03, upright: true },
    { part: 'tree_small_sakura', kit: N, weight: 2, size: [1.4, 2.0], sink: 0.03, upright: true },
    { part: 'Bush_1_E_Color1', weight: 2, size: [0.5, 1.0], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.2], sink: 0.05, upright: true },
    { part: 'flower_purpleC', kit: N, weight: 2, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'flower_yellowA', kit: N, weight: 1, size: [1.4, 2.0], sink: 0.05, upright: true },
    { part: 'lily_small', kit: N, weight: 2, size: [1.6, 2.6], sink: 0, upright: true, zone: 'water' },
    { part: 'Rock_2_C_Color1', weight: 1, size: [0.4, 0.9], sink: 0.3, tint: true },
  ],
}

/** The fallback when the kit has not loaded: the primitives this used to be made of. */
function fallbackShapes(isFlora) {
  const shapes = isFlora
    ? [new THREE.IcosahedronGeometry(0.5, 0), new THREE.ConeGeometry(0.42, 1.5, 5), new THREE.SphereGeometry(0.5, 6, 4)]
    : [
        new THREE.DodecahedronGeometry(0.55, 0),
        new THREE.IcosahedronGeometry(0.6, 0),
        new THREE.TetrahedronGeometry(0.72, 0),
      ]
  for (const g of shapes) g.computeVertexNormals()
  return shapes.map((geo) => ({ geo, sink: 0.25, size: [0.28, 0.83], tint: true, upright: false, kit: 'forest' }))
}

/**
 * Rocks, boulders and plants. All instanced, all placed with a deterministic RNG so the
 * same planet always looks the same, and all kept clear of the plots, the walkways and
 * — where there is any — the water, unless a part is meant to stand in it.
 */
export function createScatter(planet, density, keepClear = [], seed = 4242, inside = null) {
  const group = new THREE.Group()
  group.name = 'scatter'
  // Islands have much less usable ground. Concentrate a smaller budget into groves.
  const count = Math.round(SCATTER_BUDGET * THREE.MathUtils.clamp(density, 0, 1) * (planet.shape === 'island' ? 0.5 : 1))
  if (count <= 0) return group

  const rand = mulberry(seed)
  const isFlora = planet.scatter !== 'rocks'
  const recipe = (SCATTER[planet.scatter] || SCATTER.rocks).map((r) => ({ ...r, kit: r.kit || 'forest' }))
  // A recipe whose parts are all in hand is used whole; one missing a kit — the nature kit
  // failing to load, say — drops to the parts it does have, and to primitives if that is nothing.
  let kinds = recipe.filter((r) => kitReady(r.kit) && hasPart(r.part, r.kit)).map((r) => ({ ...r, geo: part(r.part, r.kit) }))
  if (!kinds.length) kinds = fallbackShapes(isFlora).map((r) => ({ ...r, weight: 1 }))

  // One material per kit. The atlas kit's colour is a *tint* over its texture — white for
  // anything already the right colour, the planet's own rock for a boulder that has to
  // belong to this world — and the vertex-coloured kit is the same idea over its vertices.
  const materials = new Map()
  const materialFor = (kit) => {
    let m = materials.get(kit)
    if (m) return m
    const atlas = kitReady(kit) ? atlasTexture(kit) : null
    m = new THREE.MeshStandardMaterial({
      map: atlas,
      vertexColors: kitUsesVertexColors(kit),
      color: 0xffffff,
      roughness: isFlora ? 0.82 : 0.95,
      metalness: 0,
      flatShading: !kitReady(kit),
    })
    materials.set(kit, m)
    return m
  }

  const total = kinds.reduce((sum, k) => sum + k.weight, 0)
  const meshes = kinds.map((k) => new THREE.InstancedMesh(k.geo, materialFor(k.kit), Math.ceil((count * k.weight) / total) + 8))

  const rock = new THREE.Color(planet.rock)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  const fill = new Array(kinds.length).fill(0)
  const level = planet.water?.level
  const band = planet.shore?.band ?? 0.6

  const pickKind = () => {
    let roll = rand() * total
    for (let i = 0; i < kinds.length; i++) {
      roll -= kinds[i].weight
      if (roll <= 0) return i
    }
    return kinds.length - 1
  }

  // More attempts than placements: on a world that is mostly sea most throws land in it.
  const attempts = planet.water ? count * 6 : count
  const groves = []
  let placed = 0
  for (let i = 0; i < attempts && placed < count; i++) {
    // Near-uniform over the disc, leaning a little toward the colony: the ground you
    // actually look at is the ring just outside the plots, and a strict area-uniform spread
    // leaves it thinner than the far field it is competing with.
    const a = rand() * Math.PI * 2
    let d = 9 + Math.pow(rand(), 0.58) * 150
    let x = Math.cos(a) * d
    let z = Math.sin(a) * d
    // Mixed groups read as vegetation; isolated tiny trees read as scattered props.
    if (isFlora && groves.length && rand() < 0.3) {
      const grove = groves[Math.floor(rand() * groves.length)]
      const offset = 1.2 + rand() * 3
      x = grove.x + Math.cos(a) * offset
      z = grove.z + Math.sin(a) * offset
      d = Math.hypot(x, z)
    }
    if (keepClear.some((p) => Math.hypot(x - p.x, z - p.z) < p.r)) continue
    if (inside && !inside(x, z)) continue

    const which = pickKind()
    const kind = kinds[which]
    const mesh = meshes[which]
    const slot = fill[which]
    if (slot >= mesh.instanceMatrix.count) continue

    const y = sampleY(x, z, planet, seed)
    if (level !== undefined) {
      const above = y - level
      const zone = kind.zone || 'land'
      if (zone === 'land' && above < band * 0.7 + 0.1) continue
      if (zone === 'shore' && (above < 0.12 || above > band * 1.1)) continue
      if (zone === 'water' && (above > -0.05 || above < -1.2)) continue
    }
    placed++
    if (isFlora && kind.upright && (kind.zone || 'land') === 'land' && groves.length < 48) {
      if (!groves.some((g) => Math.hypot(x - g.x, z - g.z) < 6)) groves.push({ x, z })
    }

    // Far-field props are allowed to be much bigger, which reads as distance.
    const far = THREE.MathUtils.smoothstep(d, COLONY_RADIUS, 130)
    const [lo, hi] = kind.size
    const s = (lo + rand() * (hi - lo)) * (1 + far * 1.9)

    // Things in the water float on it rather than stand on the bed.
    const base = kind.zone === 'water' ? level : y
    dummy.position.set(x, base - s * kind.sink, z)
    // A tree that leans is a fallen tree. Boulders may lie however they landed.
    if (kind.upright) dummy.rotation.set(0, rand() * Math.PI * 2, 0)
    else dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5)
    const jitter = kind.upright ? 0.14 : 0.35
    dummy.scale.set(
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter)
    )
    dummy.updateMatrix()
    mesh.setMatrixAt(slot, dummy.matrix)

    // Foliage keeps the colour it was painted; rock takes the planet's. The tint is lifted
    // because it *multiplies* the pack's mid-grey stone, and rust times mid grey is a much
    // darker rust than the ground it sits on.
    if (kind.tint) color.copy(rock).multiplyScalar(1.55)
    else color.setRGB(1, 1, 1)
    color.offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.14)
    mesh.setColorAt(slot, color)
    fill[which] = slot + 1
  }

  meshes.forEach((mesh, i) => {
    mesh.count = fill[i]
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  })
  return group
}

/**
 * Terrain height at a world point — the same field the mesh was built from, evaluated on
 * demand. Used to place scatter, and to keep anything that walks on the ground *on* it.
 */
export function terrainHeight(x, z, planet) {
  return sampleY(x, z, planet, 1337)
}

/**
 * Where the water meets the land, as a scatter of points — what the ambience engine puts
 * its lapping sources at. Sampled on a coarse grid once per planet: a cell under the water
 * with a neighbour above it is a shoreline.
 */
const _shores = new Map()
export function shorelinePoints(planet, spacing = 10) {
  if (!planet.water) return []
  let pts = _shores.get(planet.id)
  if (pts) return pts
  pts = []
  const level = planet.water.level
  const half = GROUND_SIZE / 2 - spacing
  for (let x = -half; x <= half; x += spacing) {
    for (let z = -half; z <= half; z += spacing) {
      if (terrainHeight(x, z, planet) >= level) continue
      const dry =
        terrainHeight(x + spacing, z, planet) >= level ||
        terrainHeight(x - spacing, z, planet) >= level ||
        terrainHeight(x, z + spacing, planet) >= level ||
        terrainHeight(x, z - spacing, planet) >= level
      if (dry) pts.push({ x, z })
    }
  }
  _shores.set(planet.id, pts)
  return pts
}

/**
 * Tell the island worlds which hex cells the colony holds. The field is evaluated on demand
 * everywhere, so this only has to be set before the terrain is (re)built; the shoreline
 * cache goes with it, since the coast has moved.
 */
export function setIslandFootprint(cells, cellRadius) {
  _islandCells = cells.map((c) => ({ x: c.x, z: c.z }))
  _islandReach = cellRadius + ISLAND_BEACH
  _shores.clear()
}

/** Whether a world point is under this planet's water, if it has any. */
export function underWater(x, z, planet) {
  if (!planet.water) return false
  return terrainHeight(x, z, planet) < planet.water.level
}

// The field for a planet is built once and cached: the noise table is 64k floats.
const _fields = new Map()
function fieldFor(planet, seed) {
  const key = `${planet.id}:${seed}`
  let f = _fields.get(key)
  if (!f) {
    f = { noise: makeNoise(seed), craters: makeCraters(planet.craters, seed), islets: makeIslets(planet, seed) }
    _fields.set(key, f)
  }
  return f
}

function sampleY(x, z, planet, seed) {
  return sampleHeight(x, z, fieldFor(planet, 1337), planet)
}

// ── noise ─────────────────────────────────────────────────────────────────────────────

/** Small deterministic PRNG — same seed, same world, every reload. */
export function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value noise on a hashed lattice with smoothstep interpolation — cheap and smooth enough. */
function makeNoise(seed) {
  const rand = mulberry(seed)
  const size = 256
  const table = new Float32Array(size * size)
  for (let i = 0; i < table.length; i++) table[i] = rand() * 2 - 1

  return function noise(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const at = (a, b) => table[(((a % size) + size) % size) * size + (((b % size) + size) % size)]
    const a = at(xi, yi)
    const b = at(xi + 1, yi)
    const c = at(xi, yi + 1)
    const d = at(xi + 1, yi + 1)
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
  }
}

export function fbm(noise, x, y, octaves) {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.07
  }
  return sum / norm
}
