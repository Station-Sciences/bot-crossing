import * as THREE from 'three'
import './ui/styles.css'
import { DEFAULT_PRESET, Settings, hasStoredSettings } from './core/settings.js'
import { Engine } from './core/engine.js'
import { CameraRig } from './core/camera.js'
import { Colony, STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress } from './game/colony.js'
import { Hud } from './ui/hud.js'
import { PLANETS } from './world/planet.js'
import { loadKit } from './world/kit.js'
import { crewRig, loadCrew } from './agents/crew.js'
import { TIMES } from './world/sky.js'
import { CURVE_FULL, bendPoint, installWorldCurve, setCurveView } from './core/curve.js'
import { Ambience } from './audio/ambience.js'
import { shorelinePoints } from './world/planet.js'
import { shipPosition } from './world/plots.js'
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
// A phone gets the light preset the first time: a retina panel at full scale with bloom
// and shadows is more than its GPU wants to do at sixty, and the governor only ever finds
// that out by stuttering first.
const phoneLike = window.matchMedia('(max-width: 600px)').matches || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900)
if (!hasStoredSettings()) settings.applyPreset(phoneLike ? 'low' : DEFAULT_PRESET)

// Before the first material compiles: the bend is patched into three's own shader chunks.
installWorldCurve()
const engine = new Engine(settings).mount(app)
engine.setPlanetGrade(PLANETS[settings.get('planet')]?.grade)
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
let busiestCursor = 0
let pendingSave = 0
const hoverGround = new THREE.Vector3()

// ── actions the HUD can trigger ────────────────────────────────────────────────────────

const actions = {
  viewportChanged: ({ width, height, right, bottom }) => {
    rig.setViewportInsets(width, height, { right, bottom })
    engine.tiltShift?.setCamera(engine.camera)
  },

  resetView: () => {
    if (rig.following) select(null, {})
    rig.resetView()
  },

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

  /**
   * Cycle to the next crew member. In-project by default when a zone's sidebar is open —
   * out-of-project (the whole colony) when there is no zone open, or when asked for
   * explicitly (the shift-modified binding), so the same key can mean either without a
   * separate pair of bindings to keep in sync.
   */
  focusAgent: ({ crossProject = false } = {}) => {
    const scoped = !crossProject && selectedProject
    const pool = colony.astronauts.agents.filter((a) => !scoped || a.thread?.project === selectedProject)
    if (!pool.length) {
      hud.hint(scoped ? `Nobody in ${selectedProject} right now` : 'No crew on the surface')
      return
    }
    pool.sort((a, b) => a.id.localeCompare(b.id))
    const from = pool.findIndex((a) => a.id === selectedId)
    const agent = pool[(from + 1 + pool.length) % pool.length]
    select(agent.id, { fly: true })
  },

  /** Step to the next repo, wrapping — the same order the legend lists them in. */
  cycleProject: () => {
    const order = colony.plotOrder
    if (!order.length) {
      hud.hint('No projects yet')
      return
    }
    const from = order.findIndex((p) => p.id === selectedProject)
    const plot = order[(from + 1) % order.length]
    selectProject(plot.id, { fly: true })
  },

  /**
   * Jump to whoever has been busiest lately, cycling through the ranking on repeat presses.
   * "Busiest" is a proxy for now — most recently active thread — until real per-agent spend
   * or call counts exist to rank by instead.
   */
  focusBusiest: () => {
    const pool = colony.astronauts.agents
    if (!pool.length) {
      hud.hint('No crew on the surface')
      return
    }
    const ranked = [...pool].sort((a, b) => (b.thread?.lastActivityAt || 0) - (a.thread?.lastActivityAt || 0))
    const agent = ranked[busiestCursor++ % ranked.length]
    select(agent.id, { fly: true })
  },

  focusProject: (name) => {
    const plot = colony.plots.get(name)
    if (!plot) return
    if (rig.following) select(null, {})
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
      const res = await openThread(thread)
      colony.astronauts.celebrate(thread.id)
      hud.toast(res?.note || `Opened in ${thread.harnessName || 'your harness'}`)
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

/**
 * Sound. Beds per world, things calling out on their own clocks, and positional sources
 * for whatever is actually making noise — a site being hammered at, the lander, a drone
 * going past — attenuated by distance from the camera, so leaning in is turning it up.
 */
const ambience = new Ambience(settings)
ambience.setPlanet(colony.planet)
colony.onSound = (name, x, y, z) => ambience.play(name, { x, y, z, kind: colony.fauna.flock?.kind })

const hud = new Hud(app, settings, actions)

// ── selection ─────────────────────────────────────────────────────────────────────────

let lastVoiced = null
let lastPhrase = 0

function select(id, { fly = false } = {}) {
  selectedId = id
  const agent = id ? colony.agentFor(id) : null
  if (!agent) {
    selectedId = null
    rig.setFollow(null)
    colony.astronauts.setSelected(null)
    hud.setSelection(null, null)
    syncProject()
    return
  }
  colony.astronauts.setSelected(agent)
  const thread = threads.find((t) => t.id === id) || agent.thread
  hud.setSelection(agent, thread)
  // It answers. One of six little phrases, from where it is standing, never twice in a row.
  if (agent.id !== lastVoiced) {
    lastVoiced = agent.id
    let n = 1 + Math.floor(Math.random() * 6)
    if (n === lastPhrase) n = (n % 6) + 1
    lastPhrase = n
    ambience.play(`select-${n}`, { x: agent.pos.x, y: agent.pos.y + 0.8, z: agent.pos.z, gain: 0.9 })
  }
  // Picking somebody is also picking the zone they are standing on: the sidebar follows.
  if (thread?.project && colony.plots.has(thread.project)) selectedProject = thread.project
  syncProject()
  if (fly) {
    rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 26) })
  }
  rig.setFollow(settings.get('followSelected') ? agent : null)
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
  bendPoint(cardAnchor.set(agent.pos.x, agent.pos.y + 0.95, agent.pos.z)).project(engine.camera)
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
  engine.canvas.style.cursor = agent || plot ? 'pointer' : 'grab'
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

