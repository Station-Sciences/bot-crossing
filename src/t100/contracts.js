const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const array = (value) => (Array.isArray(value) ? value : [])
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

function normalizeRect(value) {
  if (Array.isArray(value)) {
    const [x = 0, y = 0, width = 0, height = 0] = value
    return { x: number(x), y: number(y), width: number(width), height: number(height) }
  }
  const rect = object(value)
  return {
    x: number(rect.x ?? rect.left),
    y: number(rect.y ?? rect.top),
    width: number(rect.width ?? rect.w),
    height: number(rect.height ?? rect.h),
  }
}

function normalizeEndpoint(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return { instance: String(value), port: '', xUm: null, yUm: null }
  }
  const endpoint = object(value)
  const coordinate = (input) => (input == null ? null : number(input))
  return {
    instance: String(endpoint.instance ?? endpoint.id ?? ''),
    port: endpoint.port == null ? '' : String(endpoint.port),
    xUm: coordinate(endpoint.x_um ?? endpoint.xUm),
    yUm: coordinate(endpoint.y_um ?? endpoint.yUm),
  }
}

function normalizeDisplay(value) {
  const display = object(value)
  const lod = Number(display.expand_at_lod ?? display.expandAtLod)
  return {
    label: display.label == null ? '' : String(display.label),
    expandAtLod: Number.isInteger(lod) ? Math.max(0, Math.min(6, lod)) : null,
    hidden: display.hidden === true,
    logicalUnits: array(display.logical_units ?? display.logicalUnits).map(String),
    primaryLogicalUnit: String(display.primary_logical_unit ?? display.primaryLogicalUnit ?? ''),
  }
}

export function normalizeLayout(raw) {
  const source = object(raw)
  const chip = object(source.chip_size_um ?? source.chipSizeUm)
  const instances = array(source.instances).map((item, index) => {
    const value = object(item)
    const bind = value.bind == null ? null : object(value.bind)
    return {
      id: String(value.id ?? `instance-${index}`),
      tile: value.tile == null ? '' : String(value.tile),
      kind: value.kind == null ? 'component' : String(value.kind),
      rectUm: normalizeRect(value.rect_um ?? value.rectUm),
      parent: value.parent == null ? null : String(value.parent),
      children: array(value.children).map(String),
      display: normalizeDisplay(value.display),
      bind,
      logicalUnitRef: String(
        value.logicalUnitRef ??
        bind?.path ??
        bind?.logicalUnitRef ??
        bind?.component_path ??
        bind?.componentPath ??
        ''
      ),
      ports: array(value.ports).map((port) => {
        const p = object(port)
        return {
          name: String(p.name ?? ''),
          interface: String(p.interface ?? p.type ?? ''),
          direction: String(p.direction ?? p.dir ?? ''),
          xUm: p.x_um == null ? null : number(p.x_um),
          yUm: p.y_um == null ? null : number(p.y_um),
        }
      }),
    }
  })
  const byId = new Map(instances.map((instance) => [instance.id, instance]))
  for (const instance of instances) {
    if (instance.parent && byId.has(instance.parent) && !byId.get(instance.parent).children.includes(instance.id)) {
      byId.get(instance.parent).children.push(instance.id)
    }
  }
  const connections = array(source.connections).map((item, index) => {
    const value = object(item)
    const fromEndpoint = normalizeEndpoint(value.from ?? value.source)
    const toEndpoint = normalizeEndpoint(value.to ?? value.target)
    return {
      id: String(value.id ?? `connection-${index}`),
      from: fromEndpoint.instance,
      to: toEndpoint.instance,
      fromEndpoint,
      toEndpoint,
      kind: String(value.kind ?? 'data'),
      interface: String(value.interface ?? ''),
    }
  })
  return {
    chipSizeUm: {
      width: number(chip.width ?? chip.w ?? source.width_um),
      height: number(chip.height ?? chip.h ?? source.height_um),
    },
    instances,
    leaves: instances.filter((instance) => instance.children.length === 0),
    connections,
    coordinateSystem: object(source.coordinate_system ?? source.coordinateSystem),
    diagnostics: array(source.diagnostics),
    logicalBinding: object(source.logical_binding ?? source.logicalBinding),
    provenance: object(source.provenance),
  }
}

export function createBindingGroups(layout) {
  const groups = new Map()
  layout.leaves.forEach((instance, index) => {
    if (!instance.logicalUnitRef) return
    const group = groups.get(instance.logicalUnitRef) || { path: instance.logicalUnitRef, indexes: [], instances: [] }
    group.indexes.push(index)
    group.instances.push(instance)
    groups.set(instance.logicalUnitRef, group)
  })
  for (const group of groups.values()) {
    let weight = 0
    let x = 0
    let y = 0
    for (const instance of group.instances) {
      const area = Math.max(1, instance.rectUm.width * instance.rectUm.height)
      weight += area
      x += (instance.rectUm.x + instance.rectUm.width / 2) * area
      y += (instance.rectUm.y + instance.rectUm.height / 2) * area
    }
    group.centroidUm = { x: x / weight, y: y / weight }
  }
  return groups
}

