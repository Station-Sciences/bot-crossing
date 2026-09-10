import * as THREE from 'three'
import './ui/styles.css'
import { DEFAULT_PRESET, Settings, hasStoredSettings } from './core/settings.js'
import { Engine } from './core/engine.js'
import { CameraRig } from './core/camera.js'
import { Colony, STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress } from './game/colony.js'
import { Hud } from './ui/hud.js'
import { PLANETS } from './world/planet.js'
import { DECK_TOP, PLOT_CELL, hexToWorld, worldToHex } from './world/plots.js'
import { moveIsValid } from './world/plot-move.js'
import { loadKit } from './world/kit.js'
import { crewRig, loadCrew } from './agents/crew.js'
import { TIMES } from './world/sky.js'
import {
  fetchThreads,
  fetchState,
  saveState,
  openThread,
  newSession,
  revealFolder,
} from './game/api.js'
import { hideProject, hiddenCatalog, unhideProject } from './game/hidden-projects.js'

/**
 * Boot and the outer game loop.
 *
 * The one interesting piece of orchestration here is the archive round trip. The harness
 * owns the session records; the colony owns nothing but its own list of what you archived,
 * and that list is written by exactly one writer — this page — so a save from a stale tab
 * can never silently drop an archive. Everything else is wiring.
 */

const POLL_MS = 15000
const app = document.getElementById('app')

app.insertAdjacentHTML(
  'beforeend',
  `<div class="boot"><div class="inner">
     <h1>Bot Crossing</h1>
     <p>Scanning for agent threads…</p>
     <div class="bar"><i></i></div>
   </div></div>`
)

const settings = new Settings()
if (!hasStoredSettings()) settings.applyPreset(DEFAULT_PRESET)

const engine = new Engine(settings).mount(app)
const rig = new CameraRig(engine.camera, engine.canvas, settings)
const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {} }
let threads = []
/** Last legend built for the bottom bar, kept so the open zone's chip can light up between polls. */
let legendProjects = []
/** The zone layout as last written to the colony file, so an unchanged map is not re-saved. */
let lastLayout = ''
let selectedId = null
/** Which zone's sidebar is open. A repo, not a thread — they outlive the threads on them. */
let selectedProject = null
let hoverId = null
let statusCursor = 0
let pendingSave = 0
const hoverGround = new THREE.Vector3()

// ── actions the HUD can trigger ────────────────────────────────────────────────────────

