import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { buildFaceAtlas, FACE, FACE_LOOPS } from './faces.js'
import { hashString } from '../world/plots.js'

/**
 * Every fish on the reef, in two draw calls.
 *
 * This is the reef's counterpart to `Astronauts`, with the same interface — the colony
 * hands either one a roster and asks it to update, pick, hover and select — so the rest of
 * the game never learns which it is talking to. What differs is everything visible.
 *
 * A fish has no skeleton to bake. Its whole animation is one sine wave travelling down its
 * body, so the "vertex animation texture" the crew needs collapses to two floats per
 * instance: where the wave is and how big it is. The vertex shader bends each vertex by
 * that wave scaled by how far back along the body it sits, and the entire school — six fish
 * or six hundred — is one `InstancedMesh`. A second instanced mesh draws the columns of
 * bubbles over anyone waiting on you, which is the signal you can read from across the
 * whole reef.
 *
 * Everything else that would normally want a material of its own rides along as instanced
 * attributes: body colour through `instanceColor`, fin colour, a stripe switch, how drained
 * the colour is (a blocked fish loses it), and a glow for the bloom pass to catch.
 *
 * Behaviour is the same six states the astronauts have, translated:
 *
 *   working      → nosing at the sand by its coral, kicking up sediment
 *   waiting      → rises toward the surface, turns to face you, a column of bubbles
 *   blocked      → lists onto its side near the bottom, colour drained
 *   celebrating  → loops the loop, with a flash at the top
 *   sleeping     → rests on the sand, barely moving
 *   idle         → mills about its shelf at cruising height
 */

const SWIM_SPEED = 2.4
const TURN_RATE = 5.5
/** How many fish may swim out of the wreck in one reconcile; the rest are already out. */
const MAX_ENTRANCE = 6
const DOORWAY_CLEAR = 5
const WAYPOINT_REACHED = 0.55
/** Fish hold each other off at about a body length. */
const SEPARATION = 1.3
const CONTACT = 0.9
const DRIFT_ARRIVE = 0.9
const DRIFT_PACE = 0.55
const ARRIVE_RADIUS = SEPARATION + 0.5
const PATH_BUDGET = 6
/** The bubble column: how tall, how wide. */
const COLUMN_HEIGHT = 9
const COLUMN_WIDTH = 1.1

/**
 * Reef fish, as body + fin colour, and whether the body carries bars. Chosen by hashing the
 * thread id, so a thread is the same fish every time the reef is opened.
 */
const SPECIES = [
  { body: 0xf08a3c, fin: 0xffffff, stripe: 1 }, // clownfish
  { body: 0xf5d442, fin: 0x2a2a3a, stripe: 0 }, // yellow tang
  { body: 0x3f7fe0, fin: 0xf5d442, stripe: 0 }, // blue tang
  { body: 0x8b5cc9, fin: 0xf0a0d0, stripe: 1 }, // royal gramma
  { body: 0x3fa8a0, fin: 0xffffff, stripe: 0 }, // teal
  { body: 0xe84f5a, fin: 0xffffff, stripe: 1 }, // red and white
  { body: 0xf0f0e8, fin: 0x2a2a3a, stripe: 1 }, // moorish idol
  { body: 0x6fd06a, fin: 0xf5d442, stripe: 0 }, // green chromis
]

/**
 * What each behaviour adds on top of the species: a glow the bloom pass lifts, how much of
 * the body's colour drains away, how high off the sand the fish holds, and the HUD colours
 * the card reads. Glow pushed past 1.0 on purpose.
 */
const LOOK = {
  working: { trim: 0x4f9a63, eye: [0.35, 2.5, 1.15], glow: [0.35, 2.5, 1.15], glowI: 0.12, drain: 0, hover: 0.35 },
  waiting: { trim: 0x4f7ec9, eye: [0.45, 1.5, 3.0], glow: [0.45, 1.5, 3.0], glowI: 0.75, drain: 0, hover: 3.1 },
  blocked: { trim: 0xc94f4f, eye: [3.0, 0.5, 0.45], glow: [3.0, 0.5, 0.45], glowI: 0.35, drain: 0.85, hover: 0.5 },
  celebrating: { trim: 0xc9a24f, eye: [2.9, 2.1, 0.6], glow: [2.9, 2.1, 0.6], glowI: 0.3, drain: 0, hover: 1.5 },
  idle: { trim: 0x8b8b85, eye: [1.1, 1.5, 1.7], glow: [1, 1, 1], glowI: 0, drain: 0, hover: 1.3 },
  sleeping: { trim: 0x5a5a70, eye: [0.7, 0.8, 1.4], glow: [0.7, 0.8, 1.4], glowI: 0.04, drain: 0.35, hover: 0.12 },
  spawning: { trim: 0xc96442, eye: [2.4, 1.4, 0.7], glow: [2.4, 1.4, 0.7], glowI: 0.2, drain: 0, hover: 1.0 },
  leaving: { trim: 0x6f7f75, eye: [1.0, 1.0, 1.1], glow: [1, 1, 1.1], glowI: 0.1, drain: 0, hover: 1.2 },
}

export class Fish {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.agents = []
    this.byId = new Map()
    this.capacity = 0
    this.group = new THREE.Group()
    this.group.name = 'fish'
    scene.add(this.group)
    /** Set by the colony: a waiting fish turns to face whoever is looking. */
    this.camera = null
    this.nav = null
    /** Picking aims at the body itself: `pos` already is the middle of the fish. */
    this.headHeight = 0