// Pressing on an astronaut used to suppress the camera, on the theory that grabbing one
// should not also drag the world out from under it. But nothing is draggable *about* an
// astronaut — a press is only ever the start of a selection or the start of a pan — so all
// that suppression did was make the ground refuse to move whenever a drag happened to begin
// on top of somebody. Selection is decided on release instead, where `wasClick` already
// distinguishes a click from a drag.
engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  if (agent) {
    select(agent.id, {})
    return
  }
  // Nobody there: whoever was selected is put down first, whatever else the click lands on
  // — a deck of the same repo used to keep the card up. Then a zone's deck or its name plate
  // opens that repo's sidebar, and bare ground closes that too.
  if (selectedId) select(null, {})
  const plot = plotUnder(e, p)
  if (plot) selectProject(plot.name, {})
  else actions.closeProject()
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
    case 'm':
    case 'M':
      settings.set('sound', !settings.get('sound'))
      hud.hint(settings.get('sound') ? 'Sound on' : 'Muted')
      break
    // Plain jumps within the open zone; shift jumps the whole colony — one binding, the
    // modifier is what decides scope, so there is nothing else to keep in sync.
    case 'j':
    case 'J':
      actions.focusAgent({ crossProject: e.shiftKey })
      break
    case 'k':
    case 'K':
      actions.cycleProject()
      break
    case 'b':
    case 'B':
      actions.focusBusiest()
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
    // One step at a time, outward: the thread, then the zone it belongs to.
    case 'Escape':
      if (document.querySelector('.help.open')) hud.toggleHelp(false)
      else if (selectedId) select(null, {})
      else if (selectedProject) actions.closeProject()
      break
  }
})

// ── data ──────────────────────────────────────────────────────────────────────────────

