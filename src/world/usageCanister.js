import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The usage canister: a fixed glass tube of glowing goo, off to one side of the ship, standing
 * in for however much of a monthly dollar budget is left. The goo's *height* is the budget
 * remaining; its *colour* is something else — burn rate against the calendar, red if spend is
 * outrunning the days already gone, green if it is comfortably behind. A beacon on the cap
 * starts flashing once the budget itself is nearly gone, regardless of pace.
 *
 * Built the same way as `MCPFactory`: a merged, vertex-coloured hull for the frame, separate
 * meshes only for the parts that actually change at runtime — here, the goo itself and the cap
 * beacon.
 */

const FRAME = 0x565b66
const FRAME_DARK = 0x33363e
const METAL = 0x24262c

const RADIUS = 0.62
const HEIGHT = 3.0
/** How far up the frame's base the goo's own floor sits. */
const FOOT = 0.3

const COLOR_LOW = new THREE.Color(0xff3b3b) // empty — a warning, not a mood
const COLOR_MID = new THREE.Color(0xffc23d)
const COLOR_HIGH = new THREE.Color(0x3dffb0) // full — cool, neon, healthy

/** Below this fraction remaining, the cap beacon starts flashing rather than sitting lit. */
const ALARM_LEVEL = 0.15

const GOO_VERTEX = `
varying float vY;
varying vec2 vXZ;
void main() {
  vY = position.y;
  vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const GOO_FRAGMENT = `
uniform float uTime;
uniform float uLevel; // 0..1 of the goo's own height, not the whole canister
uniform float uHeight;
uniform vec3 uColor;
uniform float uPulse;
varying float vY;
varying vec2 vXZ;