    // The HUD's thread card draws a little face from this atlas, the same one the crew
    // wears. A fish has no visor, but the card is the card.
    this.faceTexture = buildFaceAtlas(Math.min(settings.textureSize, 256))
    this._buildMeshes(Math.max(64, settings.get('maxAgents')))

    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._v = new THREE.Vector3()
    this._one = new THREE.Vector3(1, 1, 1)
    this._color = new THREE.Color()
    this._wp = new THREE.Vector3()
    this._sep = new THREE.Vector3()
    this._pickBadge = new THREE.Vector3()
    this._pickLifted = new THREE.Vector3()
    this._buckets = new Map()
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildMeshes(capacity) {
    this.capacity = capacity

    const geo = fishGeometry()
    this.swimAttr = instanced(geo, 'aSwim', 2, capacity)
    this.accentAttr = instanced(geo, 'aAccent', 3, capacity)
    this.glowAttr = instanced(geo, 'aGlow', 4, capacity)
    this.fxAttr = instanced(geo, 'aFx', 2, capacity)

    const material = decorateFish(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide })
    )
    const mesh = new THREE.InstancedMesh(geo, material, capacity)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.receiveShadow = false
    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    mesh.customDepthMaterial = decorateFish(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), {
      depth: true,
    })
    this.school = mesh
    this.group.add(mesh)

    // The bubble columns.
    const colGeo = new THREE.PlaneGeometry(1, 1)
    this.columnCenters = instanced(colGeo, 'aCenter', 3, capacity)
    this.columnSeeds = instanced(colGeo, 'aSeed', 1, capacity)
    this.columnUniforms = { uTime: { value: 0 } }
    const colMat = new THREE.ShaderMaterial({
      uniforms: this.columnUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false, // the signal that wants you is never hidden behind a coral
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: COLUMN_VERT,
      fragmentShader: COLUMN_FRAG,
    })
    this.columns = new THREE.InstancedMesh(colGeo, colMat, capacity)
    this.columns.count = 0
    this.columns.frustumCulled = false
    this.columns.renderOrder = 9
    this.group.add(this.columns)

    this._applyShadowFlags()

    // Rings on the sand under the hovered and selected fish.
    this.hoverRing = ring(0.42, 0.5, 0x9fd8ff, 0.5)
    this.selectRing = ring(0.5, 0.62, 0xffd28a, 0.9)
    this.hoverRing.visible = false
    this.selectRing.visible = false
    this.group.add(this.hoverRing, this.selectRing)
  }

  _applyShadowFlags() {
    this.school.castShadow = this.settings.shadowSize > 0
  }

  /** The crew rig means nothing to a fish, but the colony offers it to whoever is living here. */
  setRig() {}

  setNavigation(nav) {
    this.nav = nav
  }

  onSettingsChanged(changed) {
    if (changed.has('shadows')) this._applyShadowFlags()
    if (changed.has('maxAgents')) {
      const wanted = Math.max(64, this.settings.get('maxAgents'))
      if (wanted !== this.capacity) {
        this._disposeMeshes()
        this._buildMeshes(wanted)
        for (const agent of this.agents) {
          agent.index = -1
          agent.colorDirty = true
        }
      }
      this.roster && this.setRoster(this.roster)
    }
  }

  _disposeMeshes() {
    for (const mesh of [this.school, this.columns, this.hoverRing, this.selectRing]) {
      this.group.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
      mesh.customDepthMaterial?.dispose()
    }
  }

  // ── roster ──────────────────────────────────────────────────────────────────────────

  setRoster(entries, world) {
    this.roster = entries
    this.world = world || this.world
    const cap = Math.min(this.capacity, this.settings.get('maxAgents'))
    const leaving = this.agents.reduce((n, a) => n + (a.state === 'leaving' ? 1 : 0), 0)
    const wanted = entries.slice(0, Math.max(1, cap - leaving))
    const seen = new Set()

    let entrances = MAX_ENTRANCE
    for (const entry of wanted) {
      seen.add(entry.id)
      const existing = this.byId.get(entry.id)
      if (existing) {
        this._updateAgent(existing, entry)
        continue
      }
      const swimsOut = !entry.known && entrances > 0
      if (swimsOut) entrances--
      this._spawnAgent(entry, swimsOut)
    }

    for (const agent of this.agents) {
      if (!seen.has(agent.id) && agent.state !== 'leaving') this._sendHome(agent)
    }
    return this.agents.length
  }

  _spawnAgent(entry, swimsOut = true) {
    const door = this.world?.shipDoor?.() || new THREE.Vector3(0, 0, 0)
    const jitter = () => (Math.random() - 0.5) * 1.4
    const site = entry.site || door
    const start = swimsOut
      ? new THREE.Vector3(door.x + jitter(), door.y, door.z + jitter())
      : new THREE.Vector3(site.x + jitter(), 0, site.z + jitter())

    const h = hashString(entry.id)
    const species = SPECIES[(h >>> 3) % SPECIES.length]
    const agent = {
      id: entry.id,
      thread: entry.thread,
      status: entry.status,
      site: entry.site ? entry.site.clone() : new THREE.Vector3(),
      anchor: entry.anchor ? entry.anchor.clone() : null,
      workSpot: new THREE.Vector3(),
      workAt: 0,
      pos: start,
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      targetYaw: 0,
      pitch: 0,
      roll: 0,
      speed: SWIM_SPEED * (0.86 + Math.random() * 0.28),
      // Every fish keeps its own clocks, so a school never beats its tails in unison.
      phase: Math.random() * Math.PI * 2,
      swimPhase: Math.random() * Math.PI * 2,
      swimAmp: 0.1,
      state: swimsOut ? 'spawning' : 'swimming',
      stateAge: 0,
      blinkAt: 1 + Math.random() * 4,
      faceFrame: FACE.boot,
      faceTimer: 0,
      faceIndex: 0,
      loop: null,
      species,
      body: new THREE.Color(species.body),
      fin: new THREE.Color(species.fin),
      eye: new THREE.Color(1, 1, 1),
      trim: new THREE.Color(0xffffff),
      glow: new THREE.Color(1, 1, 1),
      glowI: 0,
      drain: 0,
      /** Where it wants to hold above the sand, and where it actually is. */
      hoverTarget: 1.2,
      hover: swimsOut ? 0.5 : 1.2,
      hop: 0,
      /** 0 when not looping; runs 0..1 through one loop-the-loop. */
      loopT: 0,
      loopAt: 0,
      flash: 0,
      groundAt: null,
      groundY: null,
      groundX: 0,
      groundZ: 0,
      groundSpeed: 0,
      blocked: false,
      driftBlocked: false,
      wander: new THREE.Vector3(),
      wanderAt: 0,
      scale: swimsOut ? 0 : 1,
      alive: true,
      path: null,
      pathAt: 0,
      pathVersion: -1,
      pathGoal: new THREE.Vector3(NaN, 0, NaN),
      colorDirty: true,
      index: -1,
      walkAmp: 0,
      /** Set while nosing the sand, so the colony knows when to kick up sediment. */
      digging: false,
      screen: new THREE.Vector3(),
    }
    this._applyStatus(agent, entry.status)
    this.agents.push(agent)
    this.byId.set(agent.id, agent)
    return agent
  }

  _updateAgent(agent, entry) {
    agent.thread = entry.thread
    if (entry.site) {
      const moved = Math.hypot(entry.site.x - agent.site.x, entry.site.z - agent.site.z) > 0.05
      agent.site.copy(entry.site)
      const away = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z)
      if (moved && agent.state === 'at-site' && away > ARRIVE_RADIUS) {
        agent.state = 'swimming'
        agent.stateAge = 0
        agent.pathVersion = -1
      }
    }
    if (entry.anchor) (agent.anchor ||= new THREE.Vector3()).copy(entry.anchor)
    if (entry.status !== agent.status) {
      agent.status = entry.status
      this._applyStatus(agent, entry.status)
    }
  }

  _applyStatus(agent, status) {
    const look = LOOK[status] || LOOK.idle
    agent.trim.set(look.trim)
    agent.eye.setRGB(look.eye[0], look.eye[1], look.eye[2])
    agent.glow.setRGB(look.glow[0], look.glow[1], look.glow[2])
    agent.glowBase = look.glowI
    agent.drainTarget = look.drain
    agent.hoverTarget = look.hover
    agent.loop = FACE_LOOPS[status] || null
    agent.colorDirty = true

    if (status === 'leaving') {
      this._sendHome(agent)
      return
    }
    if (agent.state !== 'spawning') agent.state = 'swimming'
    agent.stateAge = 0
    agent.pathVersion = -1
  }

  _nearDoor(pos) {
    const door = this.world?.shipDoor?.()
    if (!door) return false
    const dx = pos.x - door.x
    const dz = pos.z - door.z
    return dx * dx + dz * dz < DOORWAY_CLEAR * DOORWAY_CLEAR
  }

  _sendHome(agent) {
    if (agent.state === 'leaving' || agent.state === 'gone') return
    agent.state = 'leaving'
    agent.stateAge = 0
    agent.loop = null
    agent.faceFrame = FACE.wink
    agent.pathVersion = -1
    agent.hoverTarget = LOOK.leaving.hover
    const door = this.world?.shipDoor?.()
    if (door) agent.site.set(door.x, 0, door.z)
  }

  remove(id) {
    const agent = this.byId.get(id)
    if (agent) this._sendHome(agent)
  }

  // ── per-frame simulation ────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    const reduced = this.settings.get('reducedMotion')
    const anim = reduced ? 0.35 : 1
    let write = 0

    this._rebuildBuckets()
    this._routeBudget = PATH_BUDGET

    for (let i = this.agents.length - 1; i >= 0; i--) {
      const agent = this.agents[i]
      agent.stateAge += dt
      this._step(agent, dt, elapsed, anim)
      this._face(agent, dt)
      if (agent.state === 'gone') {
        this.agents.splice(i, 1)
        this.byId.delete(agent.id)
        continue
      }
      write++
    }

    this._writeInstances(elapsed, anim)
    return write
  }

  _steerTarget(agent, out) {
    const nav = this.nav
    if (!nav) return out.copy(agent.site)
    const stale = agent.pathVersion !== nav.version || agent.pathGoal.distanceToSquared(agent.site) > 0.25
    if (stale && this._routeBudget > 0) {
      this._routeBudget--
      agent.path = nav.findPath(agent.pos.x, agent.pos.z, agent.site.x, agent.site.z)
      agent.pathAt = 0
      agent.pathVersion = nav.version
      agent.pathGoal.copy(agent.site)
    }
    const path = agent.path
    if (!path || !path.length) return out.copy(agent.site)
    while (agent.pathAt < path.length - 1) {
      const wp = path[agent.pathAt]
      const dx = wp.x - agent.pos.x
      const dz = wp.z - agent.pos.z
      if (dx * dx + dz * dz > WAYPOINT_REACHED * WAYPOINT_REACHED) break
      agent.pathAt++
    }
    if (agent.pathAt >= path.length) return out.copy(agent.site)
    const wp = path[agent.pathAt]
    return out.set(wp.x, 0, wp.z)
  }

  _step(agent, dt, elapsed, anim) {
    const fromX = agent.pos.x
    const fromZ = agent.pos.z
    const fromY = agent.pos.y
    agent.blocked = false
    agent.digging = false
    agent.flash = Math.max(0, agent.flash - dt * 3)
    const steer = this._steerTarget(agent, this._wp)
    const toSite = this._v.set(steer.x - agent.pos.x, 0, steer.z - agent.pos.z)
    const dist = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z)

    let hover = agent.hoverTarget
    let pitch = 0
    let roll = 0

    switch (agent.state) {
      case 'spawning': {
        agent.scale = Math.min(1, agent.scale + dt * 2.2)
        if (agent.stateAge > 0.9) agent.state = 'swimming'
        this._swim(agent, toSite, dist, dt, 0.6)
        hover = 1.0
        break
      }

      case 'swimming': {
        agent.scale = Math.min(1, agent.scale + dt * 3)
        this._swim(agent, toSite, dist, dt, 1)
        // Cruise above the reef on the way; the status decides the height on arrival.
        hover = Math.max(1.2, agent.hoverTarget * 0.6)
        const stuck = (agent.blocked && agent.stateAge > 8) || agent.stateAge > 45
        if (dist < ARRIVE_RADIUS || stuck) {
          const inDoorway = this._nearDoor(agent.pos)
          if (stuck && dist >= ARRIVE_RADIUS && !inDoorway) agent.site.copy(agent.pos)
          if (stuck && inDoorway) {
            agent.stateAge = 0
            agent.pathVersion = -1
            break
          }
          agent.state = agent.status === 'leaving' ? 'leaving' : 'at-site'
          agent.stateAge = 0
        }
        break
      }

      case 'at-site': {
        switch (agent.status) {
          case 'idle':
            this._drift(agent, dt, elapsed)
            // Idlers pick a new cruising height with every wander leg.
            hover = agent.wanderHover ?? 1.3
            break
          case 'working':
            if (agent.anchor) this._workRound(agent, dt, elapsed)
            else this._hold(agent, dt)
            // Nose down at the sand, tail up: the pose that reads as *doing something*.
            if (!agent.moving) {
              pitch = 0.85
              agent.digging = true
            }
            break
          case 'waiting':
            this._hold(agent, dt)
            // Up toward the light and facing the camera: asking *you*, specifically.
            if (this.camera) {
              const c = this.camera.position
              agent.targetYaw = Math.atan2(c.x - agent.pos.x, c.z - agent.pos.z)
            }
            pitch = -0.2
            break
          case 'blocked':
            this._hold(agent, dt)
            // Listing onto its side, with a slow wobble so it reads as stuck rather than dead.
            roll = 1.35 + Math.sin(elapsed * 0.9 + agent.phase) * 0.12
            break
          case 'celebrating':
            this._hold(agent, dt)
            agent.targetYaw += dt * 0.8 * anim
            // Loop the loop every few seconds: pitch runs a full turn, the fish lifts through
            // the top of it, and flashes at the apex.
            if (agent.loopT <= 0 && elapsed > agent.loopAt) agent.loopT = 1e-3
            if (agent.loopT > 0) {
              agent.loopT += dt / 1.4
              if (agent.loopT >= 1) {
                agent.loopT = 0
                agent.loopAt = elapsed + 3 + Math.random() * 4
              } else {
                pitch = agent.loopT * Math.PI * 2
                hover += Math.sin(agent.loopT * Math.PI) * 0.9
                if (agent.loopT > 0.45 && agent.loopT < 0.55 && agent.flash <= 0) agent.flash = 1
              }
            }
            break
          case 'sleeping':
            this._hold(agent, dt)
            roll = 0.25
            break
          default:
            this._hold(agent, dt)
        }
        break
      }

      case 'leaving': {
        agent.scale = Math.max(0, agent.scale - (dist < 1.6 ? dt * 2.2 : 0))
        this._swim(agent, toSite, dist, dt, 1.15)
        hover = 1.2
        if (agent.scale <= 0.001 || (dist < 0.9 && agent.stateAge > 1.5) || agent.stateAge > 22) {
          agent.state = 'gone'
        }
        break
      }
    }

    // How fast the fish *actually* travelled — what drives the tail beat.
    const moved = Math.hypot(agent.pos.x - fromX, agent.pos.z - fromZ) / Math.max(dt, 1e-4)
    agent.groundSpeed = moved > agent.groundSpeed ? moved : THREE.MathUtils.damp(agent.groundSpeed || 0, moved, 20, dt)
    agent.walkAmp = THREE.MathUtils.damp(agent.walkAmp || 0, Math.min(1, agent.groundSpeed / SWIM_SPEED), 8, dt)
    agent.moving = agent.groundSpeed > 0.15

    // Tail beat: faster when swimming, a lazy flick at rest, a twitch when stuck.
    const restAmp =
      agent.status === 'blocked' ? 0.02 : agent.status === 'sleeping' ? 0.03 : agent.digging ? 0.2 : 0.07
    const ampTarget = agent.moving ? 0.1 + Math.min(1, agent.groundSpeed / SWIM_SPEED) * 0.16 : restAmp
    agent.swimAmp = THREE.MathUtils.damp(agent.swimAmp, ampTarget, 5, dt)
    const beat = agent.status === 'sleeping' || agent.status === 'blocked' ? 1.6 : 4 + agent.groundSpeed * 4.5
    agent.swimPhase += dt * beat * anim * (agent.digging ? 2.2 : 1)

    // Heading, then the tilt: pitch follows the vertical motion while swimming, roll banks
    // into a turn, and both blend toward whatever the status asks for once settled.
    const yawBefore = agent.yaw
    agent.yaw = angleDamp(agent.yaw, agent.targetYaw, TURN_RATE, dt)
    const yawRate = angleDelta(agent.yaw, yawBefore) / Math.max(dt, 1e-4)

    // Ground and height: the sand is not flat, and a shelf is a raised slab.
    const ground = this.world?.groundAt
    if (ground) {
      if (agent.groundAt === null || Math.abs(agent.pos.x - agent.groundX) + Math.abs(agent.pos.z - agent.groundZ) > 0.2) {
        agent.groundX = agent.pos.x
        agent.groundZ = agent.pos.z
        agent.groundAt = ground(agent.pos.x, agent.pos.z)
      }
      agent.groundY = agent.groundY === null ? agent.groundAt : THREE.MathUtils.damp(agent.groundY, agent.groundAt, 14, dt)
    }
    agent.hover = THREE.MathUtils.damp(agent.hover, hover, 2.2, dt)
    agent.pos.y = (agent.groundY || 0) + agent.hover
    agent.hop = 0

    const vy = (agent.pos.y - fromY) / Math.max(dt, 1e-4)
    // Rising is nose-up, which about +X is a negative turn.
    const travelPitch = agent.moving ? THREE.MathUtils.clamp(-Math.atan2(vy, Math.max(0.3, agent.groundSpeed)), -0.6, 0.6) : 0
    const wantPitch = agent.loopT > 0 ? pitch : pitch + travelPitch
    // A loop has to run *through* the top, so it is not damped — the damping would take
    // the short way round and the fish would nod instead of flipping.
    agent.pitch = agent.loopT > 0 ? wantPitch : angleDamp(agent.pitch, wantPitch, 5, dt)
    const bank = THREE.MathUtils.clamp(-yawRate * 0.22, -0.55, 0.55) * Math.min(1, agent.groundSpeed / 0.6)
    agent.roll = angleDamp(agent.roll, roll + bank, 4, dt)

    // Colour drain and glow ease rather than snap.
    agent.drain = THREE.MathUtils.damp(agent.drain, agent.drainTarget ?? 0, 3, dt)
    const pulse =
      agent.status === 'waiting'
        ? 0.7 + 0.3 * Math.sin(elapsed * 3.2 + agent.phase)
        : agent.status === 'blocked'
          ? Math.sin(elapsed * 9) > 0.2
            ? 1
            : 0.15
          : 0.75 + 0.25 * Math.sin(elapsed * 2.4 + agent.phase)
    agent.glowI = THREE.MathUtils.damp(agent.glowI, (agent.glowBase ?? 0) * pulse + agent.flash * 3, 8, dt)
  }

  /** Steer along the route and slide against anything solid — the same rules as walking. */
  _swim(agent, toTarget, goalDist, dt, factor) {
    const legDist = toTarget.length()
    if (legDist > 0.05) {
      const dir = toTarget.divideScalar(legDist)
      const want = agent.speed * factor * Math.min(1, goalDist / 1.8)
      agent.vel.x = THREE.MathUtils.damp(agent.vel.x, dir.x * want, 4, dt)
      agent.vel.z = THREE.MathUtils.damp(agent.vel.z, dir.z * want, 4, dt)
    }
    const push = this._separation(agent, this._sep)
    const dx = (agent.vel.x + push.x) * dt
    const dz = (agent.vel.z + push.z) * dt
    if (this.nav) {
      if (!this.nav.slide(agent.pos, dx, dz)) {
        agent.vel.multiplyScalar(0.4)
        agent.pathVersion = -1
        agent.blocked = true
      }
    } else {
      agent.pos.x += dx
      agent.pos.z += dz
    }
    if (Math.hypot(agent.vel.x, agent.vel.z) > 0.05) agent.targetYaw = Math.atan2(agent.vel.x, agent.vel.z)
  }

  /** Arrived and staying: stop, keep facing the site, and yield only to a fish inside us. */
  _hold(agent, dt) {
    agent.vel.set(0, 0, 0)
    if (agent.status !== 'sleeping' && agent.status !== 'waiting' && agent.status !== 'celebrating') {
      const target = agent.status === 'working' && agent.anchor ? agent.anchor : agent.site
      this._faceToward(agent, target)
    }
    this._settle(agent, dt)
  }

  _rebuildBuckets() {
    const buckets = this._buckets
    buckets.clear()
    for (const agent of this.agents) {
      if (agent.state === 'gone' || agent.scale < 0.2) continue
      const key = ((agent.pos.x / 2) | 0) * 10007 + ((agent.pos.z / 2) | 0)
      let list = buckets.get(key)
      if (!list) buckets.set(key, (list = []))
      list.push(agent)
    }
  }

  _crowded(x, z, ignore) {
    const bx = (x / 2) | 0
    const bz = (z / 2) | 0
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = this._buckets.get((bx + ox) * 10007 + (bz + oz))
        if (!list) continue
        for (const other of list) {
          if (other === ignore) continue
          const dx = x - other.pos.x
          const dz = z - other.pos.z
          if (dx * dx + dz * dz < SEPARATION * SEPARATION) return true
        }
      }
    }
    return false
  }

  _separation(agent, out) {
    out.set(0, 0, 0)
    const bx = (agent.pos.x / 2) | 0
    const bz = (agent.pos.z / 2) | 0
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = this._buckets.get((bx + ox) * 10007 + (bz + oz))
        if (!list) continue
        for (const other of list) {
          if (other === agent) continue
          const dx = agent.pos.x - other.pos.x
          const dz = agent.pos.z - other.pos.z
          const d2 = dx * dx + dz * dz
          if (d2 > SEPARATION * SEPARATION || d2 < 1e-6) continue
          // Fish at different heights are not in each other's way.
          if (Math.abs(agent.pos.y - other.pos.y) > 0.9) continue
          const d = Math.sqrt(d2)
          const strength = (1 - d / SEPARATION) * 1.2 + (d < CONTACT ? (1 - d / CONTACT) * 5 : 0)
          out.x += (dx / d) * strength
          out.z += (dz / d) * strength
        }
      }
    }
    return out
  }

  /** A slow wander around the shelf, re-targeted every few seconds, at a new height each leg. */
  _drift(agent, dt, elapsed) {
    if (elapsed > agent.wanderAt) {
      agent.wanderAt = elapsed + 3 + Math.random() * 5
      agent.wander.copy(agent.site)
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2
        const r = 0.8 + Math.random() * 2.4
        const wx = agent.site.x + Math.cos(a) * r
        const wz = agent.site.z + Math.sin(a) * r
        if (this.nav?.isBlocked(wx, wz)) continue
        if (this._crowded(wx, wz, agent)) continue
        agent.wander.set(wx, 0, wz)
        break
      }
      agent.wanderHover = 0.9 + Math.random() * 1.2
      agent.driftBlocked = false
    }
    const to = this._v.set(agent.wander.x - agent.pos.x, 0, agent.wander.z - agent.pos.z)
    const d = to.length()
    if (d > DRIFT_ARRIVE && !agent.driftBlocked) {
      this._swim(agent, to, d, dt, DRIFT_PACE)
      if (agent.blocked) agent.driftBlocked = true
      return
    }
    agent.vel.set(0, 0, 0)
    this._settle(agent, dt)
  }

  _settle(agent, dt) {
    const push = this._separation(agent, this._sep)
    if (push.x === 0 && push.z === 0) return
    const dx = push.x * dt
    const dz = push.z * dt
    if (this.nav) this.nav.slide(agent.pos, dx, dz)
    else {
      agent.pos.x += dx
      agent.pos.z += dz
    }
  }

  /** Working: nose at the sand round the coral, moving to a new side every so often. */
  _workRound(agent, dt, elapsed) {
    if (elapsed > agent.workAt) {
      agent.workAt = elapsed + 5 + Math.random() * 7
      const radius = Math.max(1.6, Math.hypot(agent.site.x - agent.anchor.x, agent.site.z - agent.anchor.z))
      const from = Math.atan2(agent.pos.z - agent.anchor.z, agent.pos.x - agent.anchor.x)
      agent.workSpot.copy(agent.site)
      for (let i = 0; i < 4; i++) {
        const a = from + (Math.random() > 0.5 ? 1 : -1) * (1.1 + Math.random() * 1.6)
        const wx = agent.anchor.x + Math.cos(a) * radius
        const wz = agent.anchor.z + Math.sin(a) * radius
        if (this.nav?.isBlocked(wx, wz)) continue
        if (this._crowded(wx, wz, agent)) continue
        agent.workSpot.set(wx, 0, wz)
        break
      }
      agent.driftBlocked = false
    }
    const to = this._v.set(agent.workSpot.x - agent.pos.x, 0, agent.workSpot.z - agent.pos.z)
    const d = to.length()
    if (d > DRIFT_ARRIVE && !agent.driftBlocked) {
      this._swim(agent, to, d, dt, DRIFT_PACE)
      if (agent.blocked) agent.driftBlocked = true
      return
    }
    agent.vel.set(0, 0, 0)
    this._faceToward(agent, agent.anchor)
    this._settle(agent, dt)
  }

  _faceToward(agent, point) {
    const dx = point.x - agent.pos.x
    const dz = point.z - agent.pos.z
    if (Math.abs(dx) + Math.abs(dz) > 0.01) agent.targetYaw = Math.atan2(dx, dz)
  }

  /** The face the HUD card shows: a status loop, interrupted by this fish's own blink. */
  _face(agent, dt) {
    agent.faceTimer += dt
    agent.blinkAt -= dt
    if (agent.state === 'spawning' && agent.stateAge < 0.8) {
      agent.faceFrame = FACE.boot
      return
    }
    if (agent.state === 'leaving') {
      agent.faceFrame = agent.stateAge % 2 < 1.4 ? FACE.happy : FACE.wink
      return
    }
    if (agent.blinkAt <= 0 && agent.status !== 'sleeping' && agent.status !== 'blocked') {
      agent.faceFrame = FACE.blink
      if (agent.blinkAt < -0.12) agent.blinkAt = 2.4 + Math.random() * 5
      return
    }
    const loop = agent.loop
    if (!loop || !loop.length) {
      agent.faceFrame = FACE.idle
      return
    }
    const rate = agent.status === 'working' ? 0.22 : 0.55
    if (agent.faceTimer > rate) {
      agent.faceTimer = 0
      agent.faceIndex = (agent.faceIndex + 1) % loop.length
    }
    agent.faceFrame = loop[agent.faceIndex]
  }

  // ── writing the instance buffers ────────────────────────────────────────────────────

  _writeInstances(elapsed, anim) {
    const school = this.school
    const m = this._m
    const q = this._q
    const e = this._e
    const v = this._v
    const one = this._one
    const swim = this.swimAttr.array
    const accent = this.accentAttr.array
    const glow = this.glowAttr.array
    const fx = this.fxAttr.array
    const centers = this.columnCenters.array
    const seeds = this.columnSeeds.array
    const c = this._color

    let i = 0
    let columns = 0
    let colorDirty = false
    for (const agent of this.agents) {
      // Never write past the buffers: one instance too many takes the whole school off screen.
      if (i >= this.capacity) break
      if (agent.state === 'gone') continue
      const s = agent.scale
      if (s <= 0.001) continue

      e.set(agent.pitch, agent.yaw, agent.roll, 'YXZ')
      q.setFromEuler(e)
      v.set(agent.pos.x, agent.pos.y, agent.pos.z)
      m.compose(v, q, one.setScalar(s))
      one.setScalar(1)
      school.setMatrixAt(i, m)

      swim[i * 2] = agent.swimPhase
      swim[i * 2 + 1] = agent.swimAmp * anim
      glow[i * 4] = agent.glow.r
      glow[i * 4 + 1] = agent.glow.g
      glow[i * 4 + 2] = agent.glow.b
      glow[i * 4 + 3] = agent.glowI
      fx[i * 2] = agent.drain
      fx[i * 2 + 1] = agent.species.stripe

      if (agent.index !== i || agent.colorDirty) {
        agent.colorDirty = false
        school.setColorAt(i, c.copy(agent.body))
        accent[i * 3] = agent.fin.r
        accent[i * 3 + 1] = agent.fin.g
        accent[i * 3 + 2] = agent.fin.b
        colorDirty = true
      }

      // The column of bubbles: only over a fish that is waiting on you, and only once it
      // has arrived — a signal trailing a swimming fish is noise.
      if (agent.state === 'at-site' && agent.status === 'waiting') {
        centers[columns * 3] = agent.pos.x
        centers[columns * 3 + 1] = agent.pos.y + 0.3
        centers[columns * 3 + 2] = agent.pos.z
        seeds[columns] = agent.phase
        columns++
      }

      agent.index = i
      i++
    }

    school.count = i
    school.instanceMatrix.needsUpdate = true
    this.swimAttr.needsUpdate = true
    this.glowAttr.needsUpdate = true
    this.fxAttr.needsUpdate = true
    if (colorDirty) {
      school.instanceColor.needsUpdate = true
      this.accentAttr.needsUpdate = true
    }
    this.columns.count = columns
    this.columnCenters.needsUpdate = true
    this.columnSeeds.needsUpdate = true
    this.columnUniforms.uTime.value = elapsed
    this.visibleCount = i
  }

  // ── picking ─────────────────────────────────────────────────────────────────────────

  /** Nearest fish to a screen point, the badge over it counting as part of it. */
  pick(camera, ndcX, ndcY, aspect, maxDist = 0.075) {
    let best = null
    let bestScore = Infinity
    const v = this._v
    const b = this._pickBadge
    const lifted = this._pickLifted
    for (const agent of this.agents) {
      if (agent.scale < 0.3 || agent.state === 'gone') continue
      v.set(agent.pos.x, agent.pos.y, agent.pos.z).project(camera)
      if (v.z > 1) continue
      agent.screen.copy(v)
      const dx = (v.x - ndcX) * aspect
      const dy = v.y - ndcY
      let d = Math.hypot(dx, dy)
      const size = agent.badgeSize || 0
      if (size > 0) {
        b.set(agent.pos.x, agent.badgeY, agent.pos.z).applyMatrix4(camera.matrixWorldInverse)
        const scale = size * (2 + -b.z * 0.22)
        b.y += scale * 0.5
        lifted.copy(b)
        lifted.y += scale * 0.5
        b.applyMatrix4(camera.projectionMatrix)
        lifted.applyMatrix4(camera.projectionMatrix)
        if (b.z <= 1) {
          const half = Math.abs(lifted.y - b.y)
          const bx = (b.x - ndcX) * aspect
          const by = b.y - ndcY
          const ox = Math.max(0, Math.abs(bx) - half)
          const oy = Math.max(0, Math.abs(by) - half)
          const bd = Math.hypot(ox, oy)
          if (bd < d) d = bd
        }
      }
      if (d > maxDist) continue
      const score = d + v.z * 0.05
      if (score < bestScore) {
        bestScore = score
        best = agent
      }
    }
    return best
  }

  setHover(agent) {
    this.hoverRing.visible = Boolean(agent)
    if (agent) this.hoverRing.position.set(agent.pos.x, (agent.groundY ?? 0) + 0.03, agent.pos.z)
  }

  setSelected(agent) {
    this.selected = agent || null
    this.selectRing.visible = Boolean(agent)
  }

  updateRings(elapsed) {
    if (this.selected) {
      if (!this.byId.has(this.selected.id)) this.setSelected(null)
      else {
        const a = this.selected
        this.selectRing.position.set(a.pos.x, (a.groundY ?? 0) + 0.035, a.pos.z)
        this.selectRing.rotation.y = elapsed * 0.6
        this.selectRing.scale.setScalar(1 + Math.sin(elapsed * 3) * 0.05)
      }
    }
    if (this.hoverRing.visible) this.hoverRing.rotation.y = -elapsed * 0.4
  }

  /** A quick loop — played when you open a fish's thread. */
  celebrate(id) {
    const agent = this.byId.get(id)
    if (!agent) return
    agent.faceFrame = FACE.happy
    agent.blinkAt = 1.5
    agent.flash = 1
  }

  dispose() {
    this._disposeMeshes()
    this.faceTexture.dispose()
    this.scene.remove(this.group)
  }
}

