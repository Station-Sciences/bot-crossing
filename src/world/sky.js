import * as THREE from 'three'
import { COLONY_RADIUS, mulberry } from './planet.js'

/**
 * Sky, stars, the sun, the thing hanging in the sky, and all the lighting.
 *
 * The whole sky — gradient, horizon warmth, sun glow and the sun's disc — is one inverted
 * sphere with one shader, so changing the time of day costs three uniform writes rather
 * than rebuilding anything. Time runs 0..1 with 0.5 at noon; everything else (sun angle,
 * light colour, star opacity, fog) is derived from it, which is what makes a slider able
 * to drive the entire look of the scene.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // The dome is pinned to the camera, so it can never be walked out of.
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
  }
`

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uGlow;       // how much atmosphere there is to scatter light
  uniform float uDisc;       // sun disc brightness, faded out below the horizon
  uniform float uHaze;

  void main() {
    vec3 d = normalize( vDir );
    float h = clamp( d.y * 0.5 + 0.5, 0.0, 1.0 );

    // A hard-ish gradient near the horizon and a slow one overhead reads far more like sky
    // than a linear ramp does.
    vec3 col = mix( uHorizon, uTop, pow( h, 0.42 ) );

    float sun = max( dot( d, uSunDir ), 0.0 );
    // Wide scatter, tight halo, then the disc itself — three terms, one draw call.
    // These stay modest on purpose: the sky is the largest surface on screen, so anything
    // above 1.0 here feeds the bloom pass across the whole frame and washes the colony out.
    col += uSunColor * pow( sun, 6.0 ) * uGlow * 0.14;
    col += uSunColor * pow( sun, 60.0 ) * uGlow * 0.3;
    col += uSunColor * smoothstep( 0.9990, 0.9996, sun ) * uDisc;

    // Haze thickens toward the horizon, so an atmosphere planet gets a soft rim.
    col = mix( col, uHorizon, uHaze * pow( 1.0 - h, 6.0 ) );

    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Named times of day. The slider is continuous; these are just the good stops. */
/**
 * This machine's wall clock as a day fraction — 0 is midnight, 0.5 is noon, which is exactly
 * what `timeOfDay` means. Local time on purpose: the point is that the colony's light matches
 * the light out of your own window, so UTC would be the wrong answer nearly everywhere.
 */
export function systemTimeOfDay(now = new Date()) {
  return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400
}

export const TIMES = [
  { id: 'dawn', label: 'Dawn', value: 0.255 },
  { id: 'morning', label: 'Morning', value: 0.34 },
  { id: 'noon', label: 'Noon', value: 0.5 },
  { id: 'golden', label: 'Golden', value: 0.695 },
  { id: 'dusk', label: 'Dusk', value: 0.755 },
  { id: 'night', label: 'Night', value: 0.94 },
]

const SUN_AXIS = 0.72 // which way the sun tracks across the sky
/**
 * How high the sun gets at noon, in radians — 54°, not 90°.
 *
 * The arc is tilted off the zenith the way a real solar path is, rather than passing
 * straight overhead. That is load-bearing for anything with a flat vertical face: a sun at
 * the zenith puts `N·L` at zero on every wall in the colony, and they go black with only
 * ambient to catch. It is also what the old "shadows always have some length" comment was
 * after — scaling the elevation *before* normalising cannot cap an angle, because at noon
 * the horizontal term is zero and the direction normalises to straight up regardless.
 */
const SUN_APEX = 0.95
/**
 * How far a `sunTwin` companion trails the sun, in radians of azimuth — about 13°. Close
 * enough to read as a pair, far enough that the two discs never merge into one blob.
 * Azimuthal on purpose: rotating about the vertical keeps the twin's elevation equal to
 * the sun's, so the pair rises and sets as one.
 */
const TWIN_SPREAD = 0.23
/** Half-width of the shadow camera, in metres, centred on whatever you are looking at. */
const SHADOW_EXTENT = 30
/**
 * The focus is snapped to this grid before the shadow camera moves. Panning a shadow map
 * by sub-texel amounts makes every shadow edge crawl; snapping trades a little slack at
 * the frustum edge for edges that hold still.
 */
const SHADOW_SNAP = 2

const UP = new THREE.Vector3(0, 1, 0)

