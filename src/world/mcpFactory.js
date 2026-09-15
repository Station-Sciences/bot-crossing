import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { hashString } from './plots.js'

/**
 * The MCP factory: a fixed structure, off to one side of the ship, housing the MCP servers an
 * agent can call into. One socket per server it has seen — servers past `portCount` share the
 * last socket rather than growing the building — and each socket lights up while a pipe from
 * some astronaut is feeding it (see `MCPPipeField` below).
 *
 * Built the same way as `Ship`: a merged hull for everything static, separate meshes only for
 * the parts that actually change color at runtime.
 */

const WALL = 0x565b66
const WALL_DARK = 0x33363e
const METAL = 0x24262c
const TRIM = 0x8fb8c9
const PORT_IDLE = 0x11141a

const DEFAULT_PORTS = 6

export class MCPFactory {
  constructor(scene, position, portCount = DEFAULT_PORTS) {
    this.scene = scene
    this.portCount = portCount
    /** One glow level per port, 0..1 — written by `MCPPipeField`, read here to light the sockets. */
    this.portLevels = new Float32Array(portCount)
    this.width = portCount * 1.6 + 1.4
    this.depth = 5.2

    this.group = new THREE.Group()
    this.group.position.copy(position)
    this.group.name = 'mcp-factory'
    scene.add(this.group)

    this._buildHull()
    this._buildPorts()
    this.pulse = 0
  }

  _buildHull() {
    const parts = []
    const colors = []
    const push = (geo, color) => {
      parts.push(geo)
      colors.push(new THREE.Color(color))
    }

    const height = 3.4
    const body = new THREE.BoxGeometry(this.width, height, this.depth)
    body.translate(0, height / 2, 0)
    push(body, WALL)

    const roof = new THREE.BoxGeometry(this.width + 0.5, 0.3, this.depth + 0.5)
    roof.translate(0, height + 0.15, 0)
    push(roof, WALL_DARK)

    // Roof vents — the only thing telling you machinery lives in a plain box.
    const vents = Math.max(2, Math.round(this.width / 2.4))
    for (let i = 0; i < vents; i++) {
      const x = -this.width / 2 + ((i + 0.5) * this.width) / vents
      const vent = new THREE.CylinderGeometry(0.32, 0.36, 0.7, 10)
      vent.translate(x, height + 0.65, -this.depth / 4)
      push(vent, METAL)
    }

    // A cable trunk along the base of the front wall, feeding every socket outside it.
    const trunk = new THREE.BoxGeometry(this.width - 0.6, 0.5, 0.5)
    trunk.translate(0, 0.35, this.depth / 2 + 0.1)
    push(trunk, METAL)

    bakeColors(parts, colors)
    const merged = BufferGeometryUtils.mergeGeometries(parts, false)
    parts.forEach((g) => g.dispose())
    this.hull = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }))
    this.hull.castShadow = true
    this.hull.receiveShadow = true
    this.group.add(this.hull)

    this.signMaterial = new THREE.MeshBasicMaterial({ color: TRIM, toneMapped: true })
    const sign = new THREE.Mesh(new THREE.BoxGeometry(this.width - 1.6, 0.4, 0.08), this.signMaterial)
    sign.position.set(0, height - 0.5, this.depth / 2 + 0.05)
    this.group.add(sign)
  }

  _buildPorts() {
    this.ports = []
    for (let i = 0; i < this.portCount; i++) {
      const x = -this.width / 2 + 1.4 + i * 1.6
      const z = this.depth / 2 + 0.7

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.18, 1.0, 10),
        new THREE.MeshStandardMaterial({ color: METAL, roughness: 0.4, metalness: 0.6 })
      )
      post.position.set(x, 0.5, z)
      post.castShadow = true
      this.group.add(post)

      const material = new THREE.MeshBasicMaterial({ color: PORT_IDLE, toneMapped: true })
      const socket = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), material)
      socket.position.set(x, 1.05, z)
      this.group.add(socket)

      this.ports.push({ x, y: 1.05, z, color: new THREE.Color(0x9fd8ff), material })
    }
  }

  /** World position of socket `i` — where a pipe from an astronaut lands. */
  portPosition(i, out = new THREE.Vector3()) {
    const p = this.ports[i % this.ports.length]
    return out.set(p.x, p.y, p.z).applyMatrix4(this.group.matrixWorld)
  }

  /** The color a server assigned to socket `i` glows — pipes to it match. */
  colorFor(i) {
    return this.ports[i % this.ports.length].color
  }

  setPortColor(i, color) {
    this.ports[i % this.ports.length].color.copy(color)
  }

  update(dt, elapsed, night) {
    let peak = 0
    for (let i = 0; i < this.ports.length; i++) {
      const port = this.ports[i]
      const level = this.portLevels[i] || 0
      const idle = 0.1 + night * 0.4
      const glow = idle + level * 2.2
      const c = port.color
      port.material.color.setRGB(idle * 0.3 + c.r * glow, idle * 0.32 + c.g * glow, idle * 0.36 + c.b * glow)
      peak = Math.max(peak, level)
    }
    this.pulse = THREE.MathUtils.damp(this.pulse, peak, 3, dt)
    const s = 0.5 + night * 1.4 + this.pulse * 1.2
    this.signMaterial.color.setRGB(0.5 * s, 0.75 * s, 0.85 * s)
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.scene.remove(this.group)
  }
}