// ── the fish itself ───────────────────────────────────────────────────────────────────

/**
 * One fish, nose along +Z, about a unit long. Body, tail, dorsal fin, two pectorals and a
 * pair of eyes, each carrying a pattern id (0 body, 1 fin, 2 eye) and how far back along
 * the body it sits, which is what the swim wave scales by.
 */
function fishGeometry() {
  const parts = []

  const body = new THREE.SphereGeometry(0.5, 16, 10)
  body.scale(0.3, 0.42, 1.05)
  parts.push(tag(body, 0))

  // Fins are single triangles; the material is double-sided so they read from both sides.
  parts.push(tag(tri([0, 0, -0.48], [0, 0.46, -1.02], [0, 0.04, -0.78]), 1))
  parts.push(tag(tri([0, 0, -0.48], [0, -0.04, -0.78], [0, -0.46, -1.02]), 1))
  parts.push(tag(tri([0, 0.18, 0.18], [0, 0.52, -0.12], [0, 0.2, -0.46]), 1))
  parts.push(tag(tri([-0.13, -0.02, 0.2], [-0.44, -0.16, -0.02], [-0.13, -0.09, -0.06]), 1))
  parts.push(tag(tri([0.13, -0.02, 0.2], [0.13, -0.09, -0.06], [0.44, -0.16, -0.02]), 1))

  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.052, 7, 5)
    eye.translate(side * 0.135, 0.09, 0.36)
    parts.push(tag(eye, 2))
  }

  // Spheres arrive indexed and the fins do not; a merge wants one or the other.
  const flat = parts.map((p) => {
    p.deleteAttribute('uv')
    return p.index ? p.toNonIndexed() : p
  })
  const merged = BufferGeometryUtils.mergeGeometries(flat, false)
  parts.forEach((g) => g.dispose())
  flat.forEach((g) => g.dispose())
  merged.computeBoundingSphere()
  return merged
}