export class Sky {
  constructor(scene, settings, renderer) {
    this.scene = scene
    this.settings = settings
    this.renderer = renderer
    this.group = new THREE.Group()
    this.group.name = 'sky'
    scene.add(this.group)

    this.sunDir = new THREE.Vector3(0, 1, 0)
    this.dayFactor = 1
    this._c1 = new THREE.Color()
    this._c2 = new THREE.Color()

    this._buildDome()
    this._buildLights()
    this._buildStars()
    this._buildCompanion()

    this._buildEnvironment()
    scene.fog = new THREE.Fog(0x000000, 90, 260)
  }

  /**
   * Image-based lighting, taken from this planet's own sky.
   *
   * Rather than shipping an HDRI, the sky shader *is* the HDRI: a second copy of the dome —
   * sharing the same uniforms, so it is always the sky you are actually standing under — is
   * rendered into a prefiltered radiance map. That is what gives metal something to reflect
   * and dielectrics a directional ambient, and it is why the colony changes character
   * through the day rather than just changing brightness.
   *
   * It is regenerated only when the sky has actually moved, and never more than a few times
   * a second, because prefiltering costs a couple of milliseconds.
   */
  _buildEnvironment() {
    if (!this.renderer) return
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envScene = new THREE.Scene()
    // Same material, so every uniform write to the visible sky lands here too.
    this.envDome = new THREE.Mesh(this.dome.geometry, this.dome.material)
    this.envDome.scale.setScalar(10)
    this.envDome.frustumCulled = false
    this.envScene.add(this.envDome)
    this._envDirty = true
    this._envAt = 0
    this._envTarget = null
  }

  _refreshEnvironment(force = false) {
    if (!this.pmrem) return
    if (!this.settings.get('ibl')) {
      if (this.scene.environment) {
        this.scene.environment = null
        this._envTarget?.dispose()
        this._envTarget = null
      }
      return
    }
    const now = performance.now()
    if (!force && (!this._envDirty || now - this._envAt < 220)) return
    this._envDirty = false
    this._envAt = now

    const next = this.pmrem.fromScene(this.envScene, 0, 0.5, 60)
    this._envTarget?.dispose()
    this._envTarget = next
    this.scene.environment = next.texture
    this.scene.environmentIntensity = this.settings.get('iblIntensity')
  }