const actions = {
  resetView: () => rig.resetView(),

  screenshot: () => {
    // Render one more frame, then read the buffer before the compositor clears it — the
    // alternative is preserveDrawingBuffer, which costs a copy on every single frame.
    engine.renderFrame()
    const url = engine.canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `bot-crossing-${colony.planet.id}-${stamp()}.png`
    a.click()
    hud.toast('Screenshot saved')
  },

  /** Google Earth's auto-rotate: a slow sweep around whatever is centred. */
  toggleOrbit: () => {
    const on = rig.toggleOrbit()
    hud.hint(on ? 'Orbit mode on — drag or press O to stop' : 'Orbit mode off')
    return on
  },

  cyclePlanet: () => {
    const ids = Object.keys(PLANETS)
    const next = ids[(ids.indexOf(settings.get('planet')) + 1) % ids.length]
    settings.set('planet', next)
    hud.hint(`${PLANETS[next].name} — ${PLANETS[next].blurb}`)
  },

  cycleTime: () => {
    settings.set('autoTime', false)
    settings.set('clockTime', false)
    const current = settings.get('timeOfDay')
    // Step to the next named time *after* the current one, wrapping at midnight.
    const next = TIMES.find((t) => t.value > current + 0.005) || TIMES[0]
    settings.set('timeOfDay', next.value)
    hud.hint(next.label)
  },

  /** Fly to the next astronaut in a given state, cycling through them on repeat presses. */
  focusStatus: (status) => {
    const key = status === 'agents' ? null : status
    const pool = colony.astronauts.agents.filter((a) => (key ? a.status === key : true))
    if (!pool.length) {
      hud.hint(key ? `Nobody is ${(STATUS_LABEL[key] || key).toLowerCase()} right now` : 'No crew on the surface')
      return
    }
    pool.sort((a, b) => a.id.localeCompare(b.id))
    const agent = pool[statusCursor++ % pool.length]
    select(agent.id, { fly: true })
  },

  focusProject: (name) => {
    const plot = colony.plots.get(name)
    if (!plot) return
    rig.focus(plot.middle || plot.center, { distance: 30 })
  },

  /** The legend, and anything else that means "show me this repo". */
  pickProject: (name) => selectProject(name, { fly: true }),

  /** Back out of one repo to the list of all of them. The panel itself never leaves. */
  closeProject: () => {
    selectedProject = null
    select(null, {})
    syncProject()
  },

  select: (id) => select(id, {}),

  focusThread: (id) => select(id, { fly: true }),

  /**
   * A new thread in this repo. The desktop app opens an empty session with the folder as
   * its workspace — nothing here is resumed, and nothing is written to disk.
   */
  newConversation: async () => {
    const name = selectedProject
    const folder = name && pathForProject(name)
    if (!folder) {
      hud.toast('No folder on disk for that project', 'err')
      return
    }
    try {
      const harness = harnessForProject(name)
      await newSession(folder, harness)
      hud.toast(`New thread in ${name} — opening ${harnessLabel(harness)}`)
      // It lands as an astronaut walking down the ramp, once it has a record to scan.
      setTimeout(poll, 6000)
    } catch (err) {
      hud.toast(err.message || 'Could not start a thread there', 'err')
    }
  },

  revealProject: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await revealFolder(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not open that folder', 'err')
    }
  },

  /**
   * Stop a thread asking for you, without touching it.
   *
   * `unread` comes from the harness, and the harness only counts a thread as read when it is
   * focused *in its own app*. Answer one in a terminal, or read it over somebody's shoulder,
   * and it keeps its hand up forever. Marking it viewed here records when you looked; the
   * moment the thread does something newer than that it goes back to waving, which is the
   * behaviour you actually want and the reason this is a timestamp rather than a flag.
   */
  markViewed: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    state.viewedAt = { ...(state.viewedAt || {}), [thread.id]: Date.now() }
    queueSave()
    applyThreads(threads)
    hud.toast(`Marked ${thread.title.slice(0, 40)} as viewed`)
  },

  hideProject: () => {
    const name = selectedProject
    if (!name) return
    state.hiddenProjects = hideProject(state.hiddenProjects || [], name)
    queueSave()
    // If the open thread belonged to the repo that just left, nothing is selected any more.
    if (selectedId) {
      const thread = threads.find((t) => t.id === selectedId)
      if (thread?.project === name) select(null, {})
    }
    selectedProject = null
    applyThreads(threads)
    hud.toast(`Hidden ${name} — still in your harness, gone from the colony`)
  },

  unhideProject: (name) => {
    if (!name) return
    state.hiddenProjects = unhideProject(state.hiddenProjects || [], name)
    queueSave()
    applyThreads(threads)
    hud.toast(`Showing ${name} again`)
  },

  copyProjectPath: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await navigator.clipboard.writeText(folder)
      hud.toast('Path copied')
    } catch {
      // The async clipboard needs a permission this page does not always have — inside an
      // embedded preview, say. The old selection-based copy has no such gate.
      const copied = copyFallback(folder)
      hud.toast(copied ? 'Path copied' : 'Could not reach the clipboard', copied ? '' : 'err')
    }
  },

  openThread: async () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    try {
      await openThread(thread)
      colony.astronauts.celebrate(thread.id)
      hud.toast(`Opened in ${thread.harnessName || 'your harness'}`)
      // Opening is the thing that makes a thread no longer unread, so refresh shortly after.
      setTimeout(poll, 1800)
    } catch (err) {
      hud.toast(err.message || 'Could not open that thread', 'err')
    }
  },

  // Archiving is the colony's own bookkeeping and nothing else: the thread leaves the map and
  // the astronaut walks back to the ship. The harness's own records are never touched — see
  // `reconcileArchived` in server/api.mjs for why that stopped being worth doing.
  archiveThread: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    const foldedBefore = new Set(colony.dormantProjects || [])
    state.archived = [...new Set([...state.archived, thread.id])]
    state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
    queueSave()
    select(null, {})
    applyThreads(threads)
    // Retiring the last thread anybody has touched in a repo makes every thread left in it
    // dormant, and the whole zone folds away — sixty astronauts can leave the map on one
    // click. That is the setting working, but silently it reads as the colony breaking, so
    // it says which repo went and why.
    const folded = [...(colony.dormantProjects || [])].filter((n) => !foldedBefore.has(n))
    hud.toast(
      folded.length
        ? `Archived — ${folded.join(', ')} ${folded.length === 1 ? 'is' : 'are'} all quiet now, folded off the map`
        : 'Archived — heading home'
    )
    colony.ship.ping()
  },

  uiVisibility: (visible) => colony.setUiVisible(visible),

  // The card's bar is about the *thread*, not about how much of its building has risen —
  // those were the same number while construction was drawn by burying the structure.
  progressFor: (id) => {
    const thread = threads.find((t) => t.id === id)
    return thread ? transcriptProgress(thread) : 0
  },
}

