import * as THREE from 'three'
import {
  mdiHelpCircle,
  mdiAlert,
  mdiHammer,
  mdiCheckBold,
  mdiPause,
  mdiSleep,
  mdiCreation,
  mdiLogout,
} from '@mdi/js'

/**
 * The status badges that float above each astronaut's head.
 *
 * These are the one thing that stays on screen when every panel is dismissed, so they are
 * drawn in the world rather than in the DOM: a single instanced quad per agent, billboarded
 * in the vertex shader and sampled from a small icon atlas. One draw call for the whole
 * colony, and they keep a constant on-screen size as you zoom so a badge is still readable
 * when you have pulled the camera right out.
 */

const COLS = 4
const ROWS = 2

/** Where the badge's bottom edge sits: a shade above the crown of the helmet. */
const HEAD_CLEAR = 1.42

export const BADGE = {
  none: -1,
  waiting: 0, // waiting on you — the one that matters most
  blocked: 1, // errored
  working: 2,
  done: 3,
  paused: 4,
  sleeping: 5,
  spawning: 6,
  leaving: 7,
}

/** Badge tint. Pushed past 1.0 so the bloom pass gives them a soft halo. */
const BADGE_COLOR = {
  0: [0.42, 1.35, 2.9],
  1: [2.9, 0.6, 0.5],
  2: [0.4, 1.9, 0.95],
  3: [1.5, 2.4, 0.8],
  4: [2.5, 1.9, 0.65],
  5: [0.9, 1.0, 1.7],
  6: [2.4, 1.4, 0.75],
  7: [1.2, 1.3, 1.35],
}

/**
 * How readily a badge gives up its space, 0 = never fades. Ranked by how much the thing it
 * reports actually wants you: a blocked session always shows, forty sleeping ones do not.
 */
const FADE_BY_BADGE = {
  [BADGE.waiting]: 0,
  [BADGE.blocked]: 0,
  [BADGE.done]: 0.15,
  [BADGE.working]: 0.4,
  [BADGE.spawning]: 0.5,
  [BADGE.leaving]: 0.5,
  [BADGE.paused]: 0.6,
  [BADGE.sleeping]: 1,
}

export class Indicators {
  constructor(scene, settings, capacity) {
    this.settings = settings
    this.capacity = capacity
    // 512 texels per badge, not per atlas — sized against the closest the camera ever gets,
    // which buildBadgeAtlas works through.
    this.texture = buildBadgeAtlas(512)

    const geo = new THREE.PlaneGeometry(1, 1)
    this.frames = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    // 1 = a badge that may fade out at distance, 0 = one that must always be readable.
    this.fades = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    for (const a of [this.frames, this.centers, this.sizes, this.fades]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aFrame', this.frames)
    geo.setAttribute('aCenter', this.centers)
    geo.setAttribute('aSize', this.sizes)
    geo.setAttribute('aFade', this.fades)

    this.material = this._material()
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
    scene.add(this.mesh)
    this.scene = scene

    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, white)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

    this._color = new THREE.Color()
  }

