const array = (value) => (Array.isArray(value) ? value : [])

export const MAX_FLOORPLAN_LOD = 6

/**
 * Camera distance selects how much of the authored physical hierarchy is
 * visible. It never changes geometry or creates placement.
 */
export function floorplanLodForDistance(distance) {
  const value = Number(distance)
  if (!Number.isFinite(value) || value > 48) return 0
  if (value > 34) return 1
  if (value > 24) return 2
  if (value > 16) return 3
  if (value > 10) return 4
  if (value > 6) return 5
  return 6
}

const humanize = (value) => String(value || '')
  .replace(/\[\d+\]$/, '')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase())

/**
 * Resolve one visible, non-overlapping cut through the SSoT placement tree.
 * An aggregate is replaced by its children only at its authored expansion LOD.
 */
export function physicalLodItems(layout, lod) {
  const level = Math.max(0, Math.min(MAX_FLOORPLAN_LOD, Number(lod) || 0))
  const instances = array(layout?.instances)
  const byId = new Map(instances.map((instance) => [instance.id, instance]))
  const roots = instances.filter((instance) => !instance.parent || !byId.has(instance.parent))
  const logicalMemo = new Map()

  const logicalUnitsFor = (instance) => {
    if (logicalMemo.has(instance.id)) return logicalMemo.get(instance.id)
    const ids = new Set(array(instance.display?.logicalUnits).filter(Boolean))
    if (instance.logicalUnitRef) ids.add(instance.logicalUnitRef)
    for (const childId of array(instance.children)) {
      const child = byId.get(childId)
      if (child) for (const id of logicalUnitsFor(child)) ids.add(id)
    }
    const result = [...ids]
    logicalMemo.set(instance.id, result)
    return result
  }

  const result = []
  const visit = (instance) => {
    if (instance.display?.hidden) return
    const children = array(instance.children).map((id) => byId.get(id)).filter(Boolean)
    const expandAt = instance.display?.expandAtLod
    const expands = children.length > 0 && (expandAt == null || level >= expandAt)
    if (expands) {
      for (const child of children) visit(child)
      return
    }

    const logicalUnitIds = logicalUnitsFor(instance)
    const requestedPrimary = instance.display?.primaryLogicalUnit
    const primaryUnitId = requestedPrimary && logicalUnitIds.includes(requestedPrimary)
      ? requestedPrimary
      : logicalUnitIds[0] || ''
    result.push({
      instance,
      rectUm: instance.rectUm,
      label: instance.display?.label || humanize(instance.tile || instance.id.split('.').at(-1)),
      logicalUnitIds,
      primaryUnitId,
      aggregate: children.length > 0,
    })
  }

  for (const root of roots) visit(root)
  return result
}