const hud = new Hud(app, settings, actions)
// The sidebar is permanent, so the card beside an astronaut has a wall to stay clear of.
const sideWidth = () => (window.innerWidth <= 820 ? 0 : 334)
hud.setSideWidth(sideWidth())
window.addEventListener('resize', () => hud.setSideWidth(sideWidth()))

// ── selection ─────────────────────────────────────────────────────────────────────────

function select(id, { fly = false } = {}) {
  selectedId = id
  const agent = id ? colony.agentFor(id) : null
  if (!agent) {
    selectedId = null
    colony.astronauts.setSelected(null)
    hud.setSelection(null, null)
    syncProject()
    return
  }
  colony.astronauts.setSelected(agent)
  const thread = threads.find((t) => t.id === id) || agent.thread
  hud.setSelection(agent, thread)
  // Picking somebody is also picking the zone they are standing on: the sidebar follows.
  if (thread?.project && colony.plots.has(thread.project)) selectedProject = thread.project
  syncProject()
  if (fly) {
    rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 26) })
  }
}

/** Open a zone's sidebar. Any selected astronaut from a different zone lets go. */
function selectProject(name, { fly = false } = {}) {
  if (!name || !colony.plots.has(name)) return
  selectedProject = name
  const current = threads.find((t) => t.id === selectedId)
  if (current && current.project !== name) select(null, {})
  else syncProject()
  if (fly) actions.focusProject(name)
}

/**
 * The repo folder behind a zone. Plots are keyed by the folder's *name*, which is all the
 * colony needs to draw one — the path itself lives on the threads, so it is read back off
 * them, taking the most common answer if two checkouts somehow share a basename.
 */
/** The human name for a harness id — every thread already carries its own. */
function harnessLabel(id) {
  for (const thread of colony.threads.values()) {
    if (thread.harness === id && thread.harnessName) return thread.harnessName
  }
  return 'your harness'
}

/**
 * Which harness a project's threads belong to, picked the same way its path is: the most
 * common answer among the threads standing there. A repo worked on from two harnesses gets
 * a new thread in whichever one it is mostly used from.
 */
function harnessForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name || !thread.harness) continue
    counts.set(thread.harness, (counts.get(thread.harness) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [id, n] of counts) {
    if (n <= bestCount) continue
    best = id
    bestCount = n
  }
  return best
}

function pathForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name) continue
    const dir = thread.projectPath || thread.cwd
    if (!dir) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [dir, n] of counts) {
    if (n <= bestCount) continue
    best = dir
    bestCount = n
  }
  return best
}

