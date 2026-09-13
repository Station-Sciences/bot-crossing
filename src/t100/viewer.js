import { T100ChipView } from './chip-view.js'
import { loadT100 } from './loader.js'
import { eventPlacement, formatSourceTimestamp, ReplayController } from './replay.js'
import { createBindingGroups } from './contracts.js'
import { bindingTargets, resolveThreadBinding } from './bindings.js'
import {
  unitPhaseLabel,
  unitPhaseColor,
  facetRows,
  attentionForUnit,
  indexUnits,
  connectionsForUnit,
} from './world.js'

const hex6 = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`

/** `t100.eic.bar0.vpu` reads as `vpu` in a 180px column; feed names pass through. */
const shortSubject = (id) => {
  const s = String(id || '')
  return s.includes('.') ? s.split('.').slice(-2).join('.') : s
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const href = (v) => (/^https:\/\/[^<>"']+$/i.test(String(v || '')) ? esc(v) : '')

const ago = (ms) => {
  if (!ms) return 'never'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const formatRate = (bytesPerSecond) => {
  const value = Number(bytesPerSecond)
  if (!Number.isFinite(value) || value <= 0) return 'bandwidth unknown'
  const units = [
    [1e12, 'TB/s'],
    [1e9, 'GB/s'],
    [1e6, 'MB/s'],
  ]
  const [scale, suffix] = units.find(([candidate]) => value >= candidate) || [1, 'B/s']
  const scaled = value / scale
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${suffix}`
}

/**
 * The T100 Work City panel. Owns the shared floorplan view and every DOM control:
 * a capability/physical layer switch, a connection filter, replay, an inspector
 * that opens a full provenance trail on any unit, and the Needs-Attention queue.
 *
 * It holds no selection state of its own — the SelectionStore is the single
 * source of truth, so a pick on the map, a click in the attention queue, and a
 * future thread→unit binding all drive the same highlight.
 */
export class T100Viewer {
  constructor({ scene, camera, rig, hud, selection, onBindingChange, onOpenThread, onNewConversation }) {
    this.rig = rig
    this.hud = hud
    this.selection = selection
    this.onBindingChange = onBindingChange
    this.onOpenThread = onOpenThread
    this.onNewConversation = onNewConversation
    this.threads = []
    this.threadBindings = {}
    this.chip = new T100ChipView(scene, camera)
    this.visible = false
    this._buildPanel()

    this.unsub = selection.subscribe((sel) => this._onSelection(sel))
  }