void main() {
  float y = vY / uHeight; // 0 at the floor, 1 at the canister's own ceiling
  float angle = atan(vXZ.y, vXZ.x);
  // The surface is never flat — a slow two-frequency wobble around the rim reads as a liquid
  // settling rather than a solid rising and falling like a piston.
  float wobble = sin(angle * 5.0 + uTime * 1.7) * 0.012 + sin(angle * 2.0 - uTime * 0.8) * 0.02;
  float edge = uLevel + wobble;
  if (y > edge) discard;

  vec3 base = uColor;
  // A handful of drifting highlights stand in for bubbles without a second draw call.
  float bub = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float speed = 0.22 + fi * 0.1;
    float riseTop = max(edge, 0.02);
    float bubY = fract(uTime * speed + fi * 0.41) * riseTop;
    float bubAngle = fi * 2.4 + uTime * (0.25 + fi * 0.08);
    float da = abs(mod(angle - bubAngle + 3.14159, 6.28318) - 3.14159);
    float dy = abs(y - bubY);
    bub += smoothstep(0.16, 0.0, da) * smoothstep(0.05, 0.0, dy);
  }

  float depth = clamp((edge - y) * 3.0, 0.0, 1.0); // brighter near the surface than the floor
  float glow = 0.75 + depth * 0.55 + uPulse * 0.7 + bub * 1.6;
  gl_FragColor = vec4(base * glow, 1.0);
}
`

export class UsageCanister {
  constructor(scene, position) {
    this.scene = scene
    this.width = RADIUS * 2 + 1.0
    this.depth = this.width

    this.group = new THREE.Group()
    this.group.position.copy(position)
    this.group.name = 'usage-canister'
    scene.add(this.group)

    /** Smoothed 0..1 fill — what the shader actually draws. Chases `target` so a poll landing
     *  mid-frame reads as the goo settling rather than jumping. */
    this.level = 1
    this.target = 1
    /** Smoothed 0..1 *colour* score — 1 is comfortably under pace (green), 0 is badly over it
     *  (red). Tracked separately from `level`: a nearly-empty budget you are still ahead of
     *  schedule on should read amber or green, not red just because the tank is low. */
    this.pace = 1
    this.paceTarget = 1
    this.pulse = 0
    this._flash = 0
    /** This frame's pace colour, read by `UsageBurstField` so a flight of orbs tints the same
     *  as whatever the tank itself is showing right now. */
    this.currentColor = COLOR_HIGH.clone()

    this._buildHull()
    this._buildGoo()
    this._buildBeacon()
    this._buildSign()
  }

  _buildHull() {
    const parts = []
    const colors = []
    const push = (geo, color) => {
      parts.push(geo)
      colors.push(new THREE.Color(color))
    }

    // A tripod of ribs holding the tube rather than a solid drum, so the goo inside is always
    // visible from the walkway.
    const legR = RADIUS + 0.16
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      const rib = new THREE.BoxGeometry(0.14, HEIGHT, 0.14)
      rib.translate(Math.cos(a) * legR, HEIGHT / 2, Math.sin(a) * legR)
      push(rib, FRAME)
      // Cross-braces, one third and two thirds up, tie the ribs to each other rather than
      // leaving three poles that read as unbuilt scaffolding.
      for (const h of [HEIGHT * 0.35, HEIGHT * 0.75]) {
        const b = ((i + 1) / 3) * Math.PI * 2
        const from = new THREE.Vector3(Math.cos(a) * legR, h, Math.sin(a) * legR)
        const to = new THREE.Vector3(Math.cos(b) * legR, h, Math.sin(b) * legR)
        push(strut(from, to, 0.07), FRAME_DARK)
      }
    }

    const base = new THREE.CylinderGeometry(legR + 0.3, legR + 0.4, FOOT, 16)
    base.translate(0, FOOT / 2, 0)
    push(base, METAL)

    const cap = new THREE.CylinderGeometry(legR + 0.14, legR + 0.14, 0.22, 16)
    cap.translate(0, HEIGHT + 0.11, 0)
    push(cap, FRAME_DARK)

    bakeColors(parts, colors)
    const merged = BufferGeometryUtils.mergeGeometries(parts, false)
    parts.forEach((g) => g.dispose())
    this.hull = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 }))
    this.hull.castShadow = true
    this.hull.receiveShadow = true
    this.group.add(this.hull)

    // The glass itself — a thin, mostly-transparent tube so the frame reads as holding
    // something rather than being solid metal.
    const glassGeo = new THREE.CylinderGeometry(RADIUS + 0.06, RADIUS + 0.06, HEIGHT - FOOT, 24, 1, true)
    glassGeo.translate(0, FOOT + (HEIGHT - FOOT) / 2, 0)
    this.glass = new THREE.Mesh(
      glassGeo,
      new THREE.MeshPhysicalMaterial({
        color: 0xbfe9ff,
        transparent: true,
        opacity: 0.14,
        roughness: 0.05,
        metalness: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    )
    this.group.add(this.glass)
  }

  _buildGoo() {
    const gooHeight = HEIGHT - FOOT - 0.08
    const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, gooHeight, 24, 28, false)
    geo.translate(0, gooHeight / 2, 0)
    this.gooHeight = gooHeight
    this.gooMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLevel: { value: 1 },
        uHeight: { value: gooHeight },
        uColor: { value: COLOR_HIGH.clone() },
        uPulse: { value: 0 },
      },
      vertexShader: GOO_VERTEX,
      fragmentShader: GOO_FRAGMENT,
      side: THREE.DoubleSide,
    })
    this.goo = new THREE.Mesh(geo, this.gooMaterial)
    this.goo.position.y = FOOT + 0.04
    this.goo.frustumCulled = false
    this.group.add(this.goo)
  }

  _buildBeacon() {
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: 0x224433, toneMapped: true })
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), this.beaconMaterial)
    this.beacon.position.set(0, HEIGHT + 0.3, 0)
    this.group.add(this.beacon)
  }

  /** A small canvas-texture readout above the canister — the one place the percentage is
   *  actually legible without opening the settings panel. */
  _buildSign() {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 64
    this._signCtx = canvas.getContext('2d')
    this._signTexture = new THREE.CanvasTexture(canvas)
    this._signTexture.colorSpace = THREE.SRGBColorSpace
    this._signLast = -1

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.55),
      new THREE.MeshBasicMaterial({ map: this._signTexture, transparent: true, toneMapped: false })
    )
    sign.position.set(0, HEIGHT + 0.75, 0)
    this.sign = sign
    this.group.add(sign)
  }

  _drawSign(pct) {
    const shown = Math.round(pct * 100)
    if (shown === this._signLast) return
    this._signLast = shown
    const ctx = this._signCtx
    ctx.clearRect(0, 0, 128, 64)
    ctx.fillStyle = 'rgba(10,14,18,0.55)'
    roundRect(ctx, 2, 2, 124, 60, 10)
    ctx.fill()
    ctx.font = '700 30px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#eafff5'
    ctx.fillText(`${shown}%`, 64, 34)
    this._signTexture.needsUpdate = true
  }

  /** `info` is an `/api/usage` snapshot: `remainingPct` (0..1) sets the fill, `pace` (spend's
   *  share of the budget divided by the month's share elapsed — 1.0 is dead on pace) sets the
   *  colour. */
  setLevel(info) {
    this.target = THREE.MathUtils.clamp(info.remainingPct, 0, 1)
    // 1.0 → green (comfortably under pace), 0.5 → yellow (right on pace), 0 → red (2x pace or
    // worse). Linear rather than anything fancier: the whole point is reading "over or under"
    // at a glance, not the exact multiple.
    this.paceTarget = THREE.MathUtils.clamp(1 - info.pace / 2, 0, 1)
  }

  update(dt, elapsed, night) {
    this.level = THREE.MathUtils.damp(this.level, this.target, 1.4, dt)
    this.pace = THREE.MathUtils.damp(this.pace, this.paceTarget, 1.4, dt)

    const t = this.pace
    const color = t > 0.5 ? COLOR_MID.clone().lerp(COLOR_HIGH, (t - 0.5) * 2) : COLOR_LOW.clone().lerp(COLOR_MID, t * 2)
    this.currentColor.copy(color)

    this.gooMaterial.uniforms.uTime.value = elapsed
    this.gooMaterial.uniforms.uLevel.value = Math.max(0.02, this.level)
    this.gooMaterial.uniforms.uColor.value.copy(color)

    const alarm = this.level < ALARM_LEVEL
    this.pulse = alarm ? 0.5 + 0.5 * Math.sin(elapsed * 9) : 0.15 + night * 0.25
    this.gooMaterial.uniforms.uPulse.value = this.pulse

    this._flash = alarm ? 0.4 + 0.6 * Math.max(0, Math.sin(elapsed * 9)) : 0.35 + night * 0.5
    const bc = color.clone().multiplyScalar(this._flash * 2.2)
    this.beaconMaterial.color.setRGB(bc.r, bc.g, bc.b)

    this._drawSign(this.target)
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
        else o.material.dispose()
      }
    })
    this._signTexture.dispose()
    this.scene.remove(this.group)
  }
}

/** A thin box standing in for a strut between two points — cheap and good enough at this scale. */
function strut(from, to, thickness) {
  const mid = from.clone().add(to).multiplyScalar(0.5)
  const length = from.distanceTo(to)
  const geo = new THREE.BoxGeometry(length, thickness, thickness)
  const m = new THREE.Matrix4()
  const dir = to.clone().sub(from).normalize()
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
  m.compose(mid, quat, new THREE.Vector3(1, 1, 1))
  geo.applyMatrix4(m)
  return geo
}

/** Bake one flat vertex color per part — the same trick `Ship` and `MCPFactory` use. */
function bakeColors(parts, colors) {
  parts.forEach((geo, i) => {
    const count = geo.attributes.position.count
    const arr = new Float32Array(count * 3)
    const c = colors[i]
    for (let k = 0; k < count; k++) {
      arr[k * 3] = c.r
      arr[k * 3 + 1] = c.g
      arr[k * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    geo.deleteAttribute('uv')
    if (!geo.attributes.normal) geo.computeVertexNormals()
  })
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