/** Bake one flat vertex color per part, the same trick `Ship` uses for its merged hull. */
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

/** Seconds a pipe keeps glowing, fading, after its thread stops calling the tool. */
const FADE_SECONDS = 0.9
/** A pathological burst of calls should not grow the scene without bound. */
const MAX_PIPES = 18

const PIPE_VERTEX = `
varying float vAlong;
void main() {
  vAlong = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const PIPE_FRAGMENT = `
uniform float uTime;
uniform vec3 uColor;
uniform float uFade;
varying float vAlong;
void main() {
  float head = fract(uTime * 1.1);
  float dist = abs(vAlong - head);
  float band = pow(max(0.0, 1.0 - dist * 5.0), 2.0);
  float brightness = 0.16 + band * 2.6;
  gl_FragColor = vec4(uColor * brightness * uFade, 1.0);
}
`

function pipeMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uFade: { value: 0 } },
    vertexShader: PIPE_VERTEX,
    fragmentShader: PIPE_FRAGMENT,
    side: THREE.DoubleSide,
  })
}

/**
 * Glowing tubes from an astronaut's site up to the MCP factory, one per thread mid-call to an
 * MCP tool. A tube fades out over `FADE_SECONDS` rather than disappearing the instant the call
 * ends, so a quick call still reads as a pulse of light rather than a flicker.
 */
export class MCPPipeField {
  constructor(scene, factory) {
    this.scene = scene
    this.factory = factory
    /** agentId -> { mesh, material, portIndex, hold } */
    this.connections = new Map()
    /** MCP server name -> port index, assigned the first time a call to it is seen. */
    this.portOf = new Map()
    this._nextPort = 0
  }

  _portFor(serverName) {
    let index = this.portOf.get(serverName)
    if (index === undefined) {
      index = this._nextPort % this.factory.portCount
      this._nextPort++
      this.portOf.set(serverName, index)
      const hue = hashString(serverName) % 360
      this.factory.setPortColor(index, new THREE.Color().setHSL(hue / 360, 0.6, 0.55))
    }
    return index
  }

  _curve(start, portIndex) {
    const end = this.factory.portPosition(portIndex)
    const mid = new THREE.Vector3((start.x + end.x) / 2, Math.max(start.y, end.y) + 2.6, (start.z + end.z) / 2)
    return new THREE.QuadraticBezierCurve3(start.clone(), mid, end)
  }

  _tube(curve) {
    return new THREE.TubeGeometry(curve, 24, 0.06, 6, false)
  }

  /** `agents` is `Astronauts.agents` — anyone whose `thread.activeMcp` names a server gets a pipe. */
  update(dt, elapsed, agents, enabled) {
    const active = new Map() // agentId -> { server, pos }
    if (enabled) {
      for (const agent of agents) {
        const server = agent.thread?.activeMcp
        if (server) active.set(agent.id, { server, pos: agent.pos })
      }
    }

    for (const [agentId, info] of active) {
      const portIndex = this._portFor(info.server)
      const start = new THREE.Vector3(info.pos.x, info.pos.y + 1.1, info.pos.z)
      let conn = this.connections.get(agentId)
      if (!conn) {
        if (this.connections.size >= MAX_PIPES) continue
        const material = pipeMaterial(this.factory.colorFor(portIndex))
        const mesh = new THREE.Mesh(this._tube(this._curve(start, portIndex)), material)
        mesh.frustumCulled = false
        this.scene.add(mesh)
        conn = { mesh, material, portIndex, hold: 0 }
        this.connections.set(agentId, conn)
      } else {
        if (conn.portIndex !== portIndex) {
          conn.portIndex = portIndex
          conn.material.uniforms.uColor.value.copy(this.factory.colorFor(portIndex))
        }
        conn.mesh.geometry.dispose()
        conn.mesh.geometry = this._tube(this._curve(start, portIndex))
      }
      conn.hold = Math.min(1, conn.hold + dt * 6)
      conn.material.uniforms.uTime.value = elapsed
      conn.material.uniforms.uFade.value = conn.hold
    }

    for (const [agentId, conn] of this.connections) {
      if (active.has(agentId)) continue
      conn.hold -= dt / FADE_SECONDS
      conn.material.uniforms.uTime.value = elapsed
      conn.material.uniforms.uFade.value = Math.max(0, conn.hold)
      if (conn.hold <= 0) this._remove(agentId)
    }

    this.factory.portLevels.fill(0)
    for (const conn of this.connections.values()) {
      const levels = this.factory.portLevels
      levels[conn.portIndex] = Math.max(levels[conn.portIndex], Math.max(0, conn.hold))
    }
  }

  _remove(agentId) {
    const conn = this.connections.get(agentId)
    if (!conn) return
    this.scene.remove(conn.mesh)
    conn.mesh.geometry.dispose()
    conn.material.dispose()
    this.connections.delete(agentId)
  }

  dispose() {
    for (const agentId of [...this.connections.keys()]) this._remove(agentId)
  }
}