/** Push the open zone's current contents at the sidebar. Closes it if the zone is gone. */
function syncProject() {
  const hidden = hiddenCatalog(state.hiddenProjects || [], threads)
  // Folded-away repos are listed alongside the ones you hid by hand. Same principle: nothing
  // leaves the map without somewhere on screen saying where it went.
  const folded = hiddenCatalog([...(colony.dormantProjects || [])], threads)
  const plot = selectedProject ? colony.plots.get(selectedProject) : null
  if (!plot) {
    selectedProject = null
    hud.setProject(null)
    hud.setLegend(legendProjects, null, hidden, folded)
    return
  }
  const now = Date.now()
  const list = [...colony.threads.values()]
    .filter((thread) => thread.project === plot.name)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      worktree: thread.worktree,
      lastActivityAt: thread.lastActivityAt,
      status: statusFor(thread, now),
    }))
    // Whoever wants something first, then most recently touched — the same order of
    // importance the badges use above their heads.
    .sort((a, b) => {
      const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      return rank || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })

  hud.setProject({
    name: plot.name,
    accent: plot.accent,
    path: pathForProject(plot.name),
    threads: list,
    selectedId,
  })
  // The legend is the same selection seen from the bottom of the screen: keep it in step
  // here rather than only on the next poll.
  hud.setLegend(legendProjects, selectedProject, hidden, folded)
}

// ── pointer ───────────────────────────────────────────────────────────────────────────

/**
 * Where an astronaut is on screen, in CSS pixels, or null if it is behind the camera.
 *
 * Measured off the engine's own viewport rather than the canvas's bounding rect: this runs
 * every frame for the selected agent, and a layout read per frame to learn a number that
 * only changes on resize is the kind of thing that quietly costs a HUD its smoothness.
 */
const cardAnchor = new THREE.Vector3()
function screenOf(agent) {
  cardAnchor.set(agent.pos.x, agent.pos.y + 0.95, agent.pos.z).project(engine.camera)
  if (cardAnchor.z > 1) return null
  const { w, h } = engine.viewport
  return { x: (cardAnchor.x * 0.5 + 0.5) * w, y: (-cardAnchor.y * 0.5 + 0.5) * h }
}

function ndc(e) {
  const rect = engine.canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    aspect: rect.width / rect.height,
  }
}

engine.canvas.addEventListener('pointermove', (e) => {
  // Mid-drag the cursor is the grab hand and nothing else: running a pick every move event
  // while the world is being dragged would flicker the hover ring across the whole colony.
  if (rig.interacting) {
    engine.canvas.style.cursor = rig._mode === 'orbit' ? 'move' : 'grabbing'
    return
  }
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  hoverId = agent?.id ?? null
  colony.astronauts.setHover(agent)
  // Pointing at a quiet plot is what makes its name appear.
  const plot = plotUnder(e, p)
  colony.setHoveredPlot(plot)
  // A plot is grabbable as well as clickable, so it gets the hand rather than the finger:
  // 'pointer' promised only a click and hid the hold-to-drag entirely.
  engine.canvas.style.cursor = agent ? 'pointer' : 'grab'
})

/**
 * The zone under the cursor: its name plate first, then the deck itself. The plate is
 * hit-tested whether or not it is currently faded in — pointing at where a quiet project's
 * name would be is exactly what makes it appear.
 */
function plotUnder(e, p) {
  const label = colony.pickLabel(p.x, p.y)
  if (label) return label
  const ground = rig.groundPoint(e.clientX, e.clientY, hoverGround)
  return ground ? colony.plotAt(ground.x, ground.z) : null
}

// ── plot dragging ─────────────────────────────────────────────────────────────────────

/**
 * Hold-to-lift, on the same press that would otherwise pan. The two gestures share a
 * button, and the split is time: move within the hold and it was a pan all along, keep
 * still and the plot under the pointer picks up. Everything mid-carry is cosmetic — a
 * y-offset and a ghost of the footprint — and the real move is a single `movePlot` plus
 * one roster pass on the drop, so a cancelled drag has nothing to unwind but visuals.
 */
const HOLD_MS = 250
/** How high a carried zone floats. Enough to read as "picked up", not enough to occlude. */
const LIFT_Y = 1.1
const GHOST_VALID = 0x59d98c
const GHOST_INVALID = 0xd95f4f