function applyThreads(list) {
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
  chimeForNewWaiting(list, archivedSet, hiddenSet)

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

/**
 * The one sound that is allowed to interrupt: a thread that has just put its hand up. Once
 * per thread per wait, never on the first roster (a reload is not news), and never more
 * than one chime a couple of seconds apart however many arrive at once.
 */
const waitingBefore = new Set()
let seenFirstRoster = false
let lastChime = 0
function chimeForNewWaiting(list, archivedSet, hiddenSet) {
  const now = Date.now()
  const waiting = new Set()
  for (const t of list) {
    if (archivedSet.has(t.id) || hiddenSet.has(t.project)) continue
    if (statusFor(t, now) === 'waiting') waiting.add(t.id)
  }
  if (seenFirstRoster) {
    for (const id of waiting) {
      if (waitingBefore.has(id) || now - lastChime < 2500) continue
      lastChime = now
      const agent = colony.agentFor(id)
      ambience.play('chime-attention', agent ? { x: agent.pos.x, y: agent.pos.y + 1, z: agent.pos.z, gain: 0.9 } : { gain: 0.9 })
    }
  }
  seenFirstRoster = true
  waitingBefore.clear()
  for (const id of waiting) waitingBefore.add(id)
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
  if (changed.has('planet')) engine.setPlanetGrade(PLANETS[settings.get('planet')]?.grade)
  colony.onSettingsChanged(changed, scope)
  if (changed.has('planet')) ambience.setPlanet(colony.planet)
  if (changed.has('showFps')) hud.syncSettings()
  if (changed.has('followSelected')) rig.setFollow(settings.get('followSelected') ? colony.agentFor(selectedId) : null)
  // Folding dormant repos away changes which threads are on the map, so the colony has to be
  // rebuilt from the list rather than merely re-rendered.
  if (changed.has('hideDormant')) applyThreads(threads)
  if (changed.has('maxAgents')) applyThreads(threads)
})

// ── frame ─────────────────────────────────────────────────────────────────────────────

engine.add({
  update(dt, elapsed) {
    rig.setFollow(settings.get('followSelected') ? colony.agentFor(selectedId) : null)
    rig.update(dt)
    // The world bends away from wherever the camera is looking, every frame, before the
    // colony projects anything to the screen.
    setCurveView(rig.target, rig.azimuth, settings.get('worldCurve') * CURVE_FULL)
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
    ambience.update(dt, engine.camera, soundWorld())
  },
})

// ── what the world sounds like ────────────────────────────────────────────────────────

const soundSources = []
const soundWater = { level: 0, points: [] }
const shipSpot = shipPosition()
/**
 * Everything making a noise right now, as positional sources. Objects are reused between
 * frames so the audio engine can key voices by id without anything being allocated.
 */
function soundWorld() {
  let n = 0
  const take = (id, sound, x, y, z, gain = 1) => {
    const s = soundSources[n] || (soundSources[n] = { id: '', sound: '', x: 0, y: 0, z: 0, gain: 1 })
    s.id = id
    s.sound = sound
    s.x = x
    s.y = y
    s.z = z
    s.gain = gain
    n++
  }
  for (const agent of colony.astronauts.agents) {
    if (agent.state === 'at-site' && agent.status === 'working' && agent.scale > 0.5) {
      take(`work:${agent.id}`, 'work-hammer', agent.pos.x, agent.pos.y + 0.6, agent.pos.z, 0.9)
    }
  }
  take('ship', 'ship-hum', shipSpot.x, colony.ship.group.position.y + 3, shipSpot.z, 0.7)
  colony.fauna.drones.forEach((d, i) => take(`drone:${i}`, 'drone-whine', d.x, d.y, d.z, d.busy ? 1 : 0.35))
  soundSources.length = n

  let water = null
  if (colony.planet.water && colony.planet.audio?.shore) {
    // The half-dozen bits of shoreline nearest the view: the whole coast is hundreds of
    // points, and the engine only has ten voices to give out.
    const all = shorelinePoints(colony.planet)
    const t = rig.target
    soundWater.points = all
      .map((p) => ({ p, d: (p.x - t.x) * (p.x - t.x) + (p.z - t.z) * (p.z - t.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)
      .map((e) => e.p)
    soundWater.level = colony.planet.water.level
    // Where the view is, so the surf beds can be quieter the further inland it sits.
    soundWater.focusX = t.x
    soundWater.focusZ = t.z
    water = soundWater
  }
  return { night: colony.sky.nightFactor ?? 0, sources: soundSources, water }
}

engine.start()
boot()

// Handy for poking at the running colony from the console.
window.botCrossing = { engine, rig, colony, settings, hud, ambience, poll, get threads() { return threads } }

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
