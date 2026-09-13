const byReplayOrder = (a, b) =>
  a.timestamp - b.timestamp || a.scopeSeq - b.scopeSeq || a.id.localeCompare(b.id)

export function orderEvents(events) {
  return [...events].sort(byReplayOrder)
}

export function deriveTransferEndpoints(event, bindingGroups) {
  if (!event.transfer || !event.sourcePath || !event.targetPath) return null
  const source = bindingGroups.get(event.sourcePath)
  const target = bindingGroups.get(event.targetPath)
  if (!source || !target) return null
  return {
    sourcePath: event.sourcePath,
    targetPath: event.targetPath,
    fromUm: { ...source.centroidUm },
    toUm: { ...target.centroidUm },
  }
}

export function eventPlacement(event, bindingGroups) {
  const targetPlaced = bindingGroups.has(event.targetPath)
  const sourcePlaced = !event.sourcePath || bindingGroups.has(event.sourcePath)
  return {
    placed: targetPlaced && sourcePlaced,
    targetPlaced,
    sourcePlaced,
    label: targetPlaced && sourcePlaced ? 'placed activity' : 'unplaced activity — no floorplan binding',
  }
}

export function initialReplayState() {
  return { components: new Map(), applied: [], lastEvent: null }
}

export function applyEvent(state, event) {
  const components = new Map(state.components)
  const targetPath = event.targetPath || event.logicalUnitRef || event.componentPath || event.runtimeComponentPath
  const previous = components.get(targetPath) || {}
  const text = `${event.desc} ${event.data?.state ?? ''}`.toLowerCase()
  const blockedOn = String(event.blockedOn ?? event.data?.blocked_on ?? event.data?.blockedOn ?? '')
  const reason = String(event.reason ?? event.data?.reason ?? '')
  let activity = 'active'
  if (blockedOn || /\b(block|stall|wait)\b/.test(text)) activity = 'blocked'
  else if (/\b(fault|fail|error)\b/.test(text)) activity = 'fault'
  else if (/\b(complete|ready|done)\b/.test(text)) activity = 'ready'
  if (targetPath) {
    components.set(targetPath, {
      ...previous,
      activity,
      blockedOn,
      reason,
      runtimeComponentPath: event.runtimeComponentPath,
      lastEventId: event.id,
      timestamp: event.timestamp,
      timestampUnit: event.timestampUnit,
      duration: event.duration,
      synthetic: event.synthetic,
    })
  }
  return {
    components,
    applied: [...state.applied, event.id],
    lastEvent: event,
  }
}

export function formatSourceTimestamp(event) {
  if (!event) return 'not started'
  return `${event.timestamp} ${event.timestampUnit || 'source units'}`
}

const REPLAY_EVENT_GAP_MS = 650

export class ReplayController {
  constructor(events) {
    this.events = orderEvents(events)
    this.speed = 1
    this.playing = false
    this.reset()
  }

  reset() {
    this.index = 0
    this.playbackMs = 0
    this.state = initialReplayState()
    this.playing = false
    return this.state
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Number(speed) || 1)
  }

  update(dt) {
    if (!this.playing || !this.events.length) return []
    this.playbackMs += dt * 1000 * this.speed
    const applied = []
    while (this.index < this.events.length && this.index * REPLAY_EVENT_GAP_MS <= this.playbackMs) {
      const event = this.events[this.index++]
      this.state = applyEvent(this.state, event)
      applied.push(event)
    }
    if (this.index >= this.events.length) this.playing = false
    return applied
  }
}
