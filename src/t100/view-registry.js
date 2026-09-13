/**
 * Shared view + selection plumbing for Bot Crossing.
 *
 * The plan asks for one selected Unit to drive every projection: pick VPU on the
 * capability layer and the physical layer highlights the same silicon; pick an
 * unplaced unit and both agree it has no rectangle. That only works if selection
 * lives in one place both layers subscribe to, rather than each view keeping its
 * own idea of what is selected.
 *
 * Both classes here are deliberately framework-free (no three, no DOM) so the
 * selection contract is testable under node and cannot drift as the renderer
 * changes underneath it.
 */

/**
 * The one selection everything shares. A selection is a *logical unit* first —
 * geography is a projection of it — with an optional physical instance for when
 * the user clicked a specific leaf.
 */
export class SelectionStore {
  constructor() {
    this.state = { unitId: null, instanceId: null, layer: 'capability', source: null }
    this.subs = new Set()
  }

  get() {
    return { ...this.state }
  }

  subscribe(fn) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  _emit() {
    const snapshot = this.get()
    for (const fn of this.subs) fn(snapshot)
  }

  /** Select a logical unit. `source` records who asked, so a view can ignore its own echo. */
  selectUnit(unitId, { source = 'ui', instanceId = null } = {}) {
    const id = unitId || null
    if (this.state.unitId === id && this.state.instanceId === (instanceId || null)) return
    this.state = { ...this.state, unitId: id, instanceId: instanceId || null, source }
    this._emit()
  }

  /** Select a physical instance; its logical owner comes along if known. */
  selectInstance(instanceId, unitId = null, { source = 'ui' } = {}) {
    const inst = instanceId || null
    if (this.state.instanceId === inst && this.state.unitId === (unitId || this.state.unitId)) return
    this.state = { ...this.state, instanceId: inst, unitId: unitId || this.state.unitId, source }
    this._emit()
  }

  setLayer(layer) {
    if (this.state.layer === layer) return
    this.state = { ...this.state, layer, source: 'layer' }
    this._emit()
  }

  clear(source = 'ui') {
    if (!this.state.unitId && !this.state.instanceId) return
    this.state = { ...this.state, unitId: null, instanceId: null, source }
    this._emit()
  }
}

/**
 * A tiny registry of top-level views (Colony, T100). One is active at a time; the
 * previous one is deactivated first. Views implement an optional lifecycle:
 *   { id, label, activate(), deactivate(), update(dt, elapsed) }
 */
export class ViewRegistry {
  constructor() {
    this.views = new Map()
    this.activeId = null
    this.subs = new Set()
  }

  register(view) {
    if (!view || !view.id) throw new Error('a view needs an id')
    this.views.set(view.id, view)
    if (!this.activeId) this.activeId = view.id
    return view
  }

  list() {
    return [...this.views.values()].map((v) => ({ id: v.id, label: v.label || v.id }))
  }

  has(id) {
    return this.views.has(id)
  }

  active() {
    return this.views.get(this.activeId) || null
  }

  subscribe(fn) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  setActive(id) {
    if (!this.views.has(id) || id === this.activeId) return
    this.views.get(this.activeId)?.deactivate?.()
    this.activeId = id
    this.views.get(id)?.activate?.()
    for (const fn of this.subs) fn(id)
  }

  update(dt, elapsed) {
    this.active()?.update?.(dt, elapsed)
  }
}
