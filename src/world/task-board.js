import * as THREE from 'three'
import { terrainHeight } from './planet.js'

/**
 * Task Board Billboard — stands next to the spaceship in the colony.
 *
 * Designed as an industrial, retro-futuristic telemetry billboard:
 * Sturdy structural pylons rooted in the regolith, a beveled display housing,
 * overhead luminaire lamps, and an illuminated electronic canvas reading:
 *   1. "TASKS" in bold glowing sci-fi lettering across the header.
 *   2. Active in-flight agent tasks & cron jobs styled as terminal script.
 *   3. Simulated telemetry code, status glyphs, and system health bars.
 *
 * Clicking the billboard opens the interactive Colony Task Board modal.
 */

const METAL_COLOR = 0x5a5d66
const HOUSING_COLOR = 0x16181f
const FRAME_TRIM = 0x3fa8a0 // Cyan accent
const LAMP_COLOR = 0x9fd8ff

export class TaskBoardBillboard {
  constructor(scene, shipPos, planet) {
    this.scene = scene
    this.shipPos = shipPos
    this.planet = planet

    this.group = new THREE.Group()
    this.group.name = 'task-board-billboard'
    scene.add(this.group)

    this.tasks = []
    this.cronjobs = []
    this.hovered = false
    this.raycaster = new THREE.Raycaster()

    // Billboard world offset relative to ship position:
    // Placed directly in the dirt to the right of the spaceship (starboard side, -Z).
    // Sits in its own open spot in the regolith with no hex tiles or foundation slabs.
    this.relOffset = new THREE.Vector3(5.2, 0, -5.0)
    this.position = new THREE.Vector3().addVectors(shipPos, this.relOffset)
    this.group.position.copy(this.position)

    // Angled to face squarely toward the default isometric camera and colony center
    this.group.rotation.y = Math.PI * 0.25

    this._setupCanvas()
    this._buildMesh()
    this._positionOnTerrain()
    this.renderCanvas()
  }

  setPlanet(planet) {
    this.planet = planet
    this._positionOnTerrain()
  }

  _positionOnTerrain() {
    const y = terrainHeight(this.position.x, this.position.z, this.planet)
    this.position.y = y
    this.group.position.set(this.position.x, y, this.position.z)
  }

