import * as THREE from 'three'
import { OVERLAY_LAYER } from '../core/engine.js'
import { withCurve } from '../core/curve.js'
import {
  mdiChat,
  mdiEmoticonAngry,
  mdiHeartBroken,
  mdiWater,
  mdiHeart,
  mdiSoccer,
  mdiMusicNote,
} from '@mdi/js'

/**
 * The little bubbles bots pop up beside their heads when they socialise: a chat bubble, an
 * anger mark, a broken heart and so on.
 *
 * Built the way the status badges are (one instanced, billboarded quad per bot, sampled from a
 * single atlas drawn out of icon paths, bent with the world), but smaller and pushed to the
 * side of the head so an emote never covers the status badge that sits straight above it.
 */

const COLS = 4
const ROWS = 2

/** Where the bubble's bottom edge sits: level with the helmet's crown, like a badge. */
const HEAD_CLEAR = 1.3

export const EMOTE = {
  chat: 0,
  angry: 1,
  heartbreak: 2,
  sad: 3,
  love: 4,
  ball: 5,
  music: 6,
}

/** HDR tints, tone-mapped with the scene like the badges. */
const EMOTE_COLOR = [
  [1.1, 1.9, 2.8], // chat
  [2.9, 0.5, 0.4], // angry
  [2.6, 0.6, 1.2], // heartbreak
  [0.6, 1.4, 2.9], // sad
  [2.8, 0.8, 1.5], // love
  [2.4, 1.9, 0.7], // ball
  [1.5, 2.4, 0.9], // music
]

const ICON_PATHS = [mdiChat, mdiEmoticonAngry, mdiHeartBroken, mdiWater, mdiHeart, mdiSoccer, mdiMusicNote]

/** Seconds to pop in or out. */
const POP = 0.22

/** The atlas cell of an emote, as the unit-space offset the shader adds to a quad's uvs. */
export function emoteCell(index) {
  const col = index % COLS
  const row = Math.floor(index / COLS)
  return { col, row, u: col / COLS, v: 1 - (row + 1) / ROWS }
}

/** Overshoots a little on the way to 1, which is what makes a pop feel like a pop. */
export function popScale(k) {
  if (k <= 0) return 0
  if (k >= 1) return 1
  const c = 1.70158
  const x = k - 1
  return 1 + (c + 1) * x * x * x + c * x * x
}

export class Emotes {
  constructor(scene, settings, capacity) {
    this.settings = settings
    this.capacity = capacity
    this.texture = buildEmoteAtlas(256)
    // Per agent: which emote it shows and how far through its pop it is (0..1).
    this.state = new WeakMap()
    this._last = null

    const geo = new THREE.PlaneGeometry(1, 1)
    this.frames = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    for (const a of [this.frames, this.centers, this.sizes]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aFrame', this.frames)
    geo.setAttribute('aCenter', this.centers)
    geo.setAttribute('aSize', this.sizes)

    this.material = this._material()
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    this.mesh.layers.set(OVERLAY_LAYER)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    // Under the status badges (10): when the two overlap, the badge wins.
    this.mesh.renderOrder = 9
    scene.add(this.mesh)
    this.scene = scene

    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, white)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this._color = new THREE.Color()
  }