const drag = {
  timer: 0, // pending long-press
  candidate: null, // repo name under the pressed pointer
  startX: 0,
  startY: 0,
  lifted: false,
  name: null,
  cells: null, // the zone's footprint at lift, root first
  grab: null, // which lattice cell the press landed on — the drag is relative to it
  dq: 0,
  dr: 0,
  valid: true,
  swallowClick: false,
  ghost: null, // { group, meshes, material, geometry }
  pendingThreads: null, // a poll that landed mid-carry, applied on the drop
}
const dragGround = new THREE.Vector3()

/** One flat hex per cell of the carried zone, shared geometry and material. */
function buildGhost(count) {
  const geometry = new THREE.CylinderGeometry(PLOT_CELL * 0.94, PLOT_CELL * 0.94, 0.05, 6)
  geometry.rotateY(Math.PI / 6) // flat-top, in phase with the lattice — see HEX_PHASE in plots.js
  const material = new THREE.MeshBasicMaterial({
    color: GHOST_VALID,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const group = new THREE.Group()
  const meshes = []
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geometry, material)
    meshes.push(mesh)
    group.add(mesh)
  }
  engine.scene.add(group)
  drag.ghost = { group, meshes, material, geometry }
}

function placeGhost() {
  const { meshes, material } = drag.ghost
  drag.cells.forEach((c, i) => {
    const { x, z } = hexToWorld(c.q + drag.dq, c.r + drag.dr)
    // Just proud of the deck, which is itself proud of the roughest terrain.
    meshes[i].position.set(x, DECK_TOP + 0.12, z)
  })
  material.color.setHex(drag.valid ? GHOST_VALID : GHOST_INVALID)
}

function disposeGhost() {
  if (!drag.ghost) return
  engine.scene.remove(drag.ghost.group)
  drag.ghost.geometry.dispose()
  drag.ghost.material.dispose()
  drag.ghost = null
}

function cancelHold() {
  clearTimeout(drag.timer)
  drag.timer = 0
  drag.candidate = null
}

function liftPlot() {
  drag.timer = 0
  const plot = colony.plots.get(drag.candidate)
  drag.candidate = null
  if (!plot) return // a poll rebuilt it out from under the hold — rare, and a lift of nothing
  drag.lifted = true
  drag.name = plot.name
  drag.cells = plot.cells
  // The drag is relative to the cell the press landed on, not to the zone's root: snapping
  // the root under a cursor that grabbed the far corner would jump the zone half its own
  // width on the first pixel of movement.
  const g = rig.groundPoint(drag.startX, drag.startY, dragGround)
  drag.grab = g ? worldToHex(g.x, g.z) : { ...plot.cells[0] }
  drag.dq = 0
  drag.dr = 0
  drag.valid = true
  // The pan gesture is already live under this press; `suppressed` is its escape hatch, and
  // it self-clears on pointerup, so the rest of the press belongs to carrying the plot.
  rig.suppressed = true
  colony.setPlotLift(drag.name, LIFT_Y)
  buildGhost(drag.cells.length)
  placeGhost()
  engine.canvas.style.cursor = 'grabbing'
}

/**
 * Put the drag down, applying the move or not. Either way this ends in the standard
 * "the map changed under the same roster" re-entry: `applyThreads` re-runs the roster pass,
 * whose signature diff rebuilds the moved plot on its new ground, recomputes navigation and
 * every crew site so the astronauts walk over rather than hammering at bare dirt, and whose
 * layout diff writes the move to the colony file.
 */
function settleDrag(apply) {
  colony.setPlotLift(drag.name, 0)
  disposeGhost()
  if (apply) colony.movePlot(drag.name, drag.dq, drag.dr)
  const pending = drag.pendingThreads
  drag.lifted = false
  drag.pendingThreads = null
  drag.name = null
  drag.cells = null
  drag.grab = null
  if (apply || pending) applyThreads(pending || threads)
  engine.canvas.style.cursor = 'grab'
}

engine.canvas.addEventListener('pointerdown', (e) => {
  if (drag.timer) cancelHold()
  if (drag.lifted) {
    // A second finger mid-carry is the start of a pinch, not a drop: put the zone back.
    settleDrag(false)
    drag.swallowClick = true
    return
  }
  // The camera reads these modifiers as "tilt and rotate" — that press is never a lift.
  if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return
  const p = ndc(e)
  if (colony.pick(p.x, p.y, p.aspect)) return // a press on an astronaut is a selection
  const plot = plotUnder(e, p)
  if (!plot) return
  drag.candidate = plot.name
  drag.startX = e.clientX
  drag.startY = e.clientY
  drag.timer = setTimeout(liftPlot, HOLD_MS)
})