  _setupCanvas() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1024
    this.canvas.height = 600
    this.ctx = this.canvas.getContext('2d')

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearMipmapLinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = true
    this.texture.anisotropy = 8
  }

  _buildMesh() {
    // 1. Structural pylons (legs planted directly into the terrain dirt)
    const legGeo = new THREE.CylinderGeometry(0.1, 0.12, 4.2, 8)
    const legMat = new THREE.MeshStandardMaterial({
      color: METAL_COLOR,
      roughness: 0.6,
      metalness: 0.8,
    })

    const leftLeg = new THREE.Mesh(legGeo, legMat)
    leftLeg.position.set(-1.3, 2.0, 0)
    leftLeg.castShadow = true
    leftLeg.receiveShadow = true
    this.group.add(leftLeg)

    const rightLeg = new THREE.Mesh(legGeo, legMat)
    rightLeg.position.set(1.3, 2.0, 0)
    rightLeg.castShadow = true
    rightLeg.receiveShadow = true
    this.group.add(rightLeg)

    // Footpads resting on the ground
    const padGeo = new THREE.CylinderGeometry(0.32, 0.4, 0.22, 10)
    const leftPad = new THREE.Mesh(padGeo, legMat)
    leftPad.position.set(-1.3, 0.11, 0)
    this.group.add(leftPad)

    const rightPad = new THREE.Mesh(padGeo, legMat)
    rightPad.position.set(1.3, 0.11, 0)
    this.group.add(rightPad)

    // X-truss cross bracing under the billboard
    const braceGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.8, 6)
    const brace1 = new THREE.Mesh(braceGeo, legMat)
    brace1.position.set(0, 1.25, 0)
    brace1.rotation.z = 0.82
    this.group.add(brace1)

    const brace2 = new THREE.Mesh(braceGeo, legMat)
    brace2.position.set(0, 1.25, 0)
    brace2.rotation.z = -0.82
    this.group.add(brace2)

    // 2. Main billboard display housing (box)
    const housingWidth = 3.6
    const housingHeight = 2.2
    const housingDepth = 0.22
    const housingGeo = new THREE.BoxGeometry(housingWidth, housingHeight, housingDepth)
    this.housingMat = new THREE.MeshStandardMaterial({
      color: HOUSING_COLOR,
      roughness: 0.5,
      metalness: 0.3,
    })

    this.hitMesh = new THREE.Mesh(housingGeo, this.housingMat)
    this.hitMesh.position.set(0, 2.9, 0)
    this.hitMesh.castShadow = true
    this.hitMesh.receiveShadow = true
    this.group.add(this.hitMesh)

    // Accent trim frame around the screen (front and back)
    const trimGeo = new THREE.BoxGeometry(housingWidth + 0.08, housingHeight + 0.08, 0.04)
    this.trimMat = new THREE.MeshStandardMaterial({
      color: FRAME_TRIM,
      roughness: 0.4,
      metalness: 0.5,
    })

    const frontTrim = new THREE.Mesh(trimGeo, this.trimMat)
    frontTrim.position.set(0, 2.9, 0.1)
    this.group.add(frontTrim)

    const backTrim = new THREE.Mesh(trimGeo, this.trimMat)
    backTrim.position.set(0, 2.9, -0.1)
    this.group.add(backTrim)

    // 3. Electronic Screen Face (Double-sided: Front & Back meshes for perfect readability from any angle)
    const screenGeo = new THREE.PlaneGeometry(3.4, 2.0)
    this.screenMat = new THREE.MeshBasicMaterial({
      map: this.texture,
      toneMapped: false,
      side: THREE.DoubleSide,
    })

    // Front screen face
    this.screenMeshFront = new THREE.Mesh(screenGeo, this.screenMat)
    this.screenMeshFront.position.set(0, 2.9, 0.125)
    this.group.add(this.screenMeshFront)

    // Back screen face (rotated 180° so text/script reads properly from the rear too)
    this.screenMeshBack = new THREE.Mesh(screenGeo, this.screenMat)
    this.screenMeshBack.position.set(0, 2.9, -0.125)
    this.screenMeshBack.rotation.y = Math.PI
    this.group.add(this.screenMeshBack)

    // 4. Overhead luminaire hood bars (Front and Back)
    const hoodGeo = new THREE.BoxGeometry(3.7, 0.09, 0.38)
    const frontHood = new THREE.Mesh(hoodGeo, legMat)
    frontHood.position.set(0, 4.05, 0.24)
    frontHood.rotation.x = 0.25
    this.group.add(frontHood)

    const backHood = new THREE.Mesh(hoodGeo, legMat)
    backHood.position.set(0, 4.05, -0.24)
    backHood.rotation.x = -0.25
    this.group.add(backHood)

    // Lamp emitters
    const lampGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.04, 8)
    this.lampMat = new THREE.MeshBasicMaterial({
      color: LAMP_COLOR,
      toneMapped: true,
    })
    for (let i = 0; i < 3; i++) {
      const x = -1.1 + i * 1.1

      const frontLamp = new THREE.Mesh(lampGeo, this.lampMat)
      frontLamp.rotation.x = Math.PI / 2
      frontLamp.position.set(x, 4.01, 0.34)
      this.group.add(frontLamp)

      const backLamp = new THREE.Mesh(lampGeo, this.lampMat)
      backLamp.rotation.x = -Math.PI / 2
      backLamp.position.set(x, 4.01, -0.34)
      this.group.add(backLamp)
    }

    // 5. Signal Antenna & Pulsing Beacon at the top
    const antennaGeo = new THREE.CylinderGeometry(0.03, 0.05, 1.1, 8)
    const antennaMesh = new THREE.Mesh(antennaGeo, legMat)
    antennaMesh.position.set(0, 4.6, 0)
    this.group.add(antennaMesh)

    const beaconGeo = new THREE.SphereGeometry(0.18, 12, 10)
    this.beaconMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      toneMapped: false,
    })
    this.beacon = new THREE.Mesh(beaconGeo, this.beaconMat)
    this.beacon.position.set(0, 5.18, 0)
    this.group.add(this.beacon)
  }

  renderCanvas() {
    const c = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height

    // 1. Background
    c.fillStyle = '#0a0e19'
    c.fillRect(0, 0, w, h)

    // Scanlines
    c.fillStyle = 'rgba(0, 229, 255, 0.025)'
    for (let y = 0; y < h; y += 4) {
      c.fillRect(0, y, w, 2)
    }

    // Border
    c.strokeStyle = this.hovered ? 'rgba(0, 255, 200, 0.9)' : 'rgba(0, 229, 255, 0.45)'
    c.lineWidth = 4
    c.strokeRect(6, 6, w - 12, h - 12)

    // Corner decorative brackets
    c.strokeStyle = '#00e5ff'
    c.lineWidth = 6
    const cl = 28
    // Top-left
    c.beginPath()
    c.moveTo(6, 6 + cl)
    c.lineTo(6, 6)
    c.lineTo(6 + cl, 6)
    c.stroke()
    // Top-right
    c.beginPath()
    c.moveTo(w - 6 - cl, 6)
    c.lineTo(w - 6, 6)
    c.lineTo(w - 6, 6 + cl)
    c.stroke()
    // Bottom-left
    c.beginPath()
    c.moveTo(6, h - 6 - cl)
    c.lineTo(6, h - 6)
    c.lineTo(6 + cl, h - 6)
    c.stroke()
    // Bottom-right
    c.beginPath()
    c.moveTo(w - 6 - cl, h - 6)
    c.lineTo(w - 6, h - 6)
    c.lineTo(w - 6, h - 6 - cl)
    c.stroke()

    // 2. Header Bar — "TASKS"
    const headH = 92
    const grad = c.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, 'rgba(15, 28, 52, 0.95)')
    grad.addColorStop(1, 'rgba(10, 18, 34, 0.95)')
    c.fillStyle = grad
    c.fillRect(10, 10, w - 20, headH)

    // Status LED dot
    const activeTasksCount = this.tasks.filter((t) => t.running || t.unread).length
    c.shadowColor = '#00ffaa'
    c.shadowBlur = 14
    c.fillStyle = '#00ffaa'
    c.beginPath()
    c.arc(38, 56, 9, 0, Math.PI * 2)
    c.fill()
    c.shadowBlur = 0

    // Main header title: "TASKS"
    c.shadowColor = 'rgba(0, 229, 255, 0.85)'
    c.shadowBlur = 16
    c.fillStyle = '#ffffff'
    c.font = 'bold 50px "SF Mono", "Courier New", monospace'
    c.fillText('TASKS', 62, 73)
    c.shadowBlur = 0

    // Header secondary subtitle/badge
    c.font = 'bold 18px "SF Mono", "Courier New", monospace'
    c.fillStyle = '#7df9ff'
    const statusText = activeTasksCount > 0 ? `[ ${activeTasksCount} IN FLIGHT ]` : '[ STANDBY // NOMINAL ]'
    c.fillText(statusText, 270, 68)

    // Right-side fleet telemetry badge
    c.font = '16px monospace'
    c.fillStyle = '#a0aab8'
    c.fillText('COLONY TASK ENGINE v2.0', w - 290, 68)

    // Neon divider rule
    const divGrad = c.createLinearGradient(10, 0, w - 10, 0)
    divGrad.addColorStop(0, '#00e5ff')
    divGrad.addColorStop(0.7, '#3fa8a0')
    divGrad.addColorStop(1, '#ff9900')
    c.fillStyle = divGrad
    c.fillRect(10, headH + 10, w - 20, 3)

    // 3. Body — "what looks like script"
    const startY = 144
    const lineH = 34
    let curY = startY

    c.font = 'bold 19px "Courier New", "SF Mono", monospace'

    // Formatted script lines from active tasks & cronjobs
    const scriptLines = []

    if (this.tasks.length > 0) {
      for (const t of this.tasks.slice(0, 5)) {
        const ag = (t.agent || t.harness || 'agent').toUpperCase().slice(0, 10)
        let act = t.title || t.preview || 'executing task'
        if (act.length > 40) act = act.slice(0, 38) + '…'
        const stat = t.running ? '[RUNNING]' : t.unread ? '[WAITING]' : '[ACTIVE]'
        scriptLines.push({
          prefix: '❯ ',
          tag: `[${ag}]`,
          arrow: ' -> ',
          body: act,
          status: stat,
          isCron: false,
        })
      }
    }

    if (this.cronjobs.length > 0) {
      for (const j of this.cronjobs.slice(0, 3)) {
        const ag = (j.agent || 'cron').toUpperCase().slice(0, 8)
        scriptLines.push({
          prefix: '↻ ',
          tag: `[${ag}]`,
          arrow: ` ${j.schedule || '0 0 * * *'} -> `,
          body: j.name || j.task || 'scheduled sweep',
          status: '[CRON]',
          isCron: true,
        })
      }
    }

    // If queue is sparse, add atmospheric sci-fi script lines
    if (scriptLines.length < 7) {
      scriptLines.push(
        { prefix: 'λ ', tag: '[SYS]', arrow: ' :: ', body: 'fleet.stream("colony://telemetry") => 200 OK', status: '[SYNC]', isCron: false },
        { prefix: '❯ ', tag: '[DAEMON]', arrow: ' -> ', body: 'scheduler.poll_cron_cadence(window: 15s)', status: '[ARMED]', isCron: true },
        { prefix: 'λ ', tag: '[CORE]', arrow: ' :: ', body: 'while(alive) { await colony.step(); }', status: '[LOOP]', isCron: false }
      )
    }

    // Render the script lines with code syntax highlighting
    for (const item of scriptLines.slice(0, 9)) {
      let curX = 28

      // Prefix
      c.fillStyle = item.isCron ? '#c084fc' : '#00e5ff'
      c.fillText(item.prefix, curX, curY)
      curX += c.measureText(item.prefix).width

      // Agent tag
      c.fillStyle = item.isCron ? '#e9d5ff' : '#ffc83b'
      c.fillText(item.tag, curX, curY)
      curX += c.measureText(item.tag).width

      // Arrow
      c.fillStyle = '#6f7a8a'
      c.fillText(item.arrow, curX, curY)
      curX += c.measureText(item.arrow).width

      // Body (function call / script statement)
      c.fillStyle = item.isCron ? '#f472b6' : '#5af09a'
      const maxBodyW = w - curX - 130
      let bodyText = item.body
      while (c.measureText(bodyText).width > maxBodyW && bodyText.length > 4) {
        bodyText = bodyText.slice(0, -4) + '…'
      }
      c.fillText(bodyText, curX, curY)

      // Right status tag
      c.fillStyle = item.status === '[RUNNING]' ? '#00ffaa' : item.isCron ? '#c084fc' : '#00e5ff'
      c.fillText(item.status, w - 124, curY)

      curY += lineH
    }

    // 4. Bottom Telemetry Bar & Click Action Hint
    c.fillStyle = 'rgba(255, 255, 255, 0.07)'
    c.fillRect(10, h - 68, w - 20, 1)

    // Data progress bar
    c.fillStyle = '#00e5ff'
    c.font = '15px monospace'
    c.fillText('SYS.CAPACITY [■■■■■■■■■■■■■■■■□□□□] 80%', 28, h - 30)

    // Pulsing interaction prompt
    c.font = 'bold 16px "SF Mono", "Courier New", monospace'
    c.fillStyle = this.hovered ? '#00ffaa' : '#ffc83b'
    const prompt = '▼ CLICK BOARD TO INSPECT TASKS & CRONJOBS ▼'
    c.fillText(prompt, w - c.measureText(prompt).width - 28, h - 30)

    this.texture.needsUpdate = true
  }

  updateContent(data) {
    if (!data) return
    if (Array.isArray(data.tasks)) this.tasks = data.tasks
    if (Array.isArray(data.cronjobs)) this.cronjobs = data.cronjobs
    this.renderCanvas()
  }

  setHover(hovered) {
    if (this.hovered === hovered) return
    this.hovered = hovered
    if (this.trimMat) {
      this.trimMat.color.set(hovered ? 0x00ffaa : FRAME_TRIM)
    }
    this.renderCanvas()
  }

  pick(camera, ndcX, ndcY) {
    if (!this.group) return false
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera)
    const hits = this.raycaster.intersectObjects(this.group.children, true)
    return hits.length > 0
  }

  update(dt, elapsed, night) {
    // Top antenna beacon double-pulse strobe
    const t = elapsed % 1.5
    const strobe = t < 0.09 || (t > 0.20 && t < 0.29) ? 3.5 : 0.35
    if (this.beaconMat) {
      this.beaconMat.color.setRGB(0.05 * strobe, 2.0 * strobe, 2.4 * strobe)
    }

    // Overhead lamps brighten slightly after dark
    const gain = 0.6 + night * 1.8
    if (this.lampMat) {
      this.lampMat.color.setRGB(0.55 * gain, 0.85 * gain, 1.1 * gain)
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        if (Array.isArray(o.material)) {
          o.material.forEach((m) => m.dispose())
        } else if (o.material) {
          o.material.dispose()
        }
      }
    })
    if (this.texture) this.texture.dispose()
    this.scene.remove(this.group)
  }
}
