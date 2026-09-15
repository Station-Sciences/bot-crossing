import * as THREE from 'three'

/**
 * All the little bits: welding sparks, boot dust, confetti, and the haze that drifts across
 * a planet with an atmosphere.
 *
 * One pool, two draw calls. Particles live in flat typed arrays and are swap-removed on
 * death, so the buffer stays contiguous and the GPU only ever sees the live prefix — no
 * per-particle objects, no allocation during play, and turning particles off in the
 * settings genuinely stops all of it rather than just hiding the result.
 */

const GRAVITY = -3.6

/** How far above whatever it landed on a particle settles, so it skitters on top of it. */
const SETTLE = 0.04

class Pool {
  constructor(capacity, blending) {
    this.capacity = capacity
    this.count = 0

    this.position = new Float32Array(capacity * 3)
    this.velocity = new Float32Array(capacity * 3)
    this.color = new Float32Array(capacity * 3)
    this.size = new Float32Array(capacity)
    this.life = new Float32Array(capacity) // remaining, in seconds
    this.maxLife = new Float32Array(capacity)
    this.drag = new Float32Array(capacity)
    this.gravity = new Float32Array(capacity)
    // Recorded per particle rather than assumed: a plot's deck is a raised slab, so the
    // height a spark bounces off depends entirely on where it was thrown from.
    this.floor = new Float32Array(capacity)
    this.alpha = new Float32Array(capacity)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.color, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    geo.setDrawRange(0, 0)
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      vertexColors: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 1 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          // Perspective-correct point size, clamped so a particle right under the camera
          // cannot blow up into a full-screen quad.
          gl_PointSize = clamp( aSize * uScale * ( 260.0 / -mvPosition.z ), 1.0, 90.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length( d );
          if ( r > 0.5 ) discard;
          // Soft core with a fast falloff — reads as a spark rather than a disc.
          float a = pow( 1.0 - r * 2.0, 1.6 ) * vAlpha;
          gl_FragColor = vec4( vColor, a );
          #include <fog_fragment>
        }
      `,
    })

    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 5
  }

  /** `ground` is the surface this particle was thrown off — a deck, or the terrain. */
  spawn(x, y, z, vx, vy, vz, r, g, b, size, life, drag = 1.2, gravity = 1, ground = 0) {
    // A full pool drops the newest particle rather than stalling or growing.
    if (this.count >= this.capacity) return false
    const i = this.count++
    const i3 = i * 3
    this.position[i3] = x
    this.position[i3 + 1] = y
    this.position[i3 + 2] = z
    this.velocity[i3] = vx
    this.velocity[i3 + 1] = vy
    this.velocity[i3 + 2] = vz
    this.color[i3] = r
    this.color[i3 + 1] = g
    this.color[i3 + 2] = b
    this.size[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.drag[i] = drag
    this.gravity[i] = gravity
    this.floor[i] = ground + SETTLE
    this.alpha[i] = 1
    return true
  }

  update(dt) {
    const { position, velocity, life, maxLife, drag, gravity, floor, alpha } = this
    let i = 0
    while (i < this.count) {
      life[i] -= dt
      if (life[i] <= 0) {
        // Swap-remove: move the last live particle into this slot and shrink.
        const last = --this.count
        if (last !== i) {
          const a = i * 3
          const b = last * 3
          for (let k = 0; k < 3; k++) {
            position[a + k] = position[b + k]
            velocity[a + k] = velocity[b + k]
            this.color[a + k] = this.color[b + k]
          }
          this.size[i] = this.size[last]
          life[i] = life[last]
          maxLife[i] = maxLife[last]
          drag[i] = drag[last]
          gravity[i] = gravity[last]
          floor[i] = floor[last]
          alpha[i] = alpha[last]
        }
        continue // re-test the particle just swapped in
      }

      const i3 = i * 3
      const d = Math.max(0, 1 - drag[i] * dt)
      velocity[i3] *= d
      velocity[i3 + 1] = velocity[i3 + 1] * d + GRAVITY * gravity[i] * dt
      velocity[i3 + 2] *= d
      position[i3] += velocity[i3] * dt
      position[i3 + 1] += velocity[i3 + 1] * dt
      position[i3 + 2] += velocity[i3 + 2] * dt

      // Bounce once off the ground so sparks skitter instead of sinking through it. Against
      // the surface the particle came off, not against y=0 — sparks struck on a plot fall to
      // that plot's deck, and a fixed world floor would drop them through it.
      if (position[i3 + 1] < floor[i] && velocity[i3 + 1] < 0) {
        position[i3 + 1] = floor[i]
        velocity[i3 + 1] *= -0.32
        velocity[i3] *= 0.6
        velocity[i3 + 2] *= 0.6
      }

      const t = life[i] / maxLife[i]
      // Fade in fast, out slow — a linear fade reads as a pop.
      alpha[i] = t > 0.85 ? (1 - t) / 0.15 : t / 0.85
      i++
    }

    this.geometry.setDrawRange(0, this.count)
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
    this.geometry.attributes.aSize.needsUpdate = true
    this.geometry.attributes.aAlpha.needsUpdate = true
  }

  clear() {
    this.count = 0
    this.geometry.setDrawRange(0, 0)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

export class Particles {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.enabled = settings.particleBudget > 0

    const budget = Math.max(64, settings.particleBudget)
    // Sparks and confetti are additive so they read as light; dust is alpha-blended so it
    // reads as matter. That distinction is the whole reason there are two pools.
    this.glow = new Pool(Math.ceil(budget * 0.6), THREE.AdditiveBlending)
    this.dust = new Pool(Math.ceil(budget * 0.4), THREE.NormalBlending)
    scene.add(this.glow.points, this.dust.points)

    this._ambientTimer = 0
    this.setEnabled(this.enabled)
  }

  setEnabled(on) {
    this.enabled = on
    this.glow.points.visible = on
    this.dust.points.visible = on
    if (!on) {
      this.glow.clear()
      this.dust.clear()
    }
  }

  onSettingsChanged(changed) {
    if (changed.has('particles')) this.setEnabled(this.settings.particleBudget > 0)
  }

  /** Welding sparks from an astronaut's hands. `ground` is what the welder is standing on. */
  weld(x, y, z, color, ground = 0) {
    if (!this.enabled) return
    const n = this.settings.get('particles') === 'full' ? 3 : 1
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 0.9 + Math.random() * 2.4
      this.glow.spawn(
        x + (Math.random() - 0.5) * 0.16,
        y + (Math.random() - 0.5) * 0.12,
        z + (Math.random() - 0.5) * 0.16,
        Math.cos(a) * s * 0.5,
        1.1 + Math.random() * 2.2,
        Math.sin(a) * s * 0.5,
        color.r * 2.4,
        color.g * 2.2,
        color.b * 1.6,
        0.055 + Math.random() * 0.05,
        0.35 + Math.random() * 0.5,
        1.6,
        1,
        ground
      )
    }
  }

  /** A puff kicked up by a boot. `ground` is the surface the boot landed on. */
  step(x, y, z, tint, ground = 0) {
    if (!this.enabled) return
    const a = Math.random() * Math.PI * 2
    this.dust.spawn(
      x,
      y + 0.03,
      z,
      Math.cos(a) * 0.28,
      0.24 + Math.random() * 0.2,
      Math.sin(a) * 0.28,
      tint.r,
      tint.g,
      tint.b,
      0.12 + Math.random() * 0.14,
      0.5 + Math.random() * 0.4,
      2.4,
      0.12,
      ground
    )
  }

  /** Confetti for a finished thread. `ground` is what the celebrating agent is standing on. */
  cheer(x, y, z, color, ground = 0) {
    if (!this.enabled) return
    const n = this.settings.get('particles') === 'full' ? 14 : 6
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 0.6 + Math.random() * 1.6
      this.glow.spawn(
        x,
        y + 0.8,
        z,
        Math.cos(a) * s,
        2.4 + Math.random() * 2.4,
        Math.sin(a) * s,
        color.r * (1.4 + Math.random()),
        color.g * (1.4 + Math.random()),
        color.b * (1.4 + Math.random()),
        0.07 + Math.random() * 0.07,
        1.1 + Math.random() * 0.9,
        0.7,
        0.8,
        ground
      )
    }
  }

  /** Thruster wash when the ship is used. */
  thruster(x, y, z) {
    if (!this.enabled) return
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 1.4
      this.dust.spawn(
        x + Math.cos(a) * r,
        y + 0.1,
        z + Math.sin(a) * r,
        Math.cos(a) * (1.6 + Math.random() * 2),
        0.5 + Math.random() * 0.7,
        Math.sin(a) * (1.6 + Math.random() * 2),
        0.55,
        0.5,
        0.46,
        0.3 + Math.random() * 0.3,
        0.9 + Math.random() * 0.6,
        1.6,
        0.08
      )
    }
  }

  /** Sleepy `z` bubbles. */
  snooze(x, y, z) {
    if (!this.enabled) return
    this.glow.spawn(x, y, z, 0.12, 0.42, 0.05, 0.55, 0.6, 1.1, 0.075, 1.9, 0.35, -0.02)
  }

  /**
   * Thought bubbles — a soft purple dot drifting up off a pensive head. Same shape as the
   * sleepy `z` but its own colour and a smaller size, so thinking and sleeping read as
   * different things from across a plot even though both of them are "standing still".
   */
  thought(x, y, z) {
    if (!this.enabled) return
    this.glow.spawn(
      x + (Math.random() - 0.5) * 0.1,
      y,
      z + (Math.random() - 0.5) * 0.1,
      0.06,
      0.26 + Math.random() * 0.16,
      0.02,
      0.72,
      0.52,
      1.2,
      0.055 + Math.random() * 0.025,
      1.5 + Math.random() * 0.6,
      0.45,
      -0.02
    )
  }

  /**
   * Planet haze — dust on Mars, pollen on Terra. Spawned in a ring around the camera so it
   * is always where you are looking without simulating the whole world.
   */
  ambient(dt, camera, planet) {
    if (!this.enabled || !planet.dust) return
    this._ambientTimer -= dt
    if (this._ambientTimer > 0) return
    const rate = this.settings.get('particles') === 'full' ? 0.045 : 0.12
    this._ambientTimer = rate / planet.dust

    const a = Math.random() * Math.PI * 2
    const r = 12 + Math.random() * 34
    const x = camera.position.x + Math.cos(a) * r
    const z = camera.position.z + Math.sin(a) * r
    const terra = planet.id === 'terra'
    this.dust.spawn(
      x,
      0.4 + Math.random() * 5,
      z,
      terra ? (Math.random() - 0.5) * 0.5 : 1.6 + Math.random() * 1.4,
      terra ? 0.15 + Math.random() * 0.25 : 0.1,
      terra ? (Math.random() - 0.5) * 0.5 : 0.7 + Math.random(),
      terra ? 0.85 : 0.78,
      terra ? 0.9 : 0.55,
      terra ? 0.55 : 0.4,
      terra ? 0.09 : 0.2,
      3 + Math.random() * 3,
      0.12,
      terra ? -0.02 : 0.02
    )
  }

  update(dt) {
    if (!this.enabled) return
    this.glow.update(dt)
    this.dust.update(dt)
  }

  get liveCount() {
    return this.glow.count + this.dust.count
  }

  dispose() {
    this.scene.remove(this.glow.points, this.dust.points)
    this.glow.dispose()
    this.dust.dispose()
  }
}
