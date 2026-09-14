import * as THREE from 'three'

/**
 * Subagent Drones
 *
 * Miniaturized orbital drones that hover and circle around astronauts whenever
 * a background task or subagent (e.g. Antigravity subagent or Claude Code subagent)
 * is running.
 *
 * Designed with Three.js InstancedMesh for extreme efficiency:
 * - Instanced glowing orb core
 * - Instanced gyroscopic halo ring
 * - Instanced downward holographic scanning beam
 * Zero garbage allocation during render frames.
 */

const MAX_DRONES = 64
const DUMMY = new THREE.Object3D()
const RING_DUMMY = new THREE.Object3D()
const BEAM_DUMMY = new THREE.Object3D()

export class SubagentDrones {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.capacity = MAX_DRONES

    // Internal state per drone index
    this.states = new Map() // agentId -> { scale, targetScale, angle }

    // 1. Drone Core: smooth metallic sphere with glowing emissive pulse
    const coreGeo = new THREE.SphereGeometry(0.09, 14, 10)
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x1a2b3c,
      emissive: 0x4fe3c1,
      emissiveIntensity: 1.6,
      roughness: 0.25,
      metalness: 0.85,
    })
    this.coreMesh = new THREE.InstancedMesh(coreGeo, coreMat, this.capacity)
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.coreMesh.count = 0
    this.coreMesh.frustumCulled = false

    // 2. Gyro Ring: thin torus orbiting the core
    const ringGeo = new THREE.TorusGeometry(0.14, 0.016, 8, 20)
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x0e1824,
      emissive: 0x5cc8ff,
      emissiveIntensity: 1.2,
      roughness: 0.3,
      metalness: 0.9,
    })
    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, this.capacity)
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.ringMesh.count = 0
    this.ringMesh.frustumCulled = false

    // 3. Scanning Hologram Beam: inverted cone pointing downward
    const beamGeo = new THREE.ConeGeometry(0.18, 0.55, 12, 1, true)
    // Rotate cone so apex is at the top (origin) and base points down
    beamGeo.translate(0, -0.275, 0)
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x5ce6cf,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, this.capacity)
    this.beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.beamMesh.count = 0
    this.beamMesh.frustumCulled = false

    this.group = new THREE.Group()
    this.group.name = 'subagent-drones'
    this.group.add(this.coreMesh, this.ringMesh, this.beamMesh)
    scene.add(this.group)
  }

  update(agents, dt, elapsed) {
    if (!agents || !agents.length) {
      this.coreMesh.count = 0
      this.ringMesh.count = 0
      this.beamMesh.count = 0
      this.coreMesh.instanceMatrix.needsUpdate = true
      this.ringMesh.instanceMatrix.needsUpdate = true
      this.beamMesh.instanceMatrix.needsUpdate = true
      return
    }

    let droneCount = 0

    for (let i = 0; i < agents.length && droneCount < this.capacity; i++) {
      const agent = agents[i]
      const thread = agent.thread
      const hasSubagent = Boolean(thread?.subagentActive || (agent.status === 'working' && thread?.activeToolCategory === 'subagent'))

      let state = this.states.get(agent.id)
      if (!state) {
        state = { scale: 0, targetScale: 0, angle: (i * 1.37) % (Math.PI * 2) }
        this.states.set(agent.id, state)
      }

      state.targetScale = hasSubagent ? 1 : 0

      // Smooth scale interpolation (pop-in & warp-out)
      if (state.scale < state.targetScale) {
        state.scale = Math.min(state.targetScale, state.scale + dt * 4.5)
      } else if (state.scale > state.targetScale) {
        state.scale = Math.max(state.targetScale, state.scale - dt * 3.5)
      }

      if (state.scale <= 0.01) continue

      // Orbit physics: smooth circular path over the astronaut's shoulder
      state.angle += dt * 2.4
      const orbitRadius = 0.72
      const bob = Math.sin(elapsed * 3.2 + i) * 0.08
      const groundY = agent.groundY ?? agent.pos.y
      const droneY = groundY + 1.36 + bob
      const droneX = agent.pos.x + Math.cos(state.angle) * orbitRadius
      const droneZ = agent.pos.z + Math.sin(state.angle) * orbitRadius

      const currentScale = state.scale

      // 1. Position core
      DUMMY.position.set(droneX, droneY, droneZ)
      DUMMY.rotation.set(0, elapsed * 1.5, 0)
      DUMMY.scale.setScalar(currentScale)
      DUMMY.updateMatrix()
      this.coreMesh.setMatrixAt(droneCount, DUMMY.matrix)

      // 2. Position gyro ring (tilted spin)
      RING_DUMMY.position.set(droneX, droneY, droneZ)
      RING_DUMMY.rotation.set(0.45 + Math.sin(elapsed * 2) * 0.2, elapsed * 4.2, 0.3)
      RING_DUMMY.scale.setScalar(currentScale)
      RING_DUMMY.updateMatrix()
      this.ringMesh.setMatrixAt(droneCount, RING_DUMMY.matrix)

      // 3. Position holographic scanning beam pointing downwards
      BEAM_DUMMY.position.set(droneX, droneY, droneZ)
      BEAM_DUMMY.rotation.set(0, 0, 0)
      const pulseBeam = (1 + Math.sin(elapsed * 6 + i * 2) * 0.15) * currentScale
      BEAM_DUMMY.scale.set(pulseBeam, currentScale, pulseBeam)
      BEAM_DUMMY.updateMatrix()
      this.beamMesh.setMatrixAt(droneCount, BEAM_DUMMY.matrix)

      droneCount++
    }

    this.coreMesh.count = droneCount
    this.ringMesh.count = droneCount
    this.beamMesh.count = droneCount
    this.coreMesh.instanceMatrix.needsUpdate = true
    this.ringMesh.instanceMatrix.needsUpdate = true
    this.beamMesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.scene.remove(this.group)
    this.coreMesh.geometry.dispose()
    this.coreMesh.material.dispose()
    this.ringMesh.geometry.dispose()
    this.ringMesh.material.dispose()
    this.beamMesh.geometry.dispose()
    this.beamMesh.material.dispose()
  }
}