  /**
   * Billboarding is done on the GPU: the quad's corner offset is applied in *view* space
   * after the centre has been transformed, which makes every badge face the camera without
   * a per-badge matrix update on the CPU. `aSize` carries a perspective-cancelling scale so
   * the badge holds its pixel size at any zoom.
   */
  _material() {
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false, // a badge is a HUD element: never hidden behind terrain
      toneMapped: true,
    })

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFrameScale = { value: new THREE.Vector2(1 / COLS, 1 / ROWS) }
      this.uniforms = shader.uniforms

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aFrame;
           attribute vec3 aCenter;
           attribute float aSize;
           attribute float aFade;
           varying float vFade;
           uniform vec2 uFrameScale;`
        )
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n vMapUv = uv * uFrameScale + aFrame;`)
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = modelViewMatrix * vec4( aCenter, 1.0 );
           float dist = -mvPosition.z;
           // Mostly-constant screen size: the linear term cancels perspective so a badge
           // stays readable when the camera is pulled right out, while the constant term
           // lets it grow a little as you lean in, which stops it feeling pasted on.
           float scale = aSize * ( 2.0 + dist * 0.22 );
           // Lift by half the badge's own height, so what is pinned above the helmet is the
           // badge's *bottom edge* rather than its centre. The badge holds a near-constant
           // size on screen while a world-space offset does not, so a centre that clears the
           // head when you are leaning in sits right on top of it when you pull out — the
           // gap shrinks with distance while the thing it has to clear does not.
           mvPosition.y += scale * 0.5;
           mvPosition.xy += position.xy * scale;
           // Low-priority badges (asleep, idle) thin out quickly so a wide shot shows only
           // what actually wants you, while a close look still reports everything. Urgent
           // badges carry aFade 0 and never fade at all.
           vFade = 1.0 - aFade * smoothstep( 19.0, 44.0, dist );
           gl_Position = projectionMatrix * mvPosition;`
        )
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\n varying float vFade;\n uniform vec2 uFrameScale;`
      )
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `vec4 badge = texture2D( map, vMapUv );
         // One texture, three masks: the plate's silhouette in green, a ring straddling its
         // edge in blue, the symbol in red. A badge is the one thing in the colony you are
         // meant to spot across a busy plot and click, so it is built like a pin — a solid
         // card, a ring in its own status colour, and a shadow holding it off the ground.
         float body = max( badge.g, badge.b );

         // The shadow is the same silhouette read from a blurred mip and offset down-right,
         // which costs one extra sample instead of a second texture. The plate is inset far
         // enough inside its cell that neither the offset nor the blur reaches a neighbour.
         float shadow = texture2D( map, vMapUv + vec2( -0.006, 0.010 ) * uFrameScale, 2.2 ).g;

         vec3 plate = vec3( 0.045, 0.05, 0.07 );
         vec3 col = mix( plate, vColor.rgb * 0.85, badge.b );
         col = mix( col, vColor.rgb, badge.r );

         // Where the badge is solid it is the badge; where it is not, what is left of the
         // offset silhouette is the shadow, and multiplying by alpha takes the colour to
         // black there without a second branch.
         diffuseColor.rgb = col * body;
         diffuseColor.a = max( body, shadow * ( 1.0 - body ) * 0.55 ) * vFade;`
      )
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
    }
    return material
  }

  /** Rebuild the instance buffers from the agents that currently want a badge. */
  update(agents, elapsed, statusFor) {
    const frames = this.frames.array
    const centers = this.centers.array
    const sizes = this.sizes.array
    const fades = this.fades.array
    let n = 0

    for (const agent of agents) {
      // Cleared for everyone first: an agent that loses its badge this frame must lose its
      // hit box with it, or the picker keeps offering a bubble that is no longer drawn.
      agent.badgeSize = 0
      if (n >= this.capacity) break
      if (agent.scale < 0.4 || agent.state === 'gone') continue
      const badge = statusFor(agent)
      if (badge < 0) continue

      // A gentle bob, and an urgent one for the states that want your attention.
      const urgent = badge === BADGE.waiting || badge === BADGE.blocked
      const bobRate = urgent ? 3.4 : 1.6
      const bobAmp = urgent ? 0.075 : 0.035
      const bob = Math.sin(elapsed * bobRate + agent.phase) * bobAmp

      centers[n * 3] = agent.pos.x
      // Just clear of the helmet: the shader lifts the quad the rest of the way by its own
      // half-height, which is the part that has to change with the camera. The clearance
      // scales with the species height, or a tall astronaut wears its badge as a hat.
      centers[n * 3 + 1] = agent.pos.y + HEAD_CLEAR * agent.height + bob
      centers[n * 3 + 2] = agent.pos.z

      frames[n * 2] = (badge % COLS) / COLS
      frames[n * 2 + 1] = 1 - (Math.floor(badge / COLS) + 1) / ROWS

      // Urgent badges breathe a little so they pull the eye across a busy colony.
      sizes[n] = urgent ? 0.166 + Math.sin(elapsed * 4.2 + agent.phase) * 0.013 : 0.126
      fades[n] = FADE_BY_BADGE[badge] ?? 1

      // Handed to the picker so a click can hit the bubble itself rather than the head under
      // it. It cannot be derived over there: the lift and the size are decided in view space
      // by the vertex shader above, and only this loop knows which frame each agent got.
      agent.badgeSize = sizes[n]
      agent.badgeY = centers[n * 3 + 1]

      const c = BADGE_COLOR[badge] || [1, 1, 1]
      this._color.setRGB(c[0], c[1], c[2])
      this.mesh.setColorAt(n, this._color)
      n++
    }

    this.mesh.count = n
    this.frames.needsUpdate = true
    this.centers.needsUpdate = true
    this.sizes.needsUpdate = true
    this.fades.needsUpdate = true
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

/**
 * The badge symbols, in atlas order. Solid rather than outlined: a badge is a lit chip seen
 * at a glance across a colony, and an outline at that size is mostly the hole in the middle
 * — the glyph has to carry as a silhouette. Material's set is drawn filled to begin with,
 * one closed path per icon, so there is nothing to stroke and nothing to parse.
 */
const ICON_PATHS = [mdiHelpCircle, mdiAlert, mdiHammer, mdiCheckBold, mdiPause, mdiSleep, mdiCreation, mdiLogout]

/**
 * The badge atlas. Red channel = the glyph, green channel = the plate's alpha — packing two
 * masks into one RGBA texture so the shader can composite a dark plate with a glowing symbol
 * without a second sampler.
 *
 * Sized for the *closest* a badge is ever seen rather than the average: a badge holds a
 * near-constant size on screen, so leaning all the way in is where it magnifies, and a cell
 * that is comfortable at arm's length turns to mush there. Everything in here is drawn from
 * paths in unit space, so the only cost of more texels is the texture itself.
 *
 * Where 512 comes from: the camera stops at 4 units out, where a 34° frame is 2 * 4 * tan(17°)
 * ≈ 2.45 units tall, and the vertex shader hands an urgent badge a quad of 0.166 * (2 + 4 *
 * 0.22) ≈ 0.48 units — a fifth of the frame. A retina panel is around 2000 device pixels tall,
 * so the badge lands near 400 pixels across and 512 texels still leaves a texel per pixel with
 * headroom for a larger display. The old 128 gave it three pixels per texel, which is why the
 * corners came out stepped. The cells are square because the quad is: laying 4x2 cells on a
 * square canvas spent twice as many texels down as across, and only across was ever the limit.
 * 2048x1024 RGBA is 8 MB, which is the entire cost — the mip chain that distance reads from is
 * unchanged, and the shadow's blur is set by a bias on the sampled level, so it stays put too.
 */
function buildBadgeAtlas(cellSize = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = cellSize * COLS
  canvas.height = cellSize * ROWS
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const icons = ICON_PATHS.map((d) => new Path2D(d))

  icons.forEach((icon, index) => {
    const x = (index % COLS) * cellSize
    const y = Math.floor(index / COLS) * cellSize
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(cellSize, cellSize)

    // Green channel: the rounded plate + its pointer, i.e. the badge's silhouette.
    ctx.fillStyle = 'rgb(0,255,0)'
    platePath(ctx)
    ctx.fill()

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // Blue channel: a ring straddling that edge. Additive, so the half of it lying over the
    // plate keeps the silhouette solid rather than punching a hole in it, and the half
    // outside carries its own alpha — which is what makes the ring read as an outline
    // rather than as a border drawn inside the card.
    ctx.strokeStyle = 'rgb(0,0,255)'
    ctx.lineWidth = 0.055
    ctx.lineJoin = 'round'
    platePath(ctx)
    ctx.stroke()

    // Red channel: the glyph. Additive so it lights up inside the plate the shader draws.
    ctx.fillStyle = 'rgb(255,0,0)'
    drawIcon(ctx, icon)
    ctx.restore()
    ctx.restore()
  })

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  // Badges are seen at a glance from any angle; a sharp one at 60° costs one texture flag.
  texture.anisotropy = 8
  return texture
}

/**
 * A rounded speech plate with a little tail pointing down at the astronaut. Path only: it is
 * filled for the silhouette and stroked for the ring, and both have to be the same shape.
 *
 * Every turn in it is an arc, including the two where the tail leaves the bottom edge and the
 * one at the point, so the outline is tangent-continuous the whole way round. That is what
 * keeps it looking drawn rather than assembled at the magnification the closest zoom gives it:
 * a corner between two straight runs would put a mitre in the ring and a hard glint on the
 * silhouette, and a needle-sharp tip would thin out to nothing before it got there.
 */
function platePath(ctx) {
  const left = 0.11
  const right = 0.89
  const top = 0.08
  const bottom = 0.74
  const r = 0.19
  // The tail is a wide, shallow wedge rather than a spike: at a fifth of the plate's width it
  // reads as part of the same shape, and it still has room for the fillets at its base and the
  // rounding at its point without either eating the other.
  const tailHalf = 0.105
  const tailY = 0.915
  const tailPoint = 0.038
  const tailFlare = 0.07

  ctx.beginPath()
  ctx.moveTo(left + r, top)
  ctx.arcTo(right, top, right, bottom, r)
  ctx.arcTo(right, bottom, left, bottom, r)
  ctx.arcTo(0.5 + tailHalf, bottom, 0.5, tailY, tailFlare)
  ctx.arcTo(0.5, tailY, 0.5 - tailHalf, bottom, tailPoint)
  ctx.arcTo(0.5 - tailHalf, bottom, left, bottom, tailFlare)
  ctx.arcTo(left, bottom, left, top, r)
  ctx.arcTo(left, top, right, top, r)
  ctx.closePath()
}

/**
 * The eight symbols, in atlas order: waiting, blocked, working, done, paused, sleeping,
 * spawning, leaving.
 *
 * Material Design Icons, imported as path data rather than drawn here. Eight symbols that have
 * to look like one family is a type problem — one weight, one optical size, one set of
 * terminals — and a set somebody has already balanced beats one assembled a curve at a time.
 */

const ICON_VIEWBOX = 24
// MDI authors on a 24-unit grid and means the result to be read at 24 pixels. A badge is usually
// smaller than that, with a lit ring around it competing for the eye.

/**
 * How much of the cell the icon box covers, and where it sits. Centred on the *plate's body*
 * rather than on the cell, which runs lower because of the tail, and then lifted a hair further
 * because the tail pulls the eye down and a symbol centred by measurement reads low.
 */
const ICON_SIZE = 0.5
const ICON_X = 0.5
const ICON_Y = 0.405


/**
 * Filled, never stroked: MDI ships one closed path per icon, so the silhouette *is* the glyph
 * and there is nothing to outline. The path is scaled out of its own 24-unit space into the
 * cell, which is square, so that scale is uniform and nothing skews.
 */
function drawIcon(ctx, icon) {
  ctx.save()
  ctx.translate(ICON_X - ICON_SIZE / 2, ICON_Y - ICON_SIZE / 2)
  ctx.scale(ICON_SIZE / ICON_VIEWBOX, ICON_SIZE / ICON_VIEWBOX)
  // Nonzero winding, which is what the icons are authored for: the counter in a `?` or the
  // gap in an exit arrow is a subpath wound the other way, and it has to stay a hole.
  ctx.fill(icon, 'nonzero')
  ctx.restore()
}
