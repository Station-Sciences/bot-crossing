import * as THREE from 'three'
import { createCoordinateMap } from './coordinates.js'
import { createBindingGroups, READINESS, readinessFor } from './contracts.js'
import { deriveTransferEndpoints } from './replay.js'
import { PHASE, unitPhaseColor, indexUnits, endpointMatches } from './world.js'
import { floorplanLodForDistance, MAX_FLOORPLAN_LOD, physicalLodItems } from './physical-lod.js'

const tmpMatrix = new THREE.Matrix4()
const tmpPosition = new THREE.Vector3()
const tmpQuaternion = new THREE.Quaternion()
const tmpScale = new THREE.Vector3()
const tmpColor = new THREE.Color()
const WHITE = new THREE.Color(0xffffff)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * The shared 2.5D floorplan. One geometry, two layers:
 *   - physical: extrude/colour leaves by runtime readiness (the prototype view);
 *   - capability: render a non-overlapping cut through the authored physical
 *     hierarchy, expanding SSoT super-units as camera LOD increases.
 *
 * X/Z are the source micrometre coordinates from the floorplan SSoT. Y extrusion
 * and any arcs encode status/activity only. No application code invents X/Z
 * placement or block dimensions.
 */
export class T100ChipView {
  constructor(scene, camera) {
    this.camera = camera
    this.root = new THREE.Group()
    this.root.name = 'T100 floorplan'
    this.root.visible = false
    scene.add(this.root)
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.selectedUnitId = null
    this.hoveredUnitId = null
    this.layer = 'capability'
    this.connectionFilter = 'selected' // 'selected' | 'all' | 'none'
    this.connectionSource = 'manifest' // 'manifest' | 'floorplan' | 'both'
    this.pulses = new Map()
    this.markers = []
    this.transfers = []
    this.trayItems = []
    this.logicalItems = []
    this.floorplanLod = 0
  }

  setWorld(world, layout, readiness) {
    this.world = world
    this.layout = layout
    this.readiness = readiness
    this.unitsById = indexUnits(world)
    this.map = createCoordinateMap(layout.chipSizeUm)
    this.instances = layout.leaves
    this.bindingGroups = createBindingGroups(layout)
    this.root.clear()
    this.markers = []
    this.transfers = []
    this.trayItems = []
    this.logicalItems = []
    this.lodGroups = []
    this.lodItems = []

    // unit id -> leaf indexes (via bind path), for O(1) unit highlighting.
    this.leafIndexesByUnit = new Map()
    this.unitIdByLeaf = new Array(this.instances.length).fill('')

    this._addSubstrate()
    this._addLeaves()
    this._addPhysicalLods()
    this._buildCapabilityCentroids()
    this._addConnections()
    this._addTray()
    this._addLighting()
    this._refreshColors()
  }

  _addSubstrate() {
    const substrate = new THREE.Mesh(
      new THREE.BoxGeometry(this.map.worldWidth + 2, 0.35, this.map.worldHeight + 2),
      new THREE.MeshStandardMaterial({ color: 0x141922, roughness: 0.85, metalness: 0.3 }),
    )
    substrate.position.y = -0.24
    substrate.receiveShadow = true
    this.root.add(substrate)
  }