function tri(a, b, c) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3))
  geo.computeVertexNormals()
  return geo
}

/** Stamp a part with its pattern id and how much of the swim wave reaches each vertex. */
function tag(geo, pattern) {
  const pos = geo.attributes.position
  const n = pos.count
  const patterns = new Float32Array(n).fill(pattern)
  const bends = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const z = pos.getZ(i)
    // Nothing forward of the gills moves; the tail moves fully.
    const t = THREE.MathUtils.clamp((0.15 - z) / 1.15, 0, 1)
    bends[i] = t * t
  }
  geo.setAttribute('aPattern', new THREE.BufferAttribute(patterns, 1))
  geo.setAttribute('aBend', new THREE.BufferAttribute(bends, 1))
  return geo
}

function instanced(geo, name, size, capacity) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size)
  attr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute(name, attr)
  return attr
}

/**
 * The swim and the paint job, on any three material. The depth variant only bends — the
 * shadow has to follow the body, but it has no colour to speak of.
 */
function decorateFish(material, { depth = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aBend;
         attribute float aPattern;
         attribute vec2 aSwim;
         attribute vec3 aAccent;
         attribute vec4 aGlow;
         attribute vec2 aFx;
         varying float vPattern;
         varying vec3 vAccent;
         varying vec4 vGlow;
         varying vec2 vFx;
         varying float vLocalZ;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vPattern = aPattern;
         vAccent = aAccent;
         vGlow = aGlow;
         vFx = aFx;
         vLocalZ = position.z;
         // One wave travelling tailward: phase advances per instance, amplitude scales
         // with how hard this fish is swimming, and aBend keeps the head still.
         transformed.x += sin( aSwim.x - aBend * 2.6 ) * aSwim.y * aBend;`
      )
    if (depth) return

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vPattern;
         varying vec3 vAccent;
         varying vec4 vGlow;
         varying vec2 vFx;
         varying float vLocalZ;`
      )
      .replace(
        '#include <color_fragment>',
        `// Body colour is the instance colour; bars, fins and eyes are painted over it.
         vec3 col = vColor.rgb;
         float bars = vFx.y * smoothstep( 0.6, 0.8, abs( sin( vLocalZ * 9.0 + 1.3 ) ) );
         col = mix( col, vAccent, bars );
         col = mix( col, vAccent, step( 0.5, vPattern ) );
         col = mix( col, vec3( 0.02, 0.02, 0.04 ), step( 1.5, vPattern ) );
         // A blocked fish loses its colour.
         float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
         col = mix( col, vec3( lum ) * 0.8, vFx.x );
         diffuseColor.rgb = col;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Waiting fish glow, celebrating ones flash: the same glow, at different strengths.
         totalEmissiveRadiance += vGlow.rgb * vGlow.a * ( 1.0 - step( 1.5, vPattern ) * 0.7 );`
      )
  }
  return material
}