export const READINESS = Object.freeze({
  unknown: { label: 'Unknown', color: 0x667085, height: 0.22 },
  booting: { label: 'Booting', color: 0xe0a43b, height: 0.32 },
  ready: { label: 'Ready', color: 0x39c77a, height: 0.28 },
  active: { label: 'Active', color: 0x25b8d9, height: 0.48 },
  blocked: { label: 'Blocked', color: 0xd06be8, height: 0.62 },
  fault: { label: 'Fault', color: 0xf05252, height: 0.68 },
})

export function normalizeReadinessEntry(raw) {
  if (raw == null) return { state: 'unknown', progress: null, reason: '', blockedOn: '' }
  const value = typeof raw === 'number' ? { progress: raw } : object(raw)
  const progressValue = value.progress ?? value.percent ?? value.completion
  const progress = progressValue == null ? null : Math.max(0, Math.min(1, number(progressValue) > 1 ? number(progressValue) / 100 : number(progressValue)))
  const named = String(value.runtime_state ?? value.runtimeState ?? value.state ?? value.status ?? '').toLowerCase()
  const testStatus = String(value.test_status ?? value.testStatus ?? '').toLowerCase()
  const reason = String(value.reason ?? value.message ?? '')
  const blockedOn = String(value.blocked_on ?? value.blockedOn ?? '')
  let state = 'unknown'
  if (value.fault || value.error || ['fault', 'failed', 'error'].includes(named)) state = 'fault'
  else if (blockedOn || ['blocked', 'stall', 'stalled'].includes(named)) state = 'blocked'
  else if (['busy', 'active', 'running'].includes(named)) state = 'active'
  else if (['ready', 'complete', 'completed'].includes(named) || ['complete', 'completed'].includes(testStatus) || progress === 1) state = 'ready'
  else if (progress != null || ['booting', 'incomplete', 'initializing'].includes(named) || ['incomplete', 'partial'].includes(testStatus)) state = 'booting'
  return {
    state,
    progress,
    reason,
    blockedOn,
    ...(value.planned_tests != null ? { plannedTests: number(value.planned_tests) } : {}),
    ...(value.passing_tests != null ? { passingTests: number(value.passing_tests) } : {}),
    ...(testStatus ? { testStatus } : {}),
  }
}

export function normalizeReadiness(raw) {
  const root = object(raw)
  const source = object(root.components ?? root)
  return new Map(Object.entries(source).map(([key, entry]) => {
    const component = object(entry)
    const nested = component.readiness == null ? entry : object(component.readiness)
    const runtimeState = component.runtime_state ?? component.runtimeState
    return [key, normalizeReadinessEntry(runtimeState == null ? nested : { ...nested, runtime_state: runtimeState })]
  }))
}

export function readinessFor(instance, readiness) {
  const keys = [
    instance.logicalUnitRef,
    instance.bind?.path,
    instance.bind?.component_path,
    instance.bind?.componentPath,
    instance.bind?.logicalUnitRef,
    instance.id,
  ].filter(Boolean)
  for (const key of keys) if (readiness.has(String(key))) return readiness.get(String(key))
  return normalizeReadinessEntry(null)
}

export function normalizeEvents(raw) {
  const source = typeof raw === 'string'
    ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : array(raw)
  return source.map((item, index) => {
    const value = object(item)
    const attrs = object(value.attrs)
    const runtimeComponentPath = String(attrs.component_path ?? attrs.componentPath ?? value.component_path ?? '')
    const logicalUnitRef = String(attrs.logical_unit_ref ?? attrs.logicalUnitRef ?? value.logical_unit_ref ?? '')
    const targetPath = logicalUnitRef || runtimeComponentPath
    const sourcePath = String(attrs.source_logical_unit_ref ?? attrs.sourceLogicalUnitRef ?? value.source_logical_unit_ref ?? '')
    return {
      id: String(value.id ?? `event-${index}`),
      parentId: value.parent_id == null ? null : String(value.parent_id),
      scopeSeq: number(value.scope_seq, index),
      timestamp: number(value.timestamp, index),
      desc: String(value.desc ?? value.description ?? ''),
      data: object(value.data),
      runtimeComponentPath,
      logicalUnitRef,
      targetPath,
      sourcePath,
      transfer: attrs.transfer === true || Boolean(sourcePath),
      componentPath: targetPath,
      reason: String(attrs.reason ?? value.reason ?? value.data?.reason ?? ''),
      blockedOn: String(attrs.blocked_on ?? attrs.blockedOn ?? value.blocked_on ?? value.data?.blocked_on ?? value.data?.blockedOn ?? ''),
      duration: attrs.duration ?? value.duration ?? null,
      timestampUnit: String(attrs.timestamp_unit ?? attrs.timestampUnit ?? value.timestamp_unit ?? ''),
      synthetic: attrs.synthetic === true,
    }
  })
}