// On window, like the camera's own listeners: a carry does not end at the canvas edge.
window.addEventListener('pointermove', (e) => {
  // The same 6px the camera's `wasClick` uses: past it this press was a pan all along.
  if (drag.timer && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) cancelHold()
  if (!drag.lifted) return
  if (!rig.groundPoint(e.clientX, e.clientY, dragGround)) return
  const cell = worldToHex(dragGround.x, dragGround.z)
  const dq = cell.q - drag.grab.q
  const dr = cell.r - drag.grab.r
  if (dq === drag.dq && dr === drag.dr) return
  drag.dq = dq
  drag.dr = dr
  drag.valid = moveIsValid(colony.visibleLayout(), drag.name, dq, dr)
  placeGhost()
})

window.addEventListener('pointerup', () => {
  if (drag.timer) cancelHold()
  if (drag.lifted) settleDrag(drag.valid && (drag.dq !== 0 || drag.dr !== 0))
  // Cleared after the canvas's own pointerup has run — bubbling order is what lets the
  // click handler still see it.
  drag.swallowClick = false
})

window.addEventListener('pointercancel', () => {
  if (drag.timer) cancelHold()
  if (drag.lifted) settleDrag(false)
})

// Pressing on an astronaut used to suppress the camera, on the theory that grabbing one
// should not also drag the world out from under it. But nothing is draggable *about* an
// astronaut — a press is only ever the start of a selection or the start of a pan — so all
// that suppression did was make the ground refuse to move whenever a drag happened to begin
// on top of somebody. Selection is decided on release instead, where `wasClick` already
// distinguishes a click from a drag.
engine.canvas.addEventListener('pointerup', (e) => {
  // A release that ends a lift is the end of a carry, not a click — even an unmoved one:
  // long-pressing a plot and thinking better of it should not also open its sidebar.
  if (e.button !== 0 || !rig.wasClick || drag.lifted || drag.swallowClick) return
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  if (agent) {
    select(agent.id, {})
    return
  }
  // Nobody there: a zone's deck or its name plate opens that repo's sidebar instead, and
  // bare ground puts everything down.
  const plot = plotUnder(e, p)
  if (plot) selectProject(plot.name, {})
  else {
    select(null, {})
    actions.closeProject()
  }
})

engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  colony.astronauts.setHover(null)
  colony.setHoveredPlot(null)
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  // Never steal keys from a field the user is actually typing in.
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return

  // ⌘\ (⌃\ elsewhere) dismisses the chrome, the same as H — the shortcut every editor
  // uses for its sidebar, and the one hand that is already on the keyboard.
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault()
    hud.toggleUi()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  switch (e.key) {
    case 'h':
    case 'H':
      hud.toggleUi()
      break
    case 's':
    case 'S':
      hud.toggleSettings()
      break
    case 'n':
    case 'N':
      actions.focusStatus('waiting')
      break
    case 'p':
    case 'P':
      actions.screenshot()
      break
    case 'l':
    case 'L':
      actions.cycleTime()
      break
    case 'o':
    case 'O':
      hud.setOrbit(actions.toggleOrbit())
      break
    case 'Tab':
      e.preventDefault()
      actions.cyclePlanet()
      break
    case '0':
      actions.resetView()
      hud.setOrbit(false)
      break
    case 'Enter':
      if (selectedId) actions.openThread()
      break
    case 'a':
    case 'A':
      if (selectedId) actions.archiveThread()
      break
    case 'v':
    case 'V':
      if (selectedId) actions.markViewed()
      break
    case 'c':
    case 'C':
      if (selectedProject) actions.newConversation()
      break
    case '?':
      hud.toggleHelp()
      break
    // Arrow keys nudge the view and +/- zoom, the same as Earth's keyboard.
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault()
      const step = rig.distance * 0.09
      const forward = new THREE.Vector3(Math.sin(rig.azimuth), 0, Math.cos(rig.azimuth))
      const right = new THREE.Vector3(forward.z, 0, -forward.x)
      if (e.key === 'ArrowUp') rig.desiredTarget.addScaledVector(forward, -step)
      if (e.key === 'ArrowDown') rig.desiredTarget.addScaledVector(forward, step)
      if (e.key === 'ArrowLeft') rig.desiredTarget.addScaledVector(right, -step)
      if (e.key === 'ArrowRight') rig.desiredTarget.addScaledVector(right, step)
      rig._clampTarget()
      rig.idleFor = 0
      break
    }
    case '+':
    case '=':
      rig.desiredDistance = Math.max(4, rig.desiredDistance * 0.82)
      break
    case '-':
    case '_':
      rig.desiredDistance = Math.min(150, rig.desiredDistance * 1.22)
      break
    // One step at a time, outward: the drag in hand, the thread, then the zone.
    case 'Escape':
      if (drag.lifted || drag.timer) {
        cancelHold()
        if (drag.lifted) {
          settleDrag(false)
          // The pointer is still down; the release that follows ends a dead gesture.
          drag.swallowClick = true
        }
      } else if (document.querySelector('.help.open')) hud.toggleHelp(false)
      else if (selectedId) select(null, {})
      else if (selectedProject) actions.closeProject()
      break
  }
})