// ── the bubble column ─────────────────────────────────────────────────────────────────

const COLUMN_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute float aSeed;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    // A tall quad standing on its base, turned about the world's up axis to face the
    // camera — so it is a column from any angle and never a card seen edge-on.
    vec4 mv = modelViewMatrix * vec4( aCenter, 1.0 );
    vec3 up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 right = normalize( cross( vec3( 0.0, 0.0, -1.0 ), up ) );
    mv.xyz += right * position.x * ${COLUMN_WIDTH.toFixed(2)} + up * ( position.y + 0.5 ) * ${COLUMN_HEIGHT.toFixed(2)};
    gl_Position = projectionMatrix * mv;
  }
`

const COLUMN_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vSeed;
  uniform float uTime;
  void main() {
    // Bubbles as hollow rings in a scrolling grid of cells, each cell jittering its own
    // bubble off-centre so the column never reads as a lattice. Soft across, fading out
    // toward the top where the bubbles would reach the surface.
    float t = uTime * 0.55 + vSeed;
    vec2 g = vec2( vUv.x * 3.0, vUv.y * 22.0 - t * 4.0 );
    vec2 cell = floor( g );
    vec2 f = fract( g ) - 0.5;
    vec2 h = fract( sin( cell * vec2( 12.98, 78.23 ) + cell.yx * vec2( 39.3, 11.1 ) + vSeed ) * 43758.5 );
    vec2 c = ( h - 0.5 ) * 0.5;
    float r = 0.16 + h.x * 0.12;
    float d = length( f - c );
    float ring = smoothstep( r, r - 0.05, d ) * smoothstep( r - 0.13, r - 0.06, d );
    float across = 1.0 - pow( abs( vUv.x - 0.5 ) * 2.0, 2.0 );
    float vert = smoothstep( 0.0, 0.08, vUv.y ) * ( 1.0 - smoothstep( 0.55, 1.0, vUv.y ) );
    float haze = across * vert * 0.05;
    float a = ring * across * vert * 0.9 + haze;
    gl_FragColor = vec4( vec3( 0.5, 1.4, 2.2 ) * a, a );
  }
`

// ── helpers ───────────────────────────────────────────────────────────────────────────

function angleDelta(a, b) {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

function angleDamp(current, target, lambda, dt) {
  const delta = angleDelta(target, current)
  return current + delta * (1 - Math.exp(-lambda * dt))
}

function ring(inner, outer, color, opacity) {
  const geo = new THREE.RingGeometry(inner, outer, 32)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 3
  return mesh
}
