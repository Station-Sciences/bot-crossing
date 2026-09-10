import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { buildFaceAtlas, FACE, FACE_COUNT, FACE_LOOPS, FRAME_COLS, FRAME_ROWS } from './faces.js'
import { attachMatrixAt, decorateSkinned, frameFor } from './crew.js'
import { hash, SPECIES, speciesFor } from './species.js'

/**
 * Every astronaut in the colony, drawn in seven draw calls.
 *
 * The body is one instanced, GPU-skinned mesh playing KayKit's hand-animated clips (see
 * `crew.js`) — every torso, arm and leg in the colony in a single draw, whether there are
 * six threads or three hundred. Everything the crew *wears* stays procedural and stays in
 * its own `InstancedMesh`: helmet, visor, screen-face, backpack, antenna and lamp, because
 * those carry the colony's own identity and its own shaders.
 *
 * Worn parts are pinned to bones the cheap way. The baked animation lives in an ordinary
 * array as well as in the texture the shader samples, so placing a helmet is one matrix
 * read out of that array — no skeleton is evaluated on the CPU, and the helmet can never
 * be a frame out of step with the head it sits on.
 *
 * Per-agent variation that would normally need a separate material rides along as instanced
 * attributes instead: suit colour and eye colour through `instanceColor`, the face's atlas
 * frame and the body's animation frame through custom `aFrame` attributes.
 *
 * Picking is done analytically rather than by raycasting the instanced meshes — projecting
 * N head positions to screen space is both cheaper and far more forgiving to click at the
 * size these characters render.
 */

const SUIT_TONES = [0xf3f1ec, 0xe8e4dc, 0xf7f4ee, 0xdfe4e8, 0xf1e9df]

/** Trim + eye colour per behaviour. Eyes are pushed past 1.0 so the bloom pass catches them. */
const AGENT_LOOK = {
  working: { trim: 0x4f9a63, eye: [0.35, 2.5, 1.15] },
  waiting: { trim: 0x4f7ec9, eye: [0.45, 1.5, 3.0] },
  blocked: { trim: 0xc94f4f, eye: [3.0, 0.5, 0.45] },
  celebrating: { trim: 0xc9a24f, eye: [2.9, 2.1, 0.6] },
  idle: { trim: 0x8b8b85, eye: [1.1, 1.5, 1.7] },
  sleeping: { trim: 0x5a5a70, eye: [0.7, 0.8, 1.4] },
  spawning: { trim: 0xc96442, eye: [2.4, 1.4, 0.7] },
  leaving: { trim: 0x6f7f75, eye: [1.0, 1.0, 1.1] },
}

const WALK_SPEED = 2.1
const TURN_RATE = 7.5
/**
 * How many astronauts may walk out of the ship in one reconcile. The rest of a big arrival —
 * a reload, a first run, a hidden repo being shown again — are placed on their plots instead.
 */
const MAX_ENTRANCE = 6
/** Around the ramp, where an astronaut standing still blocks everyone still coming out. */
const DOORWAY_CLEAR = 5.5

/** How close counts as "reached this waypoint". A shade over one nav cell. */
const WAYPOINT_REACHED = 0.55
/**
 * How far apart astronauts hold each other, measured against the widest thing they wear:
 * the helmet is 0.95 across, so anything under that is a spacing at which they are visibly
 * inside one another. The old 0.72 was exactly that — separation *was* running and holding
 * them at 0.71, which is a quarter of a helmet of overlap. This leaves real air: a
 * crowd pressed in from every side settles a little tighter than the radius asks for.
 */
const SEPARATION = 1.15
/** Touching distance: a shade over the helmet, which is the widest thing they wear. */
const CONTACT = 1
/**
 * How close an idler has to get to the spot it wandered at before it calls that arriving,
 * and how briskly it ambles there.
 *
 * Both exist to keep a drifting agent's speed *above* the threshold that puts it in a walk
 * clip for the whole leg. `_walk` eases off as it closes, so stopping at a generous radius
 * is what stops the last stretch being a crawl — and a crawl is movement the standing clip
 * cannot express, so it reads as an astronaut gliding across the deck.
 */
const DRIFT_ARRIVE = 0.9
const DRIFT_PACE = 0.55
/**
 * How close to its site counts as arrived. Deliberately derived from SEPARATION and larger
 * than it: if an astronaut had to get closer than its neighbours will let it, one standing
 * on a busy spot could never finish arriving, and would spend the rest of its life shoving
 * at the crowd it was trying to join.
 */
const ARRIVE_RADIUS = SEPARATION + 0.45
/** Paths computed per frame. Re-routing the whole crew takes a few frames, unnoticeably. */
const PATH_BUDGET = 6

/**
 * The mannequin is authored 2.2 units tall. The colony wants a "little guy" silhouette at
 * the isometric rest distance, and the buildings are sized against one — so the whole rig
 * is scaled once, here, and every worn part below is measured in the *scaled* character's
 * own units so the helmet does not have to be re-tuned when this moves.
 */
const CREW_SCALE = 0.56

/**
 * Where the worn parts sit relative to the bone they hang off, in the mannequin's own
 * units — the root transform carries CREW_SCALE, so everything downstream of a bone is
 * measured in the rig's space and stays put if that scale is ever retuned.
 */
const P = {
  helmetR: 0.48,
  headUp: 0.46, // the head bone sits at the neck; the helmet centres above it
  packZ: -0.3,
  packUp: 0.06,
  // The antenna stands on the crown of the helmet rather than out of its side, so it reads
  // at the distance the colony is normally looked at instead of turning into a loose speck.
  antX: 0.16,
  antY: 0.88,
  antZ: -0.05,
  tipX: 0.2,
  tipY: 1.14,
  lightZ: 0.26,
  lightY: 0.05,
  // The hammer, in the right hand's own frame. The hand bone's own +Y runs back down the
  // forearm, so the shaft is turned through half a circle to stand the head up out of the
  // fist rather than hang it through the floor.
  gripX: 0,
  gripY: -0.04,
  gripZ: 0.02,
  gripRx: 0,
  gripRz: Math.PI,
}

export class Astronauts {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.agents = []
    this.byId = new Map()
    this.capacity = 0
    this.group = new THREE.Group()
    this.group.name = 'astronauts'
    scene.add(this.group)

    this.faceTexture = buildFaceAtlas(Math.min(settings.textureSize, 512))
    this._buildMeshes(Math.max(64, settings.get('maxAgents')))