  _buildPanel() {
    const panel = document.createElement('section')
    panel.className = 't100-panel'
    panel.innerHTML = `
      <div class="t100-kicker">T100 Work City</div>
      <h2>Floorplan</h2>
      <p class="sub t100-provenance">Loading world model…</p>

      <div class="t100-layers" role="group" aria-label="Map layer">
        <button data-layer="capability" class="on">Capability</button>
        <button data-layer="physical">Physical</button>
      </div>

      <div class="t100-truth"></div>
      <div class="t100-link-legend">
        <span><i class="bulk"></i>bulk · width = log peak bandwidth</span>
        <span><i class="control"></i>control</span>
        <span><i class="unknown"></i>unknown / disputed</span>
      </div>

      <div class="t100-controls">
        <label>Connections
          <select data-role="connections" class="select" aria-label="Connection filter">
            <option value="selected" selected>Selected unit</option>
            <option value="all">All</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>Wiring
          <select data-role="wiring" class="select" aria-label="Connection source">
            <option value="manifest" selected>Manifest</option>
            <option value="floorplan">Floorplan ports</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label>Replay
          <select data-role="replay" class="select" aria-label="Replay selection">
            <option value="synthetic">Synthetic placed flow</option>
            <option value="golden">Golden XPU (unplaced)</option>
          </select>
        </label>
        <button class="btn primary" data-action="play">Play</button>
        <button class="btn" data-action="reset">Reset</button>
        <select data-role="speed" class="select" aria-label="Replay speed">
          <option value=".5">0.5x</option><option value="1" selected>1x</option>
          <option value="2">2x</option><option value="4">4x</option>
        </select>
      </div>
      <div class="t100-replay-notice"></div>
      <div class="t100-progress">Loading…</div>

      <div class="t100-inspector"><h3>Inspector</h3><p class="sub">Point at a district, or pick from Needs attention.</p></div>

      <div class="t100-agents"><h3>Local agents</h3><div class="t100-agent-actions"></div><div class="t100-agent-list"><p class="sub">Waiting for local thread scan…</p></div></div>

      <div class="t100-attention"><h3>Needs attention</h3><div class="t100-attention-list"></div></div>`

    this.hud.$('.side').appendChild(panel)
    this.panel = panel
    this.provenanceEl = panel.querySelector('.t100-provenance')
    this.truth = panel.querySelector('.t100-truth')
    this.inspector = panel.querySelector('.t100-inspector')
    this.agentActions = panel.querySelector('.t100-agent-actions')
    this.agentList = panel.querySelector('.t100-agent-list')
    this.attentionList = panel.querySelector('.t100-attention-list')
    this.replayNotice = panel.querySelector('.t100-replay-notice')
    this.progress = panel.querySelector('.t100-progress')
    this.playButton = panel.querySelector('[data-action="play"]')

    for (const btn of panel.querySelectorAll('.t100-layers button')) {
      btn.addEventListener('click', () => this.setLayer(btn.dataset.layer))
    }
    panel.querySelector('[data-role="connections"]').addEventListener('change', (e) => {
      this.chip.setConnectionFilter(e.target.value)
    })
    panel.querySelector('[data-role="wiring"]').addEventListener('change', (e) => {
      this.chip.setConnectionSource(e.target.value)
    })
    panel.querySelector('[data-role="replay"]').addEventListener('change', (e) => this._selectReplay(e.target.value))
    panel.querySelector('[data-role="speed"]').addEventListener('change', (e) => this.replay?.setSpeed(e.target.value))
    this.playButton.addEventListener('click', () => {
      if (!this.replay) return
      this.replay.playing = !this.replay.playing
      this._syncControls()
    })
    panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      if (!this.replay) return
      this.replay.reset()
      this.chip.applyReplay([], this.replay.state)
      this._syncControls()
    })
  }

  async load() {
    const data = await loadT100()
    this.world = data.world
    this.layout = data.layout
    this.readiness = data.readiness
    this.replays = data.replays
    this.unitsById = indexUnits(this.world)
    this.bindingGroups = createBindingGroups(this.layout)
    this.chip.setWorld(this.world, this.layout, this.readiness)

    const p = this.world.provenance || {}
    const layoutProv = p.layout || {}
    const src = layoutProv.source === 'live' ? 'live' : 'bundled snapshot'
    this.provenanceEl.innerHTML =
      `${esc(this.world.placement.accuracy || 'prototype')} · floorplan ${esc(src)}` +
      `${layoutProv.revision ? ` @ ${esc(layoutProv.revision)}` : ''} · ${esc(ago(layoutProv.observedAt))}` +
      `${this.world.provenance?.bridgeError ? ' · scorer fallback' : ''}`

    const c = this.world.counts
    this.truth.innerHTML = `
      <b>World model</b>
      <span>${c.units} units · ${c.leaves} leaves · ${c.boundLeaves} bound</span>
      <span>${c.rungsMet}/${c.rungs} rungs met at ${esc(this.world.fidelity.gate)} · ${
        this.layout.instances.length
      } SSoT physical hierarchy nodes</span>
      <span>${c.unplaced} units still lack a physical SSoT binding</span>
      <span>manifest validated: ${this.world.placement.manifestValidated ? 'yes' : 'no'} · ${
        this.world.team?.items?.length || 0
      } joined work items</span>
      <span>placement checks: ${this.world.placement.validation?.valid ? 'pass' : 'fail'} · ${
        this.world.placement.validation?.warnings?.length || 0
      } source warning(s)</span>`

    this._renderAttention()
    this._selectReplay('synthetic')
    this._renderInspector(null)
    this._renderAgents()
  }

  /**
   * Local-only thread metadata and confirmed identities. No transcript content is
   * copied into the world read model or any remote adapter.
   */
  setLocalAgents(threads, bindings) {
    this.threads = Array.isArray(threads) ? [...threads] : []
    this.threadBindings = bindings && typeof bindings === 'object' ? bindings : {}
    this._renderAgents()
  }

  setLayer(layer) {
    for (const btn of this.panel.querySelectorAll('.t100-layers button')) {
      btn.classList.toggle('on', btn.dataset.layer === layer)
    }
    this.chip.setLayer(layer)
    this.selection?.setLayer(layer)
  }

  _selectReplay(name) {
    if (!this.replays?.[name]) return
    this.replayName = name
    this.events = this.replays[name]
    this.replay = new ReplayController(this.events)
    this.chip.applyReplay([], this.replay.state)
    this.replayNotice.innerHTML =
      name === 'synthetic'
        ? '<b>SYNTHETIC VISUAL DEMO</b><span>Illustrative only — not measured or model-derived.</span>'
        : '<b>LOGICALLY VALID · PHYSICALLY UNPLACED</b><span>Exact golden XPU trace; no XPU floorplan binding exists.</span>'
    this._syncControls()
  }

  setVisible(visible) {
    this.visible = visible
    this.chip.setVisible(visible)
    if (visible && this.world) this.chip.frame(this.rig)
  }

  // ── selection ────────────────────────────────────────────────────────────────
  /** Called by main.js on a pick in the T100 view. */
  pickAt(ndcX, ndcY, { commit }) {
    const hit = this.chip.pick(ndcX, ndcY)
    const unitId = hit?.unitId || null
    if (commit) {
      if (unitId) this.selection.selectUnit(unitId, { source: 't100', instanceId: hit.instance?.id || null })
      else this.selection.clear('t100')
    } else {
      this.chip.hoverUnit(unitId)
      if (!this.selection.get().unitId) this._renderInspector(unitId ? this.unitsById.get(unitId) : null, { hover: true })
    }
    return hit
  }

  _onSelection(sel) {
    if (!this.world) return
    this.chip.selectUnit(sel.unitId)
    this._renderInspector(sel.unitId ? this.unitsById.get(sel.unitId) : null)
    this._renderAgents()
  }

  _renderInspector(unit, { hover = false } = {}) {
    if (!unit) {
      this.inspector.innerHTML = '<h3>Inspector</h3><p class="sub">Point at a district, or pick from Needs attention.</p>'
      return
    }
    const phase = unitPhaseLabel(unit)
    const ssotHomes = this.chip.ssotItemsForUnit(unit.id)
    const placement = unit.placement.bound
      ? `physical bind · ${unit.placement.leafCount} ${unit.placement.leafCount === 1 ? 'leaf' : 'leaves'}`
      : ssotHomes.length
        ? `SSoT super-unit association · ${ssotHomes.map((item) => esc(item.label)).join(', ')}`
        : `unplaced — ${esc(unit.placement.unboundReason)}`
    const facets = facetRows(unit)
      .map(
        (f) =>
          `<div class="t100-facet t100-facet-${esc(f.state)}"><span class="fk">${esc(f.key)}</span>` +
          `<span class="fs">${esc(f.state)}</span><span class="fe">${esc(f.evidenceClass)}</span></div>`,
      )
      .join('')
    const rungs = (unit.rungs || []).slice(0, 8).map((r) => `<span class="t100-rung">${esc(r)}</span>`).join('')
    const conns = connectionsForUnit(this.world, unit.id)
    const attention = attentionForUnit(this.world, unit.id)
    const tests = unit.tests || {}
    const testLine =
      tests.planned == null
        ? 'no plan'
        : `${tests.passing ?? 0}/${tests.planned} passing · ${tests.evidenceClass}`
    const work = (unit.work || [])
      .map((item) => {
        const label = `${item.source} ${item.id} · ${item.state || 'unknown'}`
        const title = `${esc(item.title)}${item.actor ? ` · ${esc(item.actor)}` : ''}`
        const safe = href(item.url)
        return `<div class="t100-work-item"><span>${esc(label)}</span>${
          safe ? `<a href="${safe}" target="_blank" rel="noreferrer">${title}</a>` : `<b>${title}</b>`
        }</div>`
      })
      .join('')
    const interfaces = conns
      .slice(0, 8)
      .map((connection) => {
        const spec = connection.interfaceSpec
        const direction = connection.endpoints
          ? `${connection.endpoints.from.role || '?'} → ${connection.endpoints.to.role || '?'}`
          : 'direction unknown'
        const perf = connection.performance || {}
        const latency = perf.latency || {}
        const latencyText = latency.typicalNs
          ? `${latency.typicalNs} ns typical`
          : latency.minNs || latency.maxNs
            ? `${latency.minNs || '?'}–${latency.maxNs || '?'} ns`
            : latency.cyclesMin || latency.cyclesMax
              ? `${latency.cyclesMin || '?'}–${latency.cyclesMax || '?'} cycles`
              : 'latency unknown'
        return `<details class="t100-interface">
          <summary>${esc(connection.type || connection.interface || 'untyped')} · ${esc(connection.label || '')}</summary>
          <div>${esc(connection.from)} → ${esc(connection.to)}</div>
          <div class="sub">${esc(direction)} · ${spec ? `${spec.channels} channels · ${spec.signals} signals · ${spec.status || 'status unknown'}` : 'spec unavailable'}</div>
          <div class="t100-performance"><b>${esc(formatRate(perf.peakBytesPerSecond))}</b> · ${esc(latencyText)} · ${esc(perf.status || 'unknown')}</div>
          ${perf.derivation ? `<div class="sub">${esc(perf.derivation)}${perf.scope ? ` · ${esc(perf.scope)}` : ''}</div>` : ''}
          ${perf.note ? `<div class="sub">${esc(perf.note)}</div>` : ''}
          ${
            spec?.gaps?.length
              ? `<div class="sub">${spec.gaps.length} SSoT gap(s) · ${spec.gaps.filter((gap) => gap.blocking).length} blocking</div>`
              : ''
          }
        </details>`
      })
      .join('')

    this.inspector.innerHTML = `
      <h3>${esc(unit.diagram || unit.unit)}${hover ? ' <span class="sub">(hover)</span>' : ''}</h3>
      <div class="t100-phase">
        <i class="dot" style="background:${hex6(unitPhaseColor(unit))}"></i>${esc(phase)}
      </div>
      <dl class="t100-fields">
        <dt>Unit</dt><dd>${esc(unit.unit)}</dd>
        <dt>Canonical id</dt><dd>${esc(unit.id)}</dd>
        <dt>Owner</dt><dd>${esc(unit.owner || '— unowned')}</dd>
        <dt>Placement</dt><dd>${placement}</dd>
        <dt>Tests</dt><dd>${esc(testLine)}</dd>
      </dl>
      <div class="t100-facets">${facets}</div>
      ${rungs ? `<div class="t100-rungs"><b>Rungs</b> ${rungs}</div>` : ''}
      ${conns.length ? `<div class="t100-conns"><b>Interfaces</b> ${conns.length} connection(s)${interfaces}</div>` : ''}
      ${work ? `<div class="t100-work"><b>Joined work</b>${work}</div>` : ''}
      ${
        attention.length
          ? `<div class="t100-unit-attention">${attention
              .map((a) => `<div class="t100-att t100-att-${esc(a.kind)}">${esc(a.reason)} <span class="ec">${esc(a.evidenceClass)}</span></div>`)
              .join('')}</div>`
          : ''
      }
      ${unit.desc ? `<p class="sub">${esc(unit.desc)}</p>` : ''}
      <p class="sub t100-freshness">${unit.freshness?.stale ? 'stale data' : 'fresh'} · scorer ${esc(ago(unit.freshness?.scorer?.observedAt))}</p>`
  }

  _renderAttention() {
    const items = (this.world.attention || []).slice(0, 12)
    if (!items.length) {
      this.attentionList.innerHTML = '<p class="sub">Nothing flagged.</p>'
      return
    }
    this.attentionList.innerHTML = items
      .map(
        (a) =>
          `<button class="t100-att-item t100-att-${esc(a.kind)}" data-unit="${esc(a.subject)}">` +
          `<span class="k">${esc(a.kind)}</span><span class="s">${esc(shortSubject(a.subject))}</span>` +
          `<span class="r">${esc(a.reason)}</span>` +
          `<span class="ec">${esc(a.evidenceClass)}</span></button>`,
      )
      .join('')
    for (const btn of this.attentionList.querySelectorAll('.t100-att-item')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.unit
        if (this.unitsById.has(id)) this.selection.selectUnit(id, { source: 'attention' })
      })
    }
  }

  _renderAgents() {
    if (!this.agentList || !this.world) return
    const selectedTarget = this.selection?.get().unitId || ''
    const targets = bindingTargets(this.world)
    const live = this.threads
      .filter((thread) => !thread.archived)
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0))

    if (selectedTarget) {
      this.agentActions.innerHTML = `
        <span class="sub">Start at ${esc(shortSubject(selectedTarget))}</span>
        <button class="btn" data-new="cursor">Cursor</button>
        <button class="btn" data-new="claude-code">Claude</button>
        <button class="btn" data-new="codex">Codex</button>`
      for (const button of this.agentActions.querySelectorAll('[data-new]')) {
        button.addEventListener('click', () => this.onNewConversation?.(selectedTarget, button.dataset.new))
      }
    } else {
      this.agentActions.innerHTML = '<span class="sub">Select a unit to anchor new conversations.</span>'
    }

    const rows = []
    for (const thread of live) {
      const binding = this.threadBindings[thread.id]
      const resolved = resolveThreadBinding(thread, this.world, { explicit: binding?.primary })
      const primary = binding?.primary || ''
      const secondary = Array.isArray(binding?.secondary) ? binding.secondary : []
      const candidate = resolved.candidates.find((item) => item.unitId !== primary) || resolved.candidates[0] || null
      const touchesSelection = selectedTarget && (primary === selectedTarget || secondary.includes(selectedTarget))
      const suggestedHere = selectedTarget && candidate?.unitId === selectedTarget
      if (selectedTarget ? !touchesSelection && !suggestedHere : !primary && !candidate) continue
      rows.push({ thread, binding, primary, secondary, candidate, touchesSelection })
      if (rows.length >= 12) break
    }

    if (!rows.length) {
      this.agentList.innerHTML = `<p class="sub">${
        selectedTarget ? 'No local thread is linked or suggested for this unit.' : 'No unit-linked local threads yet.'
      }</p>`
      return
    }

    const options = targets
      .map((target) => `<option value="${esc(target.id)}">${esc(target.label)}${target.kind === 'workstream' ? ' · workstream' : ''}</option>`)
      .join('')
    this.agentList.innerHTML = rows
      .map(({ thread, primary, secondary, candidate, touchesSelection }) => {
        const reason = primary
          ? `confirmed · ${esc(shortSubject(primary))}${secondary.length ? ` · also ${secondary.map(shortSubject).join(', ')}` : ''}`
          : candidate
            ? `${esc(candidate.reason)} · suggestion`
            : 'unassigned'
        return `
          <article class="t100-agent-row" data-thread="${esc(thread.id)}">
            <div class="t100-agent-head"><i class="pip ${thread.running ? 'live' : ''}"></i>
              <span class="title">${esc(thread.title || 'Untitled thread')}</span>
              <span class="harness">${esc(thread.harnessName || thread.harness || '')}</span>
            </div>
            <div class="sub">${reason}</div>
            <div class="t100-agent-controls">
              <button class="btn" data-open ${thread.canOpen === false ? 'disabled' : ''}>Open</button>
              <select class="select" data-target aria-label="Assign thread to work target">
                <option value="">Unassigned</option>${options}
              </select>
              <button class="btn primary" data-confirm>${primary ? 'Reassign' : 'Confirm'}</button>
              ${
                selectedTarget && primary && primary !== selectedTarget
                  ? `<button class="btn" data-link="${esc(selectedTarget)}">${
                      secondary.includes(selectedTarget) ? 'Unlink here' : 'Also link here'
                    }</button>`
                  : ''
              }
              ${touchesSelection && primary === selectedTarget ? '<span class="t100-anchor">primary</span>' : ''}
            </div>
          </article>`
      })
      .join('')

    rows.forEach(({ thread, primary, secondary, candidate }) => {
      const row = [...this.agentList.querySelectorAll('.t100-agent-row')].find((el) => el.dataset.thread === thread.id)
      if (!row) return
      const select = row.querySelector('[data-target]')
      select.value = primary || candidate?.unitId || ''
      row.querySelector('[data-open]').addEventListener('click', () => this.onOpenThread?.(thread))
      row.querySelector('[data-confirm]').addEventListener('click', () => {
        const next = select.value
        this.onBindingChange?.(
          thread.id,
          next ? { primary: next, secondary: secondary.filter((id) => id !== next), confirmedAt: Date.now() } : null,
        )
      })
      row.querySelector('[data-link]')?.addEventListener('click', (event) => {
        const target = event.currentTarget.dataset.link
        const nextSecondary = secondary.includes(target)
          ? secondary.filter((id) => id !== target)
          : [...new Set([...secondary, target])]
        this.onBindingChange?.(thread.id, { primary, secondary: nextSecondary, confirmedAt: Date.now() })
      })
    })
  }

  _syncControls() {
    if (!this.replay) return
    this.playButton.textContent = this.replay.playing ? 'Pause' : 'Play'
    const sourceEvent = this.replay.state.lastEvent || this.replay.events[0]
    this.progress.textContent = `${this.replay.index}/${this.replay.events.length} events · source t=${formatSourceTimestamp(sourceEvent)} · 650 ms/event`
  }

  update(dt, elapsed) {
    if (!this.visible || !this.replay) return
    const applied = this.replay.update(dt)
    if (applied.length) this.chip.applyReplay(applied, this.replay.state)
    this.chip.update(dt, elapsed, this.rig.distance)
    this._syncControls()
  }
}