// ── data ──────────────────────────────────────────────────────────────────────────────

function applyThreads(list) {
  // Parked while a plot is in hand. `allocateCells` would leave the carried zone's cells
  // alone, but a sibling that grew a thread still rebuilds — and any rebuild pass disposes
  // whichever plots changed, which mid-carry means the lifted group can be torn down under
  // the drag's own hands. Polls are 15s apart and a drag is seconds; the scan waits.
  if (drag.lifted) {
    drag.pendingThreads = list
    return
  }
  // A thread you have said you looked at stops counting as unread until it moves on again.
  // Done here rather than in `statusFor` so the card, the badge and the astronaut all agree.
  const viewed = state.viewedAt || {}
  threads = list.map((t) => {
    const at = viewed[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
  list = threads
  const archivedSet = new Set(state.archived)
  const hiddenSet = new Set(state.hiddenProjects || [])

  // Which threads the colony has met before. Walking out of the ship is meant to *mean*
  // something — a thread that just appeared — and without this every reload staged a
  // hundred-astronaut entrance, which piled up at the ramp and read as a bug because it was
  // one. A thread already on the books is simply already outside.
  const known = new Set(Object.keys(state.seen || {}))
  let firstSeen = false
  for (const t of list) {
    if (state.seen?.[t.id]) continue
    state.seen = { ...(state.seen || {}), [t.id]: Date.now() }
    firstSeen = true
  }
  if (firstSeen) queueSave()

  const stats = colony.setThreads(list, archivedSet, hiddenSet, known)
  hud.setStats(stats)

  legendProjects = colony.plotOrder
    .map((plot) => ({
      name: plot.name,
      accent: plot.accent,
      count: list.filter((t) => !t.archived && !archivedSet.has(t.id) && t.project === plot.name).length,
      urgent: colony.urgentPlots?.has(plot.id) ?? false,
    }))
    .sort((a, b) => b.count - a.count)

  // Keep the card honest if the thread it is showing changed underneath it.
  if (selectedId) {
    const still = colony.agentFor(selectedId)
    if (still) hud.setSelection(still, list.find((t) => t.id === selectedId) || still.thread)
    else select(null, {})
  }
  // Which also repaints the legend, so the open zone's chip is lit by the same pass.
  syncProject()

  // Zones only move when their own footprint changes, and when one does the colony file
  // learns about it — so the map you built up a memory of survives a reload.
  const layout = colony.layoutForSave()
  const signature = JSON.stringify(layout)
  if (signature !== lastLayout) {
    lastLayout = signature
    state.plots = layout
    queueSave()
  }
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const res = await fetchThreads()
    applyThreads(res.threads || [])
    hud.removeBoot()
  } catch (err) {
    hud.toast(err.message || 'Could not reach the thread scanner', 'err')
    hud.removeBoot()
  } finally {
    polling = false
  }
}

function queueSave() {
  clearTimeout(pendingSave)
  pendingSave = setTimeout(async () => {
    try {
      // Adopt whatever comes back: unchanged when the save was clean, and the merged colony when
      // another tab had written since this one loaded. Dropping it would leave this page
      // asserting a picture the file has already moved past, and the next save would fight.
      state = await saveState(state)
    } catch {
      /* the colony still runs; only the archive list is at risk, and it retries next time */
    }
  }, 500)
}

async function boot() {
  // The model kit and the crew rig both have to be in hand before the first roster arrives:
  // buildings and the ground scatter are assembled out of the kit synchronously the moment
  // a thread shows up, and the crew's body mesh is built from the rig. Fetched alongside
  // the saved state rather than after it, since none of them waits on the others.
  const settle = (p) => p.then(() => null, (err) => err)
  const [, kitError, crewError] = await Promise.all([
    fetchState()
      .then((s) => {
        state = s
        // Before the first roster: zones come back to the ground they were on last time.
        colony.restoreLayout(state.plots)
        // And the settings, but only for a browser that has none of its own — an explicit
        // choice made here always outranks the file.
        if (!hasStoredSettings() && state.settings) settings.applyAll(state.settings)
      })
      .catch(() => {
        /* first run, or the file is gone — an empty colony state is a valid one */
      }),
    settle(loadKit()),
    settle(loadCrew()),
  ])
  if (kitError || crewError) {
    hud.toast('Could not load the model assets — run `npm run assets`', 'err')
    console.error(kitError || crewError)
  }
  colony.astronauts.setRig(crewRig())
  if (!kitError) colony.onAssetsReady()

  await poll()
  setInterval(poll, POLL_MS)
  window.addEventListener('focus', poll)
  // A tab that was hidden for an hour should catch up the moment it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })

  if (!localStorage.getItem('botcrossing.seen-help')) {
    hud.toggleHelp(true)
    localStorage.setItem('botcrossing.seen-help', '1')
  } else {
    hud.hint('Drag to move · click an astronaut · H hides everything', 5200)
  }
}

// ── settings plumbing ─────────────────────────────────────────────────────────────────

settings.onChange((changed, scope) => {
  // Kept in the colony file as well as in this browser's own storage. `localStorage` is
  // per *origin*, so a dev server that comes back on a different port looks to the browser
  // like a different site and hands you factory settings — the file does not care.
  state.settings = { ...settings.values }
  queueSave()
  if (scope.render || changed.has('fov')) engine.applySettings()
  colony.onSettingsChanged(changed, scope)
  if (changed.has('showFps')) hud.syncSettings()
  // Folding dormant repos away changes which threads are on the map, so the colony has to be
  // rebuilt from the list rather than merely re-rendered.
  if (changed.has('hideDormant')) applyThreads(threads)
  if (changed.has('maxAgents')) applyThreads(threads)
})

// ── frame ─────────────────────────────────────────────────────────────────────────────

engine.add({
  update(dt, elapsed) {
    rig.update(dt)
    colony.update(dt, elapsed, rig.target)
    // Whatever the camera is orbiting is what should be in focus.
    engine.setFocusDistance(rig.distance)

    if (selectedId) {
      hud.updateAvatar(colony.astronauts.faceTexture.image)
      // A selected astronaut that walked off the roster should not keep a stale card open.
      const agent = colony.agentFor(selectedId)
      if (!agent) select(null, {})
      else hud.placeCard(screenOf(agent))
    }
    hud.setFps(engine.perf, engine.viewport, `${colony.astronauts.visibleCount} crew · ${colony.particles.liveCount} bits`)
  },
})

engine.start()
boot()

// Handy for poking at the running colony from the console.
window.botCrossing = { engine, rig, colony, settings, hud, poll, get threads() { return threads } }

/** `execCommand('copy')` over a throwaway textarea — the copy that predates permissions. */
function copyFallback(text) {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  el.remove()
  return ok
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