  _addLeaves() {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    geometry.translate(0, 0.5, 0)
    // No `vertexColors` here: per-leaf colour comes from setColorAt/instanceColor,
    // which three.js wires up itself. Asking for vertex colours as well makes the
    // shader sample a per-vertex `color` attribute this BoxGeometry does not have,
    // and a missing attribute reads as black — which rendered the whole die black.
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.25,
      transparent: true,
      opacity: this.layer === 'physical' ? 1 : 0.18,
    })
    this.mesh = new THREE.InstancedMesh(geometry, material, this.instances.length)
    this.mesh.name = 'T100 leaf floorplan instances'
    this.mesh.visible = this.layer === 'physical'
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.root.add(this.mesh)

    this.baseStates = []
    this.worldRects = []
    this.instances.forEach((instance, index) => {
      const rect = this.map.rect(instance.rectUm)
      this.baseStates[index] = readinessFor(instance, this.readiness)
      this.worldRects[index] = rect
      this._setMatrix(index, rect, this._heightFor(index))
      const unitId = this._unitIdFor(instance)
      this.unitIdByLeaf[index] = unitId
      if (unitId) {
        const list = this.leafIndexesByUnit.get(unitId) || []
        list.push(index)
        this.leafIndexesByUnit.set(unitId, list)
      }
      if (this.baseStates[index].state === 'blocked') this._addBlockedMarker(index, rect)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  _labelSprite(text, emphasis, { depthTest = false } = {}) {
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 96
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = emphasis === 'subdued' ? 'rgba(225,235,245,.58)' : 'rgba(245,250,255,.96)'
    ctx.font = `${emphasis === 'important' ? 700 : 600} ${emphasis === 'important' ? 34 : 28}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 12)
    const material = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthTest,
      depthWrite: false,
      opacity: emphasis === 'subdued' ? 0.62 : 0.96,
    })
    return new THREE.Sprite(material)
  }

  _addPhysicalLods() {
    this.lodGroupRoot = new THREE.Group()
    this.lodGroupRoot.name = 'SSoT physical hierarchy LOD'
    this.root.add(this.lodGroupRoot)
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    geometry.translate(0, 0.5, 0)

    for (let lod = 0; lod <= MAX_FLOORPLAN_LOD; lod++) {
      const group = new THREE.Group()
      group.name = `Physical hierarchy LOD ${lod}`
      group.visible = this.layer === 'capability' && lod === this.floorplanLod
      this.lodGroupRoot.add(group)
      this.lodGroups[lod] = group
      this.lodItems[lod] = []

      for (const item of physicalLodItems(this.layout, lod)) {
        const unit = item.primaryUnitId ? this.unitsById.get(item.primaryUnitId) : null
        const emphasis = ['vpu', 'sram'].some((name) => item.logicalUnitIds.some((id) => id.endsWith(`.${name}`)))
          ? 'subdued'
          : ['dfe', 'ovmm', 'send', 'tdma', 'noc_hs', 'noc_csr']
              .some((name) => item.logicalUnitIds.some((id) => id.endsWith(`.${name}`)))
            ? 'important'
            : 'normal'
        const color = new THREE.Color(unit ? unitPhaseColor(unit) : PHASE.unknown.color)
        if (emphasis === 'subdued') color.lerp(new THREE.Color(0x27323f), 0.58)
        const material = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.72,
          metalness: 0.08,
          transparent: true,
          opacity: emphasis === 'subdued' ? 0.56 : 0.88,
        })
        const rect = this.map.rect(item.rectUm)
        const mesh = new THREE.Mesh(geometry, material)
        const height = emphasis === 'important' ? 0.18 : emphasis === 'subdued' ? 0.08 : 0.12
        mesh.position.set(rect.x, 0.02, rect.z)
        mesh.scale.set(Math.max(0.04, rect.width * 0.985), height, Math.max(0.04, rect.depth * 0.985))
        mesh.userData.unitId = item.primaryUnitId
        mesh.userData.physicalId = item.instance.id
        group.add(mesh)

        const rendered = {
          ...item,
          lod,
          mesh,
          baseColor: color.getHex(),
          emphasis,
        }
        this.lodItems[lod].push(rendered)
        this.logicalItems.push(rendered)

        // Labels are also authored by the floorplan SSoT. Unlabelled leaves
        // remain quiet instead of creating hundreds of overlapping sprites.
        if (item.instance.display?.label) {
          const labelWidth = clamp(rect.width * 0.72, 0.7, item.aggregate ? 5.2 : 2.2)
          const label = this._labelSprite(item.label, emphasis, { depthTest: true })
          label.position.set(rect.x, height + 0.12, rect.z)
          label.scale.set(labelWidth, labelWidth / 4, 1)
          label.userData.unitId = item.primaryUnitId
          label.userData.physicalId = item.instance.id
          group.add(label)
          rendered.labelSprite = label
        }
      }
    }
  }

  _buildCapabilityCentroids() {
    this.capabilityCentroids = new Map()
    const accumulators = new Map()
    for (const item of this.lodItems[0] || []) {
      const area = Math.max(1, item.rectUm.width * item.rectUm.height)
      const x = item.rectUm.x + item.rectUm.width / 2
      const y = item.rectUm.y + item.rectUm.height / 2
      for (const unitId of item.logicalUnitIds) {
        const value = accumulators.get(unitId) || { area: 0, x: 0, y: 0 }
        value.area += area
        value.x += x * area
        value.y += y * area
        accumulators.set(unitId, value)
      }
    }
    for (const [unitId, value] of accumulators) {
      const point = this.map.point(value.x / value.area, value.y / value.area)
      this.capabilityCentroids.set(unitId, new THREE.Vector3(point.x, 0.45, point.z))
    }
  }

  /** Which world unit a leaf belongs to: exact bind path match against the model. */
  _unitIdFor(instance) {
    const path = instance.logicalUnitRef || instance.bind?.path || ''
    if (path && this.unitsById.has(path)) return path
    return ''
  }

  _heightFor(index) {
    if (this.layer === 'physical') return READINESS[this.baseStates[index].state].height
    const unitId = this.unitIdByLeaf?.[index]
    const unit = unitId ? this.unitsById.get(unitId) : null
    // Capability: bound districts stand a touch taller so the map reads as a city.
    return unit ? 0.4 : 0.22
  }

  _setMatrix(index, rect, height, lift = 0) {
    tmpPosition.set(rect.x, lift, rect.z)
    tmpScale.set(Math.max(0.12, rect.width * 0.94), height, Math.max(0.12, rect.depth * 0.94))
    tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale)
    this.mesh.setMatrixAt(index, tmpMatrix)
  }

  _addConnections() {
    // Both layers use the physical SSoT. Capability centroids come from the
    // visible chip-LOD super-units; physical centroids require true leaf binds.
    const boundUnitIds = [...this.leafIndexesByUnit.keys()]
    const physicalCentroid = (unitId) => {
      const group = this.bindingGroups.get(unitId)
      if (!group || !group.centroidUm) return null
      const p = this.map.point(group.centroidUm.x, group.centroidUm.y)
      return new THREE.Vector3(p.x, 0.3, p.z)
    }
    const worldUnitIds = [...this.unitsById.keys()]
    const resolveEndpoint = (endpoint, ids) => ids.find((id) => endpointMatches(endpoint, id)) || null
    const logicalCentroid = (unitId) => this.capabilityCentroids.get(unitId)?.clone() || null

    this.connections = []
    for (const conn of this.world.connections || []) {
      const fromUnit = resolveEndpoint(conn.from, worldUnitIds)
      const toUnit = resolveEndpoint(conn.to, worldUnitIds)
      if (!fromUnit || !toUnit || fromUnit === toUnit) continue
      const physicalFrom = resolveEndpoint(conn.from, boundUnitIds)
      const physicalTo = resolveEndpoint(conn.to, boundUnitIds)
      this.connections.push({
        ...conn,
        source: 'manifest',
        fromUnit,
        toUnit,
        logicalA: logicalCentroid(fromUnit),
        logicalB: logicalCentroid(toUnit),
        physicalA: physicalFrom ? physicalCentroid(physicalFrom) : null,
        physicalB: physicalTo ? physicalCentroid(physicalTo) : null,
      })
    }

    // Floorplan port connections are a separate physical contract. Their own
    // endpoint coordinates are used directly; they are never joined to a
    // logical unit unless the floorplan itself supplies that identity.
    for (const conn of this.layout.connections || []) {
      const from = conn.fromEndpoint
      const to = conn.toEndpoint
      if (from?.xUm == null || from?.yUm == null || to?.xUm == null || to?.yUm == null) continue
      const a2 = this.map.point(from.xUm, from.yUm)
      const b2 = this.map.point(to.xUm, to.yUm)
      this.connections.push({
        ...conn,
        source: 'floorplan',
        fromUnit: '',
        toUnit: '',
        physicalA: new THREE.Vector3(a2.x, 0.32, a2.z),
        physicalB: new THREE.Vector3(b2.x, 0.32, b2.z),
      })
    }

    this.connectionGroup = new THREE.Group()
    this.root.add(this.connectionGroup)
    const peaks = this.connections
      .map((connection) => Number(connection.performance?.peakBytesPerSecond) || 0)
      .filter((value) => value > 0)
      .map(Math.log10)
    this.linkLogRange = {
      min: peaks.length ? Math.min(...peaks) : 0,
      max: peaks.length ? Math.max(...peaks) : 1,
    }
    this._refreshConnections()
  }

  _refreshConnections() {
    if (!this.connectionGroup) return
    this.connectionGroup.clear()
    const shown = this.connections.filter((c) => {
      if (this.connectionSource !== 'both' && c.source !== this.connectionSource) return false
      if (this.connectionFilter === 'none') return false
      if (this.connectionFilter === 'all') return true
      if (!this.selectedUnitId) return false
      if (c.source === 'floorplan') {
        const physical = new Set(
          (this.bindingGroups.get(this.selectedUnitId)?.instances || []).map((instance) => instance.id),
        )
        return physical.has(c.from) || physical.has(c.to)
      }
      return c.fromUnit === this.selectedUnitId || c.toUnit === this.selectedUnitId
    })
    if (!shown.length) return
    const minLog = this.linkLogRange?.min ?? 0
    const maxLog = this.linkLogRange?.max ?? 1
    for (const c of shown) {
      const capability = this.layer === 'capability'
      const a = capability ? c.logicalA : c.physicalA
      const b = capability ? c.logicalB : c.physicalB
      if (!a || !b) continue
      const peak = Number(c.performance?.peakBytesPerSecond) || 0
      const scaled = peak > 0 ? (Math.log10(peak) - minLog) / Math.max(1, maxLog - minLog) : 0
      const radius = peak > 0 ? 0.035 + scaled * 0.16 : 0.022
      const middle = a.clone().lerp(b, 0.5)
      middle.y += 0.35 + Math.min(2.1, a.distanceTo(b) * 0.045)
      const curve = new THREE.QuadraticBezierCurve3(a, middle, b)
      const geometry = new THREE.TubeGeometry(curve, 14, radius, 6, false)
      const traffic = c.performance?.trafficClass
      const disputed = ['unknown', 'disputed'].includes(c.performance?.status)
      const color = disputed ? 0x8b9baa : traffic === 'bulk' ? 0x49c7ff : traffic === 'control' ? 0xffc857 : 0x8b9baa
      this.connectionGroup.add(
        new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: peak > 0 ? 0.7 : 0.32,
            depthWrite: false,
          }),
        ),
      )
    }
  }

  /**
   * The unplaced tray: unbound logical units, laid out in a row beyond the die's
   * far edge. They are pickable and select the same unit, but they carry no
   * silicon coordinates — the honest gap the floorplan has not closed.
   */
  _addTray() {
    const unplaced = (this.world.unplaced || []).filter((u) => this.unitsById.has(u.id))
    if (!unplaced.length) return
    const cols = Math.ceil(Math.sqrt(unplaced.length))
    const gap = 1.6
    const size = 1.1
    const z0 = this.map.worldHeight / 2 + 3
    const x0 = -((cols - 1) * gap) / 2
    this.trayGroup = new THREE.Group()
    this.trayGroup.visible = this.layer === 'physical'
    this.root.add(this.trayGroup)
    const geometry = new THREE.BoxGeometry(size, 0.3, size)
    geometry.translate(0, 0.15, 0)
    unplaced.forEach((u, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const unit = this.unitsById.get(u.id)
      const material = new THREE.MeshStandardMaterial({
        color: unitPhaseColor(unit),
        roughness: 0.7,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x0 + col * gap, 0, z0 + row * gap)
      mesh.userData.unitId = u.id
      mesh.castShadow = true
      this.trayGroup.add(mesh)
      this.trayItems.push({ unitId: u.id, mesh, baseColor: unitPhaseColor(unit) })
    })
  }

  _addBlockedMarker(index, rect) {
    const pts = [
      [-rect.width / 2, -rect.depth / 2],
      [rect.width / 2, -rect.depth / 2],
      [rect.width / 2, rect.depth / 2],
      [-rect.width / 2, rect.depth / 2],
    ].map(([x, z]) => new THREE.Vector3(rect.x + x, READINESS.blocked.height + 0.08, rect.z + z))
    const geometry = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]])
    const marker = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xff7af1, transparent: true, opacity: 0.9 }))
    marker.userData.instanceIndex = index
    this.markers.push(marker)
    this.root.add(marker)
  }

  _addLighting() {
    this.root.add(new THREE.HemisphereLight(0xbad7ff, 0x11131a, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.4)
    sun.position.set(-20, 35, 14)
    sun.castShadow = true
    this.root.add(sun)
  }

  frame(rig) {
    const distance = Math.max(this.map.worldWidth, this.map.worldHeight) * 1.35
    rig.focus(new THREE.Vector3(0, 0, 4), { distance: Math.max(20, Math.min(80, distance)) })
  }

  setVisible(visible) {
    this.root.visible = visible
  }

  setLayer(layer) {
    if (layer === this.layer) return
    this.layer = layer
    if (this.lodGroupRoot) this.lodGroupRoot.visible = layer === 'capability'
    if (this.trayGroup) this.trayGroup.visible = layer === 'physical'
    if (this.mesh) this.mesh.visible = layer === 'physical'
    // Re-extrude to the layer's heights, then recolour.
    this.instances.forEach((_, index) => this._setMatrix(index, this.worldRects[index], this._heightFor(index)))
    this.mesh.instanceMatrix.needsUpdate = true
    this._refreshColors()
    this._refreshConnections()
  }

  setConnectionFilter(mode) {
    this.connectionFilter = mode
    this._refreshConnections()
  }

  setConnectionSource(source) {
    if (!['manifest', 'floorplan', 'both'].includes(source)) return
    this.connectionSource = source
    this._refreshConnections()
  }

  ssotItemsForUnit(unitId, lod = 0) {
    if (!unitId) return []
    return (this.lodItems[lod] || []).filter((item) => item.logicalUnitIds.includes(unitId))
  }

  pick(ndcX, ndcY) {
    if (!this.mesh || !this.root.visible) return null
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (this.layer === 'capability') {
      const visibleItems = this.lodItems[this.floorplanLod] || []
      const hit = this.raycaster.intersectObjects(visibleItems.map((item) => item.mesh), false)[0]
      if (hit) {
        const item = visibleItems.find((candidate) => candidate.mesh === hit.object)
        return {
          type: 'physical-hierarchy',
          unitId: hit.object.userData.unitId || '',
          instance: item?.instance || null,
          logicalUnitIds: item?.logicalUnitIds || [],
        }
      }
    }
    // The tray is physical-layer disclosure for units with no physical bind.
    if (this.layer === 'physical' && this.trayItems.length) {
      const hit = this.raycaster.intersectObjects(this.trayItems.map((t) => t.mesh), false)[0]
      if (hit) return { type: 'tray', unitId: hit.object.userData.unitId, instance: null }
    }
    const hit = this.raycaster.intersectObject(this.mesh, false)[0]
    if (hit?.instanceId == null) return null
    const instance = this.instances[hit.instanceId]
    return { type: 'leaf', unitId: this.unitIdByLeaf[hit.instanceId] || '', instance }
  }

  selectUnit(unitId) {
    this.selectedUnitId = unitId || null
    this._refreshColors()
    this._refreshConnections()
  }

  hoverUnit(unitId) {
    this.hoveredUnitId = unitId || null
    this._refreshColors()
  }

  _leafColor(index) {
    if (this.layer === 'physical') {
      const state = this._stateAt(index)
      return tmpColor.setHex(READINESS[state]?.color ?? READINESS.unknown.color)
    }
    const unitId = this.unitIdByLeaf[index]
    const unit = unitId ? this.unitsById.get(unitId) : null
    return tmpColor.setHex(unit ? unitPhaseColor(unit) : PHASE.unknown.color)
  }

  _refreshColors() {
    if (!this.mesh) return
    this.instances.forEach((_, index) => {
      const color = this._leafColor(index)
      const unitId = this.unitIdByLeaf[index]
      if (unitId && unitId === this.selectedUnitId) color.lerp(WHITE, 0.45)
      else if (unitId && unitId === this.hoveredUnitId) color.lerp(WHITE, 0.22)
      this.mesh.setColorAt(index, color)
    })
    this.mesh.instanceColor.needsUpdate = true
    for (const item of this.trayItems) {
      tmpColor.setHex(item.baseColor)
      if (item.unitId === this.selectedUnitId) tmpColor.lerp(WHITE, 0.5)
      else if (item.unitId === this.hoveredUnitId) tmpColor.lerp(WHITE, 0.25)
      item.mesh.material.color.copy(tmpColor)
    }
    for (const item of this.logicalItems) {
      tmpColor.setHex(item.baseColor)
      if (item.logicalUnitIds.includes(this.selectedUnitId)) tmpColor.lerp(WHITE, 0.52)
      else if (item.logicalUnitIds.includes(this.hoveredUnitId)) tmpColor.lerp(WHITE, 0.24)
      item.mesh.material.color.copy(tmpColor)
    }
  }

  // ── replay (physical layer activity) ────────────────────────────────────────

  applyReplay(events, replayState) {
    for (const event of events) {
      const key = event.targetPath || event.logicalUnitRef || event.componentPath
      const indexes = this.leafIndexesByUnit.get(key) || []
      for (const index of indexes) this.pulses.set(index, 1)
      const endpoints = deriveTransferEndpoints(event, this.bindingGroups)
      if (endpoints) this._addTransfer(endpoints)
    }
    this.replayState = replayState
    this._refreshColors()
  }

  _stateAt(index) {
    const key = this.unitIdByLeaf[index]
    const replay = key ? this.replayState?.components.get(key) : null
    return replay?.activity || this.baseStates[index].state
  }

  _addTransfer(endpoints) {
    const from = this.map.point(endpoints.fromUm.x, endpoints.fromUm.y)
    const to = this.map.point(endpoints.toUm.x, endpoints.toUm.y)
    const start = new THREE.Vector3(from.x, 0.9, from.z)
    const end = new THREE.Vector3(to.x, 0.9, to.z)
    const middle = start.clone().lerp(end, 0.5)
    const distance = start.distanceTo(end)
    middle.y += Math.max(1.4, distance * 0.12)
    if (distance < 0.01) middle.x += 2.4
    const curve = new THREE.QuadraticBezierCurve3(start, middle, end)
    const group = new THREE.Group()
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.75 }),
    )
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    group.add(line, marker)
    this.root.add(group)
    this.transfers.push({ group, line, marker, curve, age: 0, duration: 1.6 })
  }

  update(dt, elapsed, cameraDistance) {
    if (!this.mesh || !this.root.visible) return
    const nextLod = floorplanLodForDistance(cameraDistance)
    if (nextLod !== this.floorplanLod) {
      this.floorplanLod = nextLod
      for (const [lod, group] of this.lodGroups.entries()) {
        group.visible = this.layer === 'capability' && lod === nextLod
      }
      this.hoveredUnitId = null
      this._refreshColors()
    }
    let matricesChanged = false
    for (const [index, pulse] of this.pulses) {
      const next = Math.max(0, pulse - dt * 0.7)
      const bump = Math.sin((1 - next) * Math.PI * 5) * next * 0.16
      this._setMatrix(index, this.worldRects[index], this._heightFor(index), Math.max(0, bump))
      matricesChanged = true
      if (next === 0) this.pulses.delete(index)
      else this.pulses.set(index, next)
    }
    if (matricesChanged) this.mesh.instanceMatrix.needsUpdate = true
    for (const marker of this.markers) marker.material.opacity = 0.55 + Math.sin(elapsed * 5) * 0.35
    for (let i = this.transfers.length - 1; i >= 0; i--) {
      const t = this.transfers[i]
      t.age += dt
      const progress = Math.min(1, t.age / t.duration)
      t.curve.getPoint(progress, t.marker.position)
      t.marker.scale.setScalar(0.8 + Math.sin(progress * Math.PI) * 0.8)
      t.line.material.opacity = 0.75 * (1 - progress)
      if (progress === 1) {
        this.root.remove(t.group)
        this.transfers.splice(i, 1)
      }
    }
  }
}