  _buildDome() {
    const geo = new THREE.SphereGeometry(1, 32, 20)
    this.domeUniforms = {
      uTop: { value: new THREE.Color(0x0a1230) },
      uHorizon: { value: new THREE.Color(0x101018) },
      uSunColor: { value: new THREE.Color(0xfff0d0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlow: { value: 1 },
      uDisc: { value: 1 },
      uHaze: { value: 0.3 },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    this.dome = new THREE.Mesh(geo, mat)
    this.dome.renderOrder = -1000
    this.dome.frustumCulled = false
    this.dome.scale.setScalar(400)
    this.group.add(this.dome)
  }

  _buildLights() {
    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    // The shadow camera tracks what you are looking at rather than covering the whole
    // colony. Sizing it to the view instead of the world is worth roughly a doubling of
    // effective shadow resolution — the difference between an astronaut casting a readable
    // little shadow and casting four grey pixels.
    const s = SHADOW_EXTENT
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 320
    // Sized against the shadow texel, which is 2 * SHADOW_EXTENT / mapSize across — roughly
    // 6cm at the balanced preset. A normal bias under one texel leaves acne on the big flat
    // decks; depth bias is left at zero because normal bias alone does the job without the
    // peter-panning that a negative depth bias causes on these small characters.
    this.sun.shadow.bias = 0
    this.sun.shadow.normalBias = 0.09
    this.sun.shadow.mapSize.setScalar(this.settings.shadowSize || 1024)
    this.focus = new THREE.Vector3()
    this.sun.target.position.set(0, 0, 0)
    this.group.add(this.sun, this.sun.target)

    this.hemi = new THREE.HemisphereLight(0x8899cc, 0x4a4038, 0.6)
    this.group.add(this.hemi)

    // A cool rim from the opposite side keeps night silhouettes from going fully black.
    this.fill = new THREE.DirectionalLight(0x8fa8d8, 0.2)
    this.fill.position.set(-40, 30, -30)
    this.group.add(this.fill)
  }

  _buildStars() {
    const count = 1400
    const rand = mulberry(90210)
    const positions = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const colors = new Float32Array(count * 3)
    const c = new THREE.Color()

    for (let i = 0; i < count; i++) {
      // Uniform on the sphere, biased upward — stars below the horizon are wasted vertices.
      const u = rand() * 2 - 1
      const theta = rand() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const y = Math.abs(u) * 0.92 + 0.05
      positions[i * 3] = Math.cos(theta) * r * 330
      positions[i * 3 + 1] = y * 330
      positions[i * 3 + 2] = Math.sin(theta) * r * 330
      sizes[i] = 0.6 + rand() * rand() * 3.4
      // A few blue and orange ones stop the field looking like static.
      c.setHSL(rand() < 0.82 ? 0.58 : rand() < 0.5 ? 0.08 : 0.62, 0.35 * rand(), 0.75 + rand() * 0.25)
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    this.starUniforms = { uOpacity: { value: 1 }, uTwinkle: { value: 0 } }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: /* glsl */ `
        attribute float aSize;
        varying vec3 vColor;
        varying float vTw;
        uniform float uTwinkle;
        void main() {
          vColor = color;
          // Each star twinkles on its own phase, seeded from its position.
          float seed = dot( position, vec3( 0.013, 0.027, 0.019 ) );
          vTw = 0.75 + 0.25 * sin( uTwinkle * 1.7 + seed * 40.0 );
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_PointSize = aSize * vTw;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vTw;
        uniform float uOpacity;
        void main() {
          // Round the point off, with a soft core, so stars are not little squares.
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep( 0.5, 0.06, length( d ) );
          gl_FragColor = vec4( vColor * vTw, a * uOpacity );
        }
      `,
    })
    mat.vertexColors = true

    this.stars = new THREE.Points(geo, mat)
    this.stars.renderOrder = -999
    this.stars.frustumCulled = false
    this.group.add(this.stars)
  }

  /** The big body hanging in the sky — Earth from the Moon, a moon from Terra, and so on. */
  _buildCompanion() {
    this.companion = new THREE.Group()
    const geo = new THREE.SphereGeometry(1, 24, 18)
    this.companionBody = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 })
    )
    // A soft halo billboard behind it, so it glows rather than sitting flat on the sky.
    const haloGeo = new THREE.PlaneGeometry(4, 4)
    this.companionHalo = new THREE.Mesh(
      haloGeo,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x6ea8ff) }, uStrength: { value: 1 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
        fragmentShader: `
          varying vec2 vUv; uniform vec3 uColor; uniform float uStrength;
          void main(){
            float d = length( vUv - 0.5 ) * 2.0;
            float a = pow( max( 0.0, 1.0 - d ), 3.0 );
            gl_FragColor = vec4( uColor, a * uStrength );
          }`,
      })
    )
    this.companionHalo.renderOrder = -998
    this.companionBody.renderOrder = -997
    this.companion.add(this.companionHalo, this.companionBody)
    this.companion.frustumCulled = false
    this.group.add(this.companion)
  }

  // ── planet + time ───────────────────────────────────────────────────────────────────

  setPlanet(planet) {
    this.planet = planet
    this.dayTop = new THREE.Color(planet.sky.top)
    this.dayBottom = new THREE.Color(planet.sky.bottom)
    // Night is the day palette crushed toward the planet's own horizon colour, so each
    // world keeps its identity after dark instead of all three going the same black.
    this.nightTop = new THREE.Color(planet.sky.top).multiplyScalar(0.16).lerp(new THREE.Color(0x03040c), 0.7)
    this.nightBottom = new THREE.Color(planet.horizon).multiplyScalar(0.5)
    this.duskColor = new THREE.Color(planet.atmosphere > 0.4 ? 0xd4692f : 0x4a3550)

    const comp = planet.companion
    this.companionBody.material.color.set(comp.color)
    this.companionBody.material.emissive.set(comp.color)
    this.companionBody.material.emissiveIntensity = 0.35
    this.companionHalo.material.uniforms.uColor.value.set(comp.glow)
    this.companion.scale.setScalar(comp.size)
    // Parked high and off to one side, well away from where the sun tracks. A `sunTwin`
    // ignores the parking spot — `setTime` moves it onto the sun's own arc every frame.
    this._companionOffset().set(-0.55, 0.5, -0.66).normalize().multiplyScalar(300)
    this.companion.position.copy(this._compOff)
    this.companionHalo.scale.setScalar(2.2)

    this._envDirty = true
    this.domeUniforms.uHaze.value = 0.25 + planet.atmosphere * 0.5
    this.scene.fog.color.set(planet.fog.color)
    this.scene.fog.near = planet.fog.near
    this.scene.fog.far = planet.fog.far
    this.setTime(this.time ?? 0.32)
  }

  /** Point the shadow frustum at the middle of the view. */
  setFocus(point) {
    const x = Math.round(point.x / SHADOW_SNAP) * SHADOW_SNAP
    const z = Math.round(point.z / SHADOW_SNAP) * SHADOW_SNAP
    if (x === this.focus.x && z === this.focus.z) return
    this.focus.set(x, 0, z)
    this._placeSun()
  }

  /** Sun position and target both hang off the focus point, so the frustum travels with it. */
  _placeSun() {
    this.sun.position.copy(this.sunDir).multiplyScalar(150).add(this.focus)
    this.sun.target.position.copy(this.focus)
    this.sun.target.updateMatrixWorld()
  }

  setTime(t) {
    this.time = ((t % 1) + 1) % 1
    const planet = this.planet
    if (!planet) return

    // Sun on a tilted arc: 0.25 is sunrise, 0.5 noon, 0.75 sunset. The arc runs along the
    // horizon in `travel` and leans out of it toward `apex`, so noon puts the sun at
    // SUN_APEX above the horizon and off to one side rather than overhead. Both basis
    // vectors are unit and perpendicular, so the result needs no normalising.
    const a = (this.time - 0.25) * Math.PI * 2
    const across = Math.sin(SUN_AXIS)
    const along = Math.cos(SUN_AXIS)
    const lean = Math.cos(SUN_APEX)
    this.sunDir.set(
      Math.cos(a) * along + Math.sin(a) * lean * -across,
      Math.sin(a) * Math.sin(SUN_APEX),
      Math.cos(a) * across + Math.sin(a) * lean * along
    )

    // Day factor drives everything else. The smoothstep across the horizon is what gives
    // dawn and dusk their length — a hard cut would make the lights snap on.
    const day = THREE.MathUtils.smoothstep(this.sunDir.y, -0.14, 0.22)
    this.dayFactor = day
    const golden = 1 - Math.abs(THREE.MathUtils.clamp(this.sunDir.y, -0.2, 0.55) / 0.55) // 1 at the horizon
    this.nightFactor = 1 - day

    // Sun light: warm and weak at the horizon, full and neutral overhead.
    const sunColor = this._c1.set(planet.sun.color).lerp(this.duskColor, golden * 0.7 * planet.atmosphere)
    this.sun.color.copy(sunColor)
    this.sun.intensity = THREE.MathUtils.lerp(planet.sun.night, planet.sun.intensity, day)
    this._placeSun()

    this.hemi.color.set(planet.ambient.sky)
    this.hemi.groundColor.set(planet.ambient.ground)
    // The hemisphere light drops right back when IBL is carrying the ambient — running both
    // at full strength double-counts the sky and flattens everything out.
    const hemiScale = this.settings.get('ibl') ? 0.55 : 1
    this.hemi.intensity = THREE.MathUtils.lerp(planet.ambient.intensity * 0.22, planet.ambient.intensity, day) * hemiScale
    // Enough of a bounce that surfaces turned away from the sun read as dark rather than as
    // holes in the image. On an airless world this stands in for regolith bounce.
    this.fill.intensity = THREE.MathUtils.lerp(0.34, 0.26, day)

    // Sky gradient.
    const top = this._c1.copy(this.nightTop).lerp(this.dayTop, day)
    const bottom = this._c2.copy(this.nightBottom).lerp(this.dayBottom, day)
    if (planet.atmosphere > 0) bottom.lerp(this.duskColor, golden * 0.55 * planet.atmosphere * day)
    this.domeUniforms.uTop.value.copy(top)
    this.domeUniforms.uHorizon.value.copy(bottom)
    this.domeUniforms.uSunColor.value.copy(sunColor)
    this.domeUniforms.uSunDir.value.copy(this.sunDir)
    this.domeUniforms.uGlow.value = (0.3 + planet.atmosphere * 1.1) * Math.max(0.08, day)
    // The disc fades out as it sets rather than snapping off at the horizon.
    this.domeUniforms.uDisc.value = 2.4 * THREE.MathUtils.smoothstep(this.sunDir.y, -0.06, 0.04)

    // Stars fade with the sky, and never appear at all on a thick-atmosphere daytime.
    this.stars.material.uniforms.uOpacity.value = Math.pow(1 - day, 1.6) * (1 - planet.atmosphere * 0.35)
    this.stars.visible = this.settings.get('stars') && this.stars.material.uniforms.uOpacity.value > 0.01

    if (planet.companion.sunTwin) {
      // The twin lives on the sun's arc, a fixed azimuth behind it, so the two cross the
      // sky as a pair. It shines *with* the day rather than against it, and fades across
      // the horizon on the same ramp as the sun's disc — a second sun visible after its
      // own sunset would give the game away.
      this._companionOffset().copy(this.sunDir).applyAxisAngle(UP, TWIN_SPREAD).multiplyScalar(300)
      const risen = THREE.MathUtils.smoothstep(this.sunDir.y, -0.06, 0.04)
      this.companion.visible = risen > 0.01
      this.companionHalo.material.uniforms.uStrength.value = (0.4 + day * 0.8) * risen
      this.companionBody.material.emissiveIntensity = (0.5 + day * 1.4) * risen
    } else {
      this.companion.visible = true
      this.companionHalo.material.uniforms.uStrength.value = 0.35 + (1 - day) * 0.65
      this.companionBody.material.emissiveIntensity = 0.25 + (1 - day) * 0.55
    }

    // Fog follows the horizon, or the whole world looks like it is behind glass at night.
    this.scene.fog.color.copy(bottom).lerp(this._c1.set(planet.fog.color), 0.55)
    this._envDirty = true
  }

  onSettingsChanged(changed) {
    if (changed.has('shadows')) {
      const size = this.settings.shadowSize
      this.sun.castShadow = size > 0
      if (size > 0) {
        this.sun.shadow.mapSize.setScalar(size)
        this.sun.shadow.map?.dispose()
        this.sun.shadow.map = null
      }
    }
    if (changed.has('stars')) this.setTime(this.time)
    if (changed.has('ibl') || changed.has('iblIntensity')) {
      this.scene.environmentIntensity = this.settings.get('iblIntensity')
      this._refreshEnvironment(true)
    }
  }

  update(dt, elapsed, camera) {
    // Dome and stars ride with the camera so they read as infinitely far away.
    this.dome.position.copy(camera.position)
    this.stars.position.copy(camera.position)
    this.companion.position.copy(camera.position).add(this._companionOffset())
    this.companion.lookAt(camera.position)
    this.starUniforms.uTwinkle.value = elapsed
    this._refreshEnvironment()

    // Following the clock beats cycling: both drive the same value, and a cycle running on
    // top of it would just fight. Re-read every frame rather than on a timer — it is two
    // divisions, and it means crossing midnight or the machine waking from sleep needs no
    // special case.
    if (this.settings.get('clockTime')) {
      const t = systemTimeOfDay()
      if (Math.abs(t - this.time) < 1e-5) return false
      this.setTime(t)
      return true // the caller re-syncs anything that keys off time
    }
    if (this.settings.get('autoTime')) {
      this.setTime(this.time + dt / Math.max(20, this.settings.get('dayLength')))
      return true
    }
    return false
  }

  _companionOffset() {
    if (!this._compOff) {
      this._compOff = new THREE.Vector3(-0.55, 0.5, -0.66).normalize().multiplyScalar(300)
    }
    return this._compOff
  }

  dispose() {
    this.pmrem?.dispose()
    this._envTarget?.dispose()
    this.scene.environment = null
    this.dome.geometry.dispose()
    this.dome.material.dispose()
    this.stars.geometry.dispose()
    this.stars.material.dispose()
    this.companionBody.geometry.dispose()
    this.companionBody.material.dispose()
    this.companionHalo.geometry.dispose()
    this.companionHalo.material.dispose()
    this.scene.remove(this.group)
  }
}