  _material() {
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
    })

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFrameScale = { value: new THREE.Vector2(1 / COLS, 1 / ROWS) }
      withCurve(shader)

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aFrame;
           attribute vec3 aCenter;
           attribute float aSize;
           uniform vec2 uFrameScale;`
        )
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n vMapUv = uv * uFrameScale + aFrame;`)
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = viewMatrix * vec4( bcBend( ( modelMatrix * vec4( aCenter, 1.0 ) ).xyz ), 1.0 );
           float dist = -mvPosition.z;
           // Same mostly-constant screen size as the badges, so an emote stays readable
           // when the camera is pulled out. aSize already carries the pop.
           float scale = aSize * ( 2.0 + dist * 0.22 );
           // Beside the head, not above it: the status badge owns the space overhead. The
           // shift is in view space for the same reason the badge's lift is: it has to scale
           // with the bubble, not with the world, or it would crowd the helmet when zoomed out.
           // Far enough that the bubble's near edge clears a badge's: half a badge (0.063) plus
           // half a bubble (0.0425) is 1.24 bubbles. A bot only emotes while idle, and idle carries
           // no badge, but one called away mid-scene gets its badge back while its bubble shrinks.
           mvPosition.x += scale * 1.25;
           mvPosition.y += scale * 0.5;
           mvPosition.xy += position.xy * scale;
           gl_Position = projectionMatrix * mvPosition;`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n uniform vec2 uFrameScale;`)
        .replace(
          '#include <map_fragment>',
          `vec4 cell = texture2D( map, vMapUv );
           // Green = the round plate, red = the glyph, as on the badges, minus the ring and
           // shadow: at this size they would only be noise.
           vec3 plate = vec3( 0.045, 0.05, 0.07 );
           diffuseColor.rgb = mix( plate, vColor.rgb, cell.r ) * cell.g;
           diffuseColor.a = cell.g;`
        )
        .replace('#include <color_fragment>', '')
    }
    return material
  }

  /**
   * Rebuild the instance buffers. `emoteFor(agent)` returns an `EMOTE` id or a negative number
   * for none; an emote that stops being asked for shrinks away instead of vanishing.
   */
  update(agents, elapsed, emoteFor) {
    const dt = this._last === null ? 0 : Math.min(0.25, Math.max(0, elapsed - this._last))
    this._last = elapsed
    const frames = this.frames.array
    const centers = this.centers.array
    const sizes = this.sizes.array
    let n = 0

    for (const agent of agents) {
      if (n >= this.capacity) break
      let st = this.state.get(agent)
      const want = agent.scale < 0.4 || agent.state === 'gone' ? -1 : (emoteFor(agent) ?? -1)

      if (want >= 0) {
        if (!st) this.state.set(agent, (st = { id: want, k: 0 }))
        // A different emote replaces the old one outright, popping in fresh.
        else if (st.id !== want) { st.id = want; st.k = 0 }
        st.k = Math.min(1, st.k + dt / POP)
      } else if (st) {
        st.k = Math.max(0, st.k - dt / POP)
        if (st.k === 0) { this.state.delete(agent); st = null }
      }
      if (!st) continue

      // A slow bob so a held emote does not look frozen.
      const bob = Math.sin(elapsed * 1.9 + agent.phase) * 0.03
      centers[n * 3] = agent.pos.x
      centers[n * 3 + 1] = agent.pos.y + HEAD_CLEAR + bob
      centers[n * 3 + 2] = agent.pos.z

      const cell = emoteCell(st.id)
      frames[n * 2] = cell.u
      frames[n * 2 + 1] = cell.v
      sizes[n] = 0.085 * popScale(st.k)

      const c = EMOTE_COLOR[st.id] || [1, 1, 1]
      this._color.setRGB(c[0], c[1], c[2])
      this.mesh.setColorAt(n, this._color)
      n++
    }

    this.mesh.count = n
    this.frames.needsUpdate = true
    this.centers.needsUpdate = true
    this.sizes.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = false
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
    this.scene.remove(this.mesh)
  }
}

const ICON_VIEWBOX = 24
// A round plate fills most of the cell, and the glyph sits inside it with a margin so the
// plate's rim reads as a border.
const PLATE_R = 0.44
const ICON_SIZE = 0.56

function buildEmoteAtlas(cellSize) {
  const canvas = document.createElement('canvas')
  canvas.width = cellSize * COLS
  canvas.height = cellSize * ROWS
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ICON_PATHS.forEach((d, index) => {
    const icon = new Path2D(d)
    ctx.save()
    ctx.translate((index % COLS) * cellSize, Math.floor(index / COLS) * cellSize)
    ctx.scale(cellSize, cellSize)

    ctx.fillStyle = 'rgb(0,255,0)'
    ctx.beginPath()
    ctx.arc(0.5, 0.5, PLATE_R, 0, Math.PI * 2)
    ctx.fill()

    // Additive, so the glyph lights up inside the plate instead of punching through it.
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgb(255,0,0)'
    ctx.translate(0.5 - ICON_SIZE / 2, 0.5 - ICON_SIZE / 2)
    ctx.scale(ICON_SIZE / ICON_VIEWBOX, ICON_SIZE / ICON_VIEWBOX)
    ctx.fill(icon, 'nonzero')
    ctx.restore()
  })

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 4
  return texture
}