    // Reusable scratch — allocating inside the frame loop is what makes GC hitch.
    this._m = new THREE.Matrix4()
    this._m2 = new THREE.Matrix4()
    this._m3 = new THREE.Matrix4()
    this._m4 = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._v = new THREE.Vector3()
    this._one = new THREE.Vector3(1, 1, 1)
    this._color = new THREE.Color()
    this._wp = new THREE.Vector3()
    this._sep = new THREE.Vector3()
    this._pickBadge = new THREE.Vector3()
    this._pickLifted = new THREE.Vector3()
    /** Uniform bucket grid for the separation query, so it stays O(n) as the crew grows. */
    this._buckets = new Map()
    this.nav = null
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildMeshes(capacity) {
    this.capacity = capacity
    const parts = (this.parts = {})

    // The suit is painted fabric-over-hardshell: fairly rough, not metallic, but glossy
    // enough on the helmet to catch a highlight off the environment map.
    const suit = (roughness, extra = {}) =>
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0.04, ...extra })

    // Everything worn is measured off the helmet, so the suit stays in proportion if the
    // rig is ever scaled again.
    const R = P.helmetR

    // Helmet shell.
    const helmetGeo = new THREE.SphereGeometry(R, 16, 11)
    parts.helmet = this._mesh(helmetGeo, suit(0.26, { metalness: 0.03, envMapIntensity: 1.35 }), capacity, false)

    // Visor: a dark screen wrapped onto the helmet. The patch itself is a rectangle in UV
    // space, so its rounded silhouette is cut in the fragment shader instead — a squircle
    // SDF, which gives soft corners a rectangular patch can never have, and lets the white
    // helmet show through where the screen ends.
    const visorGeo = sphereCap(R * 1.032, 2.45, Math.PI * 0.62, 20, 14)
    parts.visor = this._mesh(visorGeo, this._visorMaterial(), capacity, false)

    // Backpack + a life-support cylinder on each side.
    const packGeo = roundedBox(R * 0.89, R * 0.98, R * 0.55, R * 0.19)
    parts.pack = this._mesh(packGeo, suit(0.66), capacity, true)

    const antGeo = new THREE.CylinderGeometry(R * 0.042, R * 0.053, R * 0.57, 4)
    antGeo.translate(0, R * 0.285, 0)
    parts.antenna = this._mesh(antGeo, suit(0.24, { metalness: 0.95 }), capacity, false)

    // The blinking bits: antenna tip and chest lamp. Unlit and pushed past 1.0 so they
    // are the things the bloom pass picks out at night.
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true })
    parts.tip = this._mesh(new THREE.SphereGeometry(R * 0.125, 6, 4), glowMat, capacity, false)
    parts.lamp = this._mesh(new THREE.SphereGeometry(R * 0.16, 6, 5), glowMat.clone(), capacity, false)

    // The hammer, held in the right hand while a thread is running. Wood and steel rather
    // than suit white, so it reads as a tool at the distance the colony is watched from.
    parts.hammer = this._mesh(hammerGeometry(R), suit(0.62, { vertexColors: true }), capacity, true)

    // Face: the features only, drawn straight onto the visor beneath. Built as a sphere cap
    // a hair larger than the visor, so it lies exactly on the curved surface instead of
    // clipping through it — a flat plane at this radius sinks inside the sphere and the
    // features disappear.
    const faceGeo = sphereCap(P.helmetR * 1.047, 1.72, 0.98, 16, 10)
    parts.face = this._mesh(faceGeo, this._faceMaterial(), capacity, false)
    this._attachFrameAttribute(parts.face, capacity)

    for (const mesh of Object.values(parts)) {
      mesh.frustumCulled = false // one bounding volume for every agent everywhere is useless
      this.group.add(mesh)
    }
    this._applyShadowFlags()

    // Ground rings for hover + selection. Two ordinary meshes, moved around as needed.
    this.hoverRing = ring(0.42, 0.5, 0x9fd8ff, 0.5)
    this.selectRing = ring(0.5, 0.62, 0xffd28a, 0.9)
    this.hoverRing.visible = false
    this.selectRing.visible = false
    this.group.add(this.hoverRing, this.selectRing)
  }

  /**
   * Hand over the baked crew rig and build the body mesh.
   *
   * Split out from the constructor because the rig is a fetch: the colony is built before
   * boot has finished loading, and until this lands the crew is helmets and backpacks with
   * nothing between them — which is fine, because no agent exists until the first roster
   * arrives, and that comes after.
   */
  setRig(rig) {
    if (!rig || this.rig === rig) return
    this.rig = rig
    this._disposeCrew()

    const geo = rig.geometry.clone()
    const frames = new Float32Array(this.capacity)
    this.crewFrameAttr = new THREE.InstancedBufferAttribute(frames, 1)
    this.crewFrameAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aFrame', this.crewFrameAttr)

    // One uniform block for the surface and the shadow pass, the same as the buildings do.
    this.crewUniforms = {
      uBones: { value: rig.boneTexture },
      uFrameMax: { value: rig.frameCount - 1 },
    }

    const material = decorateSkinned(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.04 }),
      this.crewUniforms
    )

    const mesh = new THREE.InstancedMesh(geo, material, this.capacity)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < this.capacity; i++) mesh.setColorAt(i, white)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

    const depth = decorateSkinned(
      new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
      this.crewUniforms,
      { normals: false }
    )
    mesh.customDepthMaterial = depth

    this.crew = mesh
    this.group.add(mesh)
    this._applyShadowFlags()

    // Bones anything worn hangs off. Read back per frame from the same baked table the
    // shader samples, so a helmet is never a frame out of step with the head under it.
    this.headSlot = rig.attachSlot.get('head') ?? 0
    this.chestSlot = rig.attachSlot.get('chest') ?? 0
    this.handSlot = rig.attachSlot.get('hand.r') ?? 0

    // Where the helmet sits above the ground at rest, in world units. The picker aims here
    // rather than at the feet, so a click lands on the part of an astronaut you are looking
    // at — and reading it off the rig means it follows CREW_SCALE without a second constant.
    const restHeadY = rig.attach[(this.headSlot + 0) * 16 + 13]
    this.headHeight = (restHeadY + P.headUp) * CREW_SCALE
  }

  _disposeCrew() {
    if (!this.crew) return
    this.group.remove(this.crew)
    this.crew.geometry.dispose()
    this.crew.material.dispose()
    this.crew.customDepthMaterial?.dispose()
    this.crew = null
  }

  _mesh(geo, mat, count, castShadow) {
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.castShadow = castShadow
    mesh.receiveShadow = false
    // Force USE_INSTANCING_COLOR on every part so tinting is available without a recompile.
    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < count; i++) mesh.setColorAt(i, white)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    return mesh
  }

  /**
   * The visor. A rounded-rectangle SDF in the patch's own UV space decides what is screen and
   * what is helmet, and a thin band just inside the edge is lifted to read as a bezel.
   */
  _visorMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x08090e, roughness: 0.3, metalness: 0.16 })
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n varying vec2 vVisorUv;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n vVisorUv = uv;`)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n varying vec2 vVisorUv;`)
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           // Rounded-box SDF: |max(q,0)| + min(max(q.x,q.y),0) - r, the standard 2D form.
           vec2 p = ( vVisorUv - 0.5 ) * 2.0;
           // "half" is a reserved word in GLSL ES; a variable named that will not compile.
           vec2 halfSize = vec2( 0.86, 0.80 );
           float radius = 0.52;
           vec2 q = abs( p ) - halfSize + radius;
           float sd = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - radius;
           if ( sd > 0.0 ) discard;
           float bezel = smoothstep( -0.14, -0.01, sd );`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // A cool rim right at the cut, so the screen reads as set into a bezel.
           totalEmissiveRadiance += vec3( 0.16, 0.22, 0.34 ) * bezel;`
        )
    }
    return mat
  }

  /**
   * The face material. The atlas is a mask, so the shader ignores the sampled colour
   * entirely: the red channel becomes *alpha* and the instance's own colour becomes the
   * glow, which is how every astronaut gets a different eye colour from one shared texture.
   *
   * The dark panel behind the features is the *visor*, which is a rounded shape cut by an
   * SDF. This cap used to paint its own dark background as well, and because the cap is a
   * rectangle that second background showed as a rectangle sitting on the rounded one —
   * two panels, the corners of the upper one clipping out of the lower. Carrying alpha in
   * the mask instead means the only thing this draws is the features themselves, so the
   * visor's own silhouette is the only edge there is.
   *
   * `depthWrite` is off because this is transparent now: with it on, the cap would write
   * depth across its whole rectangle and punch a hole in anything drawn behind it later.
   */
  _faceMaterial() {
    const mat = new THREE.MeshBasicMaterial({
      map: this.faceTexture,
      toneMapped: true,
      transparent: true,
      depthWrite: false,
    })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFrameScale = { value: new THREE.Vector2(1 / FRAME_COLS, 1 / FRAME_ROWS) }
      shader.uniforms.uGlow = { value: 1.85 }
      this._faceUniforms = shader.uniforms

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aFrame;
           uniform vec2 uFrameScale;`
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           vMapUv = uv * uFrameScale + aFrame;`
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlow;`
        )
        .replace(
          '#include <map_fragment>',
          `float mask = texture2D( map, vMapUv ).r;
           // The mask is drawn from paths, so its edges are already antialiased — taking
           // alpha straight from it is what gives the features soft edges against the
           // helmet without a single extra sample.
           diffuseColor.rgb = vColor.rgb * uGlow;
           diffuseColor.a = mask;`
        )
        // vColor is the glow source above, so the usual instance-colour multiply must go.
        .replace('#include <color_fragment>', '')
    }
    return mat
  }

  _attachFrameAttribute(mesh, capacity) {
    const data = new Float32Array(capacity * 2)
    const attr = new THREE.InstancedBufferAttribute(data, 2)
    attr.setUsage(THREE.DynamicDrawUsage)
    mesh.geometry.setAttribute('aFrame', attr)
    this.frameAttr = attr
  }

  _applyShadowFlags() {
    const on = this.settings.shadowSize > 0
    for (const [name, mesh] of Object.entries(this.parts)) {
      const wants = name !== 'face' && name !== 'tip' && name !== 'lamp' && name !== 'visor'
      mesh.castShadow = on && wants
    }
    // The body is the shadow that matters — it is the whole silhouette.
    if (this.crew) this.crew.castShadow = on
  }

  /** The colony hands over the navigation grid once it has been built. */
  setNavigation(nav) {
    this.nav = nav
  }

  onSettingsChanged(changed) {
    if (changed.has('shadows')) this._applyShadowFlags()
    if (changed.has('textureQuality')) {
      this.faceTexture.dispose()
      this.faceTexture = buildFaceAtlas(Math.min(this.settings.textureSize, 512))
      this.parts.face.material.map = this.faceTexture
      this.parts.face.material.needsUpdate = true
    }
    if (changed.has('maxAgents')) {
      // The instanced buffers are sized at build time, so a bigger roster needs new ones.
      const wanted = Math.max(64, this.settings.get('maxAgents'))
      if (wanted !== this.capacity) {
        const rig = this.rig
        this._disposeCrew()
        for (const mesh of Object.values(this.parts)) {
          this.group.remove(mesh)
          mesh.geometry.dispose()
          mesh.material.dispose()
        }
        this.group.remove(this.hoverRing, this.selectRing)
        this._buildMeshes(wanted)
        this.rig = null
        this.setRig(rig)
        for (const agent of this.agents) {
          agent.index = -1
          agent.colorDirty = true
        }
      }
      this.roster && this.setRoster(this.roster)
    }
  }

  // ── roster ──────────────────────────────────────────────────────────────────────────

  /**
   * Reconcile the live agents against the current thread list: spawn newcomers at the ship,
   * update the ones that are still here, and send anything that vanished home rather than
   * deleting it out from under the player.
   */
  setRoster(entries, world) {
    this.roster = entries
    this.world = world || this.world
    const cap = Math.min(this.capacity, this.settings.get('maxAgents'))
    // Agents on their way back to the ship still hold a slot, so the roster has to leave room
    // for them. Without this the clamp above would quietly drop whoever sorted last, which is
    // better than an empty planet but still not what the scan said.
    const leaving = this.agents.reduce((n, a) => n + (a.state === 'leaving' ? 1 : 0), 0)
    const wanted = entries.slice(0, Math.max(1, cap - leaving))
    const seen = new Set()

    // The ramp is one door and the ship is a solid obstacle around it, so an entrance is a
    // queue. A handful arriving together is the shot the colony is for; a hundred is a scrum
    // that shoves its own members into the ship's footprint, where they give up, sit down and
    // become the obstacle for everybody behind them. Past this many, the rest are simply
    // already outside — which is what a thread the colony has seen before is anyway.
    let entrances = MAX_ENTRANCE
    for (const entry of wanted) {
      seen.add(entry.id)
      const existing = this.byId.get(entry.id)
      if (existing) {
        this._updateAgent(existing, entry)
        continue
      }
      const walksOut = !entry.known && entrances > 0
      if (walksOut) entrances--
      this._spawnAgent(entry, walksOut)
    }

    for (const agent of this.agents) {
      if (!seen.has(agent.id) && agent.state !== 'leaving') this._sendHome(agent)
    }
    return this.agents.length
  }

  _spawnAgent(entry, walksOut = true) {
    const door = this.world?.shipDoor?.() || new THREE.Vector3(0, 0, 0)
    const jitter = () => (Math.random() - 0.5) * 1.4
    // Straight onto its plot, a pace off the exact spot so a zone's crew does not appear in a
    // stack. The nav grid sorts out anything that lands on a building.
    const site = entry.site || door
    const start = walksOut
      ? new THREE.Vector3(door.x + jitter(), 0, door.z + jitter())
      : new THREE.Vector3(site.x + jitter(), 0, site.z + jitter())

    // Everything an astronaut is born as comes out of one hash of its id, each trait from
    // its own bit window so no trait is welded to another.
    const h = hash(entry.id)
    const species = SPECIES[speciesFor(h)]
    const suit = SUIT_TONES[(h >>> 3) % SUIT_TONES.length]

    const agent = {
      id: entry.id,
      thread: entry.thread,
      status: entry.status,
      site: entry.site ? entry.site.clone() : new THREE.Vector3(),
      // The thing being worked on, and where round it this astronaut is standing to do it.
      anchor: entry.anchor ? entry.anchor.clone() : null,
      workSpot: new THREE.Vector3(),
      workAt: 0,
      pos: start,
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      targetYaw: 0,
      speed: WALK_SPEED * (0.86 + Math.random() * 0.28),
      phase: Math.random() * Math.PI * 2,
      bob: 0,
      // An astronaut already outside does not play the entrance; it is just there.
      state: walksOut ? 'spawning' : 'walking',
      stateAge: 0,
      // Every astronaut runs its own clocks so a crowd never blinks in unison.
      blinkAt: 1 + Math.random() * 4,
      faceFrame: FACE.boot,
      faceTimer: 0,
      faceIndex: 0,
      // The helmet keeps the colony's suit palette for every species — the crew reads as
      // one crew that way — while the body carries the skin, so an alien is a coloured
      // figure inside standard-issue kit rather than a differently painted astronaut.
      suit,
      skin: species.tones ? species.tones[(h >>> 7) % species.tones.length] : suit,
      // Species stature plus a little personal jitter, so a species is a range, not a rank.
      height: species.height + (((h >>> 9) % 7) - 3) * 0.01,
      // Which four-row block of the face atlas this astronaut's expressions come from.
      faceBase: species.faceLayout * FACE_COUNT,
      eye: new THREE.Color(1, 1, 1),
      trim: new THREE.Color(0xffffff),
      hop: 0,
      // Ground tracking. `groundAt` is the height last sampled and `groundY` the eased value
      // actually stood on; both start null so the first frame snaps instead of easing up.
      groundAt: null,
      groundY: null,
      groundX: 0,
      groundZ: 0,
      /** Distance actually covered per second, damped — what picks the animation clip. */
      groundSpeed: 0,
      /** Set by `_walk` on a refused step; latched per wander leg as `driftBlocked`. */
      blocked: false,
      driftBlocked: false,
      // Animation state: which baked clip, how far into it, and the row of the bone table
      // that lands on. Started at a random offset so a crowd never marches in step.
      clipKey: walksOut ? 'spawn' : 'idle',
      clipTime: Math.random() * 0.6,
      frame: 0,
      wander: new THREE.Vector3(),
      wanderAt: 0,
      scale: walksOut ? 0 : 1, // pops up out of the ship, or was already standing there
      alive: true,
      path: null,
      pathAt: 0,
      pathVersion: -1,
      pathGoal: new THREE.Vector3(NaN, 0, NaN),
      colorDirty: true,
      index: -1,
      walkAmp: 0,
      screen: new THREE.Vector3(), // filled by the picker each frame
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
      // A site that has moved is a site to walk to. This matters most for an astronaut that
      // gave up on an unreachable one and adopted the ground it was standing on: the next
      // scan hands the real site back, and without this it would stand there for good,
      // parked in the middle of somebody else's zone.
      const away = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z)
      if (moved && agent.state === 'at-site' && away > ARRIVE_RADIUS) {
        agent.state = 'walking'
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

  /** Status change → new behaviour, new trim, new eye colour. */
  _applyStatus(agent, status) {
    const look = AGENT_LOOK[status] || AGENT_LOOK.idle
    agent.trim.set(look.trim)
    agent.eye.setRGB(look.eye[0], look.eye[1], look.eye[2])
    agent.loop = FACE_LOOPS[status] || null
    agent.colorDirty = true

    if (status === 'leaving') {
      this._sendHome(agent)
      return
    }
    // A spawning agent keeps walking out of the ship; everyone else re-targets at once.
    if (agent.state !== 'spawning') agent.state = 'walking'
    agent.stateAge = 0
    agent.pathVersion = -1
  }

  /** Close enough to the ramp that standing still there is in somebody's way. */
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
    const door = this.world?.shipDoor?.()
    if (door) agent.site.copy(door)
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
      this._animate(agent, dt, anim)
      this._face(agent, dt)

      if (agent.state === 'gone') {
        this.agents.splice(i, 1)
        this.byId.delete(agent.id)
        continue
      }
      write++
    }

    this._writeMatrices(elapsed, anim)
    return write
  }

  /**
   * Make sure the agent has a usable route, and hand back the point it should steer at.
   * Falls back to the goal itself when there is no path — an astronaut heading vaguely the
   * right way and sliding along walls beats one standing still because A* gave up.
   */
  _steerTarget(agent, out) {
    const nav = this.nav
    if (!nav) return out.copy(agent.site)

    const stale =
      agent.pathVersion !== nav.version ||
      agent.pathGoal.distanceToSquared(agent.site) > 0.25
    if (stale && this._routeBudget > 0) {
      this._routeBudget--
      agent.path = nav.findPath(agent.pos.x, agent.pos.z, agent.site.x, agent.site.z)
      agent.pathAt = 0
      agent.pathVersion = nav.version
      agent.pathGoal.copy(agent.site)
    }

    const path = agent.path
    if (!path || !path.length) return out.copy(agent.site)

    // Retire waypoints already reached, and any the agent can already see past.
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
    agent.blocked = false
    // Distance is always measured to the real goal; steering follows the route to it.
    const steer = this._steerTarget(agent, this._wp)
    const toSite = this._v.set(steer.x - agent.pos.x, 0, steer.z - agent.pos.z)
    const dist = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z)

    switch (agent.state) {
      case 'spawning': {
        agent.scale = Math.min(1, agent.scale + dt * 2.6)
        if (agent.stateAge > 0.9) agent.state = 'walking'
        this._walk(agent, toSite, dist, dt, 0.55)
        break
      }

      case 'walking': {
        agent.scale = Math.min(1, agent.scale + dt * 3)
        this._walk(agent, toSite, dist, dt, 1)
        // Close enough — settle into whatever this thread is actually doing. Or close
        // enough to *give up*: a site that something was built on top of between polls can
        // never be reached, and an astronaut shouldering a wall forever is worse than one
        // standing a little short of where it meant to be. It adopts the spot it got to,
        // and the next poll hands it a site that has been checked against the grid.
        const stuck = (agent.blocked && agent.stateAge > 8) || agent.stateAge > 45
        if (dist < ARRIVE_RADIUS || stuck) {
          // Adopting the ground it reached is right for a site something got built on top of.
          // It is exactly wrong next to the ship: an astronaut still shouldering its way out
          // of the doorway would claim the doorway, and the queue behind it inherits a
          // permanent wall. Out there it keeps its real site and tries again, which the crowd
          // thinning out is usually enough to fix.
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
        if (agent.status === 'idle') {
          // Idlers potter around their plot, and `_drift` owns their velocity outright.
          this._drift(agent, dt, elapsed)
        } else if (agent.status === 'working' && agent.anchor) {
          this._workRound(agent, dt, elapsed)
        } else {
          // Everybody else has arrived and stays: a thread that has gone quiet has sat down
          // on the floor, one that is working is at its building. Velocity is zeroed rather
          // than eased down, because nothing here moves the agent any more — a decaying
          // velocity is a number only the animation reads, and what it says is "still
          // walking" for a third of a second after the astronaut has visibly stopped.
          agent.vel.set(0, 0, 0)
          if (agent.status !== 'sleeping') this._faceToward(agent, agent.site, dt)
          this._settle(agent, dt)
        }
        this._sitePose(agent, dt, elapsed, anim)
        break
      }

      case 'leaving': {
        agent.scale = Math.max(0, agent.scale - (dist < 1.4 ? dt * 2.2 : 0))
        this._walk(agent, toSite, dist, dt, 1.15)
        // Reaching the ramp retires the agent; so does giving up on ever reaching it, so a
        // blocked path can never leave a ghost walking forever.
        if (agent.scale <= 0.001 || (dist < 0.9 && agent.stateAge > 1.5) || agent.stateAge > 22) {
          agent.state = 'gone'
        }
        break
      }
    }

    // How fast the astronaut *actually* travelled, not how fast it meant to. The two come
    // apart whenever something is in the way: velocity stays high while the collision code
    // refuses the step, and an agent driven off intent alone walks on the spot against a
    // wall.
    const moved = Math.hypot(agent.pos.x - fromX, agent.pos.z - fromZ) / Math.max(dt, 1e-4)
    // Asymmetric on purpose. Setting off is picked up on the very frame it happens, so an
    // astronaut is never sliding in a standing pose; stopping decays over a tenth of a
    // second, which both stops a half-blocked step flickering the clip and lets the walk
    // cycle finish its stride instead of freezing mid-step.
    agent.groundSpeed =
      moved > agent.groundSpeed ? moved : THREE.MathUtils.damp(agent.groundSpeed || 0, moved, 20, dt)
    agent.phase += dt * (2.2 + agent.groundSpeed * 3.4) * anim
    agent.walkAmp = THREE.MathUtils.damp(agent.walkAmp || 0, Math.min(1, agent.groundSpeed / WALK_SPEED), 8, dt)

    agent.yaw = angleDamp(agent.yaw, agent.targetYaw, TURN_RATE, dt)

    // Stand on the ground rather than on y=0. A plot's deck is a raised slab and the terrain
    // between plots rolls by half a metre either way, so a crew pinned to zero is buried for
    // half the colony. Sampled only when the agent has actually moved — most of the crew is
    // parked at its site, and the sample is a hex lookup plus a noise evaluation.
    const ground = this.world?.groundAt
    if (ground) {
      if (agent.groundAt === null || Math.abs(agent.pos.x - agent.groundX) + Math.abs(agent.pos.z - agent.groundZ) > 0.2) {
        agent.groundX = agent.pos.x
        agent.groundZ = agent.pos.z
        agent.groundAt = ground(agent.pos.x, agent.pos.z)
      }
      // Eased, so walking up onto a deck is a step rather than a teleport. Snapped outright
      // on the first frame, or a spawning astronaut rises out of the floor.
      agent.groundY =
        agent.groundY === null ? agent.groundAt : THREE.MathUtils.damp(agent.groundY, agent.groundAt, 14, dt)
    }
    agent.pos.y = (agent.groundY || 0) + agent.hop
  }

  /**
   * `toTarget` points at the next waypoint; `goalDist` is how far the *final* goal still is.
   * Slowing down uses the goal so an astronaut cruises through intermediate corners and only
   * eases as it actually arrives.
   */
  _walk(agent, toTarget, goalDist, dt, factor) {
    const legDist = toTarget.length()
    if (legDist > 0.05) {
      const dir = toTarget.divideScalar(legDist)
      const want = agent.speed * factor * Math.min(1, goalDist / 1.8)
      agent.vel.x = THREE.MathUtils.damp(agent.vel.x, dir.x * want, 6, dt)
      agent.vel.z = THREE.MathUtils.damp(agent.vel.z, dir.z * want, 6, dt)
    }

    const push = this._separation(agent, this._sep)
    const dx = (agent.vel.x + push.x) * dt
    const dz = (agent.vel.z + push.z) * dt

    if (this.nav) {
      // Blocked head-on, the agent slides; a route that has gone stale can never become a
      // walk through a wall.
      if (!this.nav.slide(agent.pos, dx, dz)) {
        agent.vel.multiplyScalar(0.4)
        // Wedged against something the path did not know about — ask for a new one.
        agent.pathVersion = -1
        agent.blocked = true
      }
    } else {
      agent.pos.x += dx
      agent.pos.z += dz
    }

    if (Math.hypot(agent.vel.x, agent.vel.z) > 0.05) {
      agent.targetYaw = Math.atan2(agent.vel.x, agent.vel.z)
    }
  }

  /** Bucket every agent by a coarse cell, so separation only ever looks at real neighbours. */
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

  /** A soft shove away from anyone standing too close. */
  /** Is anybody already standing here? Same bucket grid the separation query walks. */
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
    const buckets = this._buckets
    const bx = (agent.pos.x / 2) | 0
    const bz = (agent.pos.z / 2) | 0
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = buckets.get((bx + ox) * 10007 + (bz + oz))
        if (!list) continue
        for (const other of list) {
          if (other === agent) continue
          const dx = agent.pos.x - other.pos.x
          const dz = agent.pos.z - other.pos.z
          const d2 = dx * dx + dz * dz
          if (d2 > SEPARATION * SEPARATION || d2 < 1e-6) continue
          const d = Math.sqrt(d2)
          // Two regimes, because one is not enough. The gentle term ramps up as they close
          // so a crowd settles instead of oscillating — but in a press, half a dozen gentle
          // pushes from every side cancel, and the equilibrium lands *inside* helmet width.
          // So there is a second, much firmer term that only exists at touching distance,
          // where being apart stops being cosmetic. Widening the gentle radius does not fix
          // that; it makes it worse, by adding more pushes to cancel.
          const strength = (1 - d / SEPARATION) * 1.2 + (d < CONTACT ? (1 - d / CONTACT) * 5 : 0)
          out.x += (dx / d) * strength
          out.z += (dz / d) * strength
        }
      }
    }
    return out
  }

  /** A slow wander inside the plot, re-targeted every few seconds. */
  _drift(agent, dt, elapsed) {
    if (elapsed > agent.wanderAt) {
      agent.wanderAt = elapsed + 3 + Math.random() * 5
      // Stay put rather than walk at a wall — or at somebody. A few candidates and the
      // first that is neither inside a building nor on top of a neighbour wins: separation
      // can push a crowd apart, but it cannot stop one forming if everybody keeps choosing
      // to walk into the same patch of ground.
      agent.wander.copy(agent.site)
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2
        const r = 0.8 + Math.random() * 2
        const wx = agent.site.x + Math.cos(a) * r
        const wz = agent.site.z + Math.sin(a) * r
        if (this.nav?.isBlocked(wx, wz)) continue
        if (this._crowded(wx, wz, agent)) continue
        agent.wander.set(wx, 0, wz)
        break
      }
      agent.driftBlocked = false
    }
    const to = this._v.set(agent.wander.x - agent.pos.x, 0, agent.wander.z - agent.pos.z)
    const d = to.length()
    if (d > DRIFT_ARRIVE && !agent.driftBlocked) {
      this._walk(agent, to, d, dt, DRIFT_PACE)
      // A drift leg is a straight line at a spot only ever checked for being *inside* a
      // wall, never for being reachable — so it can run into the side of a building.
      // Give the leg up at the first refused step rather than shuffling against the wall
      // until the next wander comes due, which is several seconds of walking on the spot.
      if (agent.blocked) agent.driftBlocked = true
      return
    }
    // Arrived — or the spot was never far enough away to be worth crossing. Stop dead
    // rather than easing down through the speeds no standing clip can carry, and hold
    // still until the next wander is due, only yielding to anyone standing inside us.
    agent.vel.set(0, 0, 0)
    this._settle(agent, dt)
  }

  /**
   * Push a seated agent out of anyone it has ended up inside, and do nothing else.
   *
   * Separation on its own converges: once no neighbour is within the radius the push is
   * zero and the agent is still. That is the whole difference between resolving a pile-up
   * and wandering. The push is applied to position only, never to velocity, so a nudged
   * sleeper does not read as walking and stays in its sitting clip.
   */
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

  /**
   * Working: walk round the building and hammer at it from a different side every so often.
   *
   * A thread that is running is *doing* something, and an astronaut welded to one spot for
   * an hour does not say that. Spots are picked on the ring the roster put it on, so it
   * never wanders off its own site, and it always turns to face the thing it is hitting.
   */
  _workRound(agent, dt, elapsed) {
    if (elapsed > agent.workAt) {
      agent.workAt = elapsed + 5 + Math.random() * 7
      const radius = Math.max(1.6, Math.hypot(agent.site.x - agent.anchor.x, agent.site.z - agent.anchor.z))
      // Somewhere else on the ring — at least a third of the way round, so a move is worth
      // making rather than a shuffle on the spot.
      const from = Math.atan2(agent.pos.z - agent.anchor.z, agent.pos.x - agent.anchor.x)
      agent.workSpot.copy(agent.site)
      // Same rule as a drift: a spot on the ring that is walled off, or that somebody else
      // is already working from, is not a spot.
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
      this._walk(agent, to, d, dt, DRIFT_PACE)
      if (agent.blocked) agent.driftBlocked = true
      return
    }
    // Arrived: stop dead, turn to the work, and swing.
    agent.vel.set(0, 0, 0)
    this._faceToward(agent, agent.anchor, dt)
    this._settle(agent, dt)
  }

  _faceToward(agent, point, dt) {
    // Stand a little back from the build site and look at it.
    const dx = point.x - agent.pos.x
    const dz = point.z - agent.pos.z
    if (Math.abs(dx) + Math.abs(dz) > 0.01) agent.targetYaw = Math.atan2(dx, dz)
  }

  /**
   * What each status adds on top of its clip, once the agent has arrived.
   *
   * Vertical motion used to live here — a hop for celebrating, a slump for blocked. The
   * clips own all of that now, and a hand-written offset on top of an authored one only
   * ever fights it, so the only thing left is the slow turn a celebrating agent does on
   * the spot, which no single clip can express.
   */
  _sitePose(agent, dt, elapsed, anim) {
    agent.hop = 0
    if (agent.status === 'celebrating') agent.targetYaw += dt * 1.4 * anim
  }

  /** Pick this frame's face: a status loop, interrupted by the agent's own blink clock. */
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
    // Blink beats everything except sleeping — a sleeping agent's eyes are already shut.
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

  // ── animation ───────────────────────────────────────────────────────────────────────

  /**
   * Choose the clip an agent should be playing and advance its clock.
   *
   * Locomotion wins over status: an idler pottering across its plot walks, it does not
   * hammer while sliding. Walk playback is driven by actual ground speed so short steps
   * cannot moonwalk — the same rule the old hand-written cycle followed, applied to a real
   * one instead.
   */
  _animate(agent, dt, anim) {
    const rig = this.rig
    if (!rig) return

    // Any real translation belongs in a walk clip. The threshold is low on purpose: what it
    // guards against is the reverse mistake, an agent standing in an idle pose while the
    // world slides past its feet, and the movement code is what keeps it from dawdling
    // just under the line.
    const speed = agent.groundSpeed || 0
    let key
    if (agent.state === 'spawning') key = 'spawn'
    else if (speed > 0.12) key = speed > WALK_SPEED * 1.25 ? 'run' : 'walk'
    else {
      switch (agent.status) {
        case 'working':
          key = 'work'
          break
        case 'waiting':
          key = 'wave'
          break
        case 'blocked':
          key = 'hit'
          break
        case 'celebrating':
          key = 'cheer'
          break
        // Sitting down is a one-shot that hands over to the loop when it finishes, so an
        // agent that has just nodded off lowers itself rather than snapping into a sit.
        case 'sleeping':
          key = agent.clipKey === 'sit' ? 'sit' : 'sitDown'
          break
        default:
          key = 'idle'
      }
    }

    if (key !== agent.clipKey) {
      agent.clipKey = key
      agent.clipTime = 0
    }

    const clip = rig.clips[key] || rig.clips.idle
    if (!clip) return

    // Stride rate follows the ground, everything else runs at its authored speed.
    const rate = key === 'walk' || key === 'run' ? THREE.MathUtils.clamp(speed / WALK_SPEED, 0.4, 2.1) : 1
    agent.clipTime += dt * anim * rate

    if (key === 'sitDown' && agent.clipTime >= clip.duration) {
      agent.clipKey = 'sit'
      agent.clipTime = 0
      agent.frame = frameFor(rig.clips.sit, 0)
      return
    }
    agent.frame = frameFor(clip, agent.clipTime)
  }

  // ── writing the instance buffers ────────────────────────────────────────────────────

  _writeMatrices(elapsed, anim) {
    const { helmet, visor, pack, antenna, tip, lamp, face, hammer } = this.parts
    const rig = this.rig
    const crew = this.crew
    const root = this._m
    const child = this._m2
    const bone = this._m3
    const worn = this._m4
    const q = this._q
    const e = this._e
    const v = this._v
    const one = this._one
    const frames = this.frameAttr.array
    const crewFrames = this.crewFrameAttr?.array

    let i = 0
    let hands = 0
    let staticDirty = false
    for (const agent of this.agents) {
      // Never write past the end of the instance buffers. Going over is not a rendering
      // artefact you can squint past: WebGL refuses the whole `drawElementsInstanced` call, so
      // one agent too many takes *every* astronaut off screen at once.
      //
      // It can go over. `setRoster` caps how many agents it will spawn, but an agent that has
      // left the roster stays in this list while it walks back to the ship — and the slot it
      // vacated in the roster is immediately filled by a thread that was previously past the
      // cap. Archive one thread on a colony sitting at the cap and there is briefly one more
      // agent than there are slots, which is exactly when the colony would empty.
      if (i >= this.capacity) break
      if (agent.state === 'gone') continue
      const s = agent.scale
      if (s <= 0.001) continue

      // Root transform for the whole character. The rig is authored at 2.2 units tall, so
      // CREW_SCALE rides along here and everything downstream inherits it — including the
      // species height, which is why a tall astronaut's helmet fits without a second knob.
      e.set(0, agent.yaw, 0)
      q.setFromEuler(e)
      v.set(agent.pos.x, agent.pos.y, agent.pos.z)
      root.compose(v, q, one.setScalar(s * CREW_SCALE * agent.height))
      one.setScalar(1)

      if (crew) {
        crew.setMatrixAt(i, root)
        crewFrames[i] = agent.frame
      }

      // Everything worn hangs off a bone at the frame the body is actually on, so a helmet
      // cannot drift off a head that is looking down or lying on the ground.
      if (rig) {
        attachMatrixAt(rig, agent.frame, this.headSlot, bone)
        worn.multiplyMatrices(root, bone)
        setPart(child, worn, helmet, i, 0, P.headUp, 0, 0, 0, 0)
        setPart(child, worn, visor, i, 0, P.headUp, 0, 0, 0, 0)
        setPart(child, worn, face, i, 0, P.headUp, 0, 0, 0, 0)
        setPart(child, worn, antenna, i, P.antX, P.antY, P.antZ, 0.06, 0, -0.12)
        setPart(child, worn, tip, i, P.tipX, P.tipY, P.antZ, 0, 0, 0)

        attachMatrixAt(rig, agent.frame, this.chestSlot, bone)
        worn.multiplyMatrices(root, bone)
        setPart(child, worn, pack, i, 0, P.packUp, P.packZ, 0, 0, 0)
        setPart(child, worn, lamp, i, 0, P.lightY, P.lightZ, 0, 0, 0)

        // The hammer only exists while a thread is running, so it gets its own instance
        // counter — an unused slot in the middle of an instanced mesh still draws.
        if (agent.clipKey === 'work') {
          attachMatrixAt(rig, agent.frame, this.handSlot, bone)
          worn.multiplyMatrices(root, bone)
          setPart(child, worn, hammer, hands++, P.gripX, P.gripY, P.gripZ, P.gripRx, 0, P.gripRz)
        }
      }

      // Suit and trim only change when the status does, or when an agent leaving the roster
      // shuffles everyone's slot along — so they are written on those frames, not all of them.
      const c = this._color
      if (agent.index !== i || agent.colorDirty) {
        agent.colorDirty = false
        crew?.setColorAt(i, c.setHex(agent.skin))
        helmet.setColorAt(i, c.setHex(agent.suit))
        pack.setColorAt(i, agent.trim)
        face.setColorAt(i, agent.eye)
        staticDirty = true
      }

      // Antenna tip and chest lamp pulse; a blocked agent's lamp stutters like a fault light.
      const pulse =
        agent.status === 'blocked'
          ? (Math.sin(elapsed * 9) > 0.2 ? 1 : 0.05)
          : 0.55 + 0.45 * Math.sin(elapsed * 2.6 + agent.phase)
      tip.setColorAt(i, c.copy(agent.eye).multiplyScalar(0.6 + pulse * 1.1))
      lamp.setColorAt(i, c.copy(agent.trim).multiplyScalar(0.7 + pulse * 1.6))

      // Atlas frame for the face — the expression, shifted into this species' row block.
      const f = agent.faceFrame + agent.faceBase
      frames[i * 2] = (f % FRAME_COLS) / FRAME_COLS
      frames[i * 2 + 1] = 1 - (Math.floor(f / FRAME_COLS) + 1) / FRAME_ROWS

      agent.index = i
      i++
    }

    const n = i
    // The glowing parts pulse every frame; the rest only re-upload when something moved slot.
    const animated = new Set(['tip', 'lamp'])
    for (const [name, mesh] of Object.entries(this.parts)) {
      mesh.count = name === 'hammer' ? hands : n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor && (staticDirty || animated.has(name))) mesh.instanceColor.needsUpdate = true
    }
    if (crew) {
      crew.count = n
      crew.instanceMatrix.needsUpdate = true
      this.crewFrameAttr.needsUpdate = true
      if (staticDirty && crew.instanceColor) crew.instanceColor.needsUpdate = true
    }
    this.frameAttr.needsUpdate = true
    this.visibleCount = n
  }

  // ── picking ─────────────────────────────────────────────────────────────────────────

  /**
   * Nearest agent to a screen point, in screen space. Cheaper than raycasting ten instanced
   * meshes and far kinder to click, since the hit radius grows with how big the astronaut
   * actually is on screen rather than with its silhouette.
   */
  pick(camera, ndcX, ndcY, aspect, maxDist = 0.075) {
    let best = null
    let bestScore = Infinity
    const v = this._v
    const b = this._pickBadge
    const lifted = this._pickLifted

    for (const agent of this.agents) {
      if (agent.scale < 0.3 || agent.state === 'gone') continue
      // The species height scales the whole rig, head included — without it here a click
      // aimed at a tall astronaut's helmet lands over a short one's shoulder.
      v.set(agent.pos.x, agent.pos.y + (this.headHeight || 0.75) * agent.height, agent.pos.z).project(camera)
      if (v.z > 1) continue // behind the camera
      agent.screen.copy(v)
      const dx = (v.x - ndcX) * aspect
      const dy = v.y - ndcY
      let d = Math.hypot(dx, dy)

      // The badge over an astronaut's head is what you actually aim at when one wants you —
      // it is bigger than the astronaut, it is the thing that caught your eye, and it sits
      // clear of the crowd. So the whole bubble picks the astronaut it belongs to, not just
      // a point at its middle.
      //
      // The geometry has to be recomputed the way `indicators.js` draws it rather than
      // guessed at. That shader anchors the quad just above the helmet and then lifts it by
      // half its own height *in view space*, where the height itself grows with distance so
      // the badge holds a constant pixel size. A fixed world-space offset cannot follow that:
      // it is right at one zoom and most of a metre low at another, which is why this used to
      // demand a click on the astronaut's head.
      const size = agent.badgeSize || 0
      if (size > 0) {
        // View space, exactly as the vertex shader has it.
        b.set(agent.pos.x, agent.badgeY, agent.pos.z).applyMatrix4(camera.matrixWorldInverse)
        const scale = size * (2 + -b.z * 0.22)
        b.y += scale * 0.5
        // A second point one half-height higher gives the quad's on-screen radius without
        // re-deriving the projection: whatever the camera does to one, it does to both.
        lifted.copy(b)
        lifted.y += scale * 0.5
        b.applyMatrix4(camera.projectionMatrix)
        lifted.applyMatrix4(camera.projectionMatrix)
        if (b.z <= 1) {
          // The quad is square, and `bx` is already in the same units as `by`, so one
          // half-extent covers both axes.
          const half = Math.abs(lifted.y - b.y)
          const bx = (b.x - ndcX) * aspect
          const by = b.y - ndcY
          // Anywhere inside the bubble is a hit outright; outside it, the distance to its
          // edge, so a near-miss still competes with a nearer astronaut on the same pixel.
          const ox = Math.max(0, Math.abs(bx) - half)
          const oy = Math.max(0, Math.abs(by) - half)
          const bd = Math.hypot(ox, oy)
          if (bd < d) d = bd
        }
      }
      if (d > maxDist) continue
      // Break ties by depth so the nearer of two overlapping agents wins.
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
    if (agent) this.hoverRing.position.set(agent.pos.x, agent.pos.y + 0.03, agent.pos.z)
  }

  setSelected(agent) {
    this.selected = agent || null
    this.selectRing.visible = Boolean(agent)
  }

  updateRings(elapsed) {
    if (this.selected) {
      if (!this.byId.has(this.selected.id)) {
        this.setSelected(null)
      } else {
        const a = this.selected
        this.selectRing.position.set(a.pos.x, a.pos.y + 0.035, a.pos.z)
        this.selectRing.rotation.y = elapsed * 0.6
        const s = 1 + Math.sin(elapsed * 3) * 0.05
        this.selectRing.scale.setScalar(s)
      }
    }
    if (this.hoverRing.visible) this.hoverRing.rotation.y = -elapsed * 0.4
  }

  /** A quick wave — played when you open an agent's thread. */
  celebrate(id) {
    const agent = this.byId.get(id)
    if (!agent) return
    agent.faceFrame = FACE.happy
    agent.blinkAt = 1.5
    agent.hop = 0.25
  }

  dispose() {
    for (const mesh of Object.values(this.parts)) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    this._disposeCrew()
    // The bone texture is the rig's, not this instance's — the rig outlives any one colony.
    this.faceTexture.dispose()
    this.scene.remove(this.group)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

const _cq = new THREE.Quaternion()
const _ce = new THREE.Euler()
const _cv = new THREE.Vector3()
const _cs = new THREE.Vector3(1, 1, 1)

/** Compose a child's local transform, concatenate onto the root, and store the instance. */
function setPart(scratch, root, mesh, index, x, y, z, rx, ry, rz) {
  _ce.set(rx, ry, rz)
  _cq.setFromEuler(_ce)
  _cv.set(x, y, z)
  scratch.compose(_cv, _cq, _cs)
  scratch.premultiply(root)
  mesh.setMatrixAt(index, scratch)
}

function angleDamp(current, target, lambda, dt) {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * (1 - Math.exp(-lambda * dt))
}

/** A cheap rounded box: a low-segment sphere squashed to the requested proportions. */
/**
 * A claw hammer, in the rig's own units: a shaft with a steel head across the top.
 *
 * Coloured per vertex rather than per instance, because the two halves are different
 * materials and the instance colour is already spoken for by the suit palette.
 */
function hammerGeometry(R) {
  const shaft = new THREE.CylinderGeometry(R * 0.055, R * 0.07, R * 1.15, 6)
  shaft.translate(0, R * 0.24, 0)
  paint(shaft, 0x8a6440)

  // The head crosses the shaft. It is authored long along X, which is already square to the
  // shaft's Y — turning it a quarter turn about Z, as this used to, stood the head *up in
  // line with* the handle, so the astronaut appeared to be swinging a mallet end-on.
  const head = roundedBox(R * 0.5, R * 0.19, R * 0.19, R * 0.05)
  head.translate(0, R * 0.82, 0)
  paint(head, 0x9aa0a8)

  const merged = BufferGeometryUtils.mergeGeometries([shaft, head], false)
  shaft.dispose()
  head.dispose()
  return merged
}

/** Bake a flat colour into a geometry's vertex colours. */
function paint(geo, hex) {
  const c = new THREE.Color(hex)
  const n = geo.attributes.position.count
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

function roundedBox(w, h, d, r) {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2)
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  const half = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const inner = new THREE.Vector3(
      THREE.MathUtils.clamp(v.x, -half.x, half.x),
      THREE.MathUtils.clamp(v.y, -half.y, half.y),
      THREE.MathUtils.clamp(v.z, -half.z, half.z)
    )
    const out = v.clone().sub(inner)
    if (out.lengthSq() > 0) out.setLength(r)
    pos.setXYZ(i, inner.x + out.x, inner.y + out.y, inner.z + out.z)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/**
 * A patch of sphere centred on +Z — the direction the astronaut faces. Three's own
 * parametrisation puts phi=0 at -X, so the patch is offset by a quarter turn to land
 * the cap on the front of the helmet rather than its cheek.
 */
function sphereCap(radius, phiSpread, thetaSpread, wSeg = 18, hSeg = 12) {
  return new THREE.SphereGeometry(
    radius,
    wSeg,
    hSeg,
    Math.PI / 2 - phiSpread / 2,
    phiSpread,
    Math.PI / 2 - thetaSpread / 2,
    thetaSpread
  )
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

