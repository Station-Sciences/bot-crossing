/**
 * The scanner, running in the page.
 *
 * On a hosted colony the server never sees the person's computer. This module holds the
 * folders they granted, runs each harness's browser adapter over them on a timer, and hands
 * the merged thread list to the game exactly as `/api/threads` would have. When the list
 * changes it also posts a small snapshot to the server — titles, previews, status, never a
 * transcript — so the same planet can be looked at from a phone.
 *
 * One folder per harness, because the browser will not hand over the home directory itself:
 * `~/.claude`, `~/.codex` and `~/.cursor` are three separate picks. Cursor scans last so the
 * paths the other two have already named can decode its lossy folder names.
 */
import claudeCode from './claude-code.js'
import codex from './codex.js'
import cursor from './cursor.js'
import {
  canPickFolders,
  droppedFolder,
  forgetFolder,
  loadFolders,
  permissionState,
  pickFolder,
  requestAccess,
  saveFolder,
} from './handles.js'

/** In scan order. `hint` is what the picker card says about finding the folder. */
const ADAPTERS = [claudeCode, codex, cursor]
const adapterById = (id) => ADAPTERS.find((a) => a.id === id) || null

/** Which adapter a picked folder belongs to, by asking each one whether it recognises it. */
async function adapterFor(handle, preferred) {
  const first = preferred && adapterById(preferred)
  if (first && (await first.looksLike(handle))) return first
  for (const adapter of ADAPTERS) {
    if (adapter !== first && (await adapter.looksLike(handle))) return adapter
  }
  return null
}

/** What changed since the last snapshot: enough to skip a post when nothing did. */
const signatureOf = (threads) =>
  threads.map((t) => `${t.id}:${t.lastActivityAt}:${t.running ? 1 : 0}${t.unread ? 1 : 0}`).join('|')

export class LocalScanner {
  /**
   * @param {object} opts
   * @param {(result: { threads: object[], harnesses: object[], scannedAt: number }) => void} opts.onThreads
   * @param {(status: object) => void} opts.onStatus
   * @param {(snapshot: object) => Promise<void>} [opts.publish]  Posts a snapshot to the server.
   */
  constructor({ onThreads, onStatus, publish }) {
    this.onThreads = onThreads
    this.onStatus = onStatus
    this.publish = publish
    /** harness id → { adapter, handle, state: 'granted'|'prompt'|'denied', threads, error } */
    this.folders = new Map()
    this.threads = []
    this.harnesses = []
    this.lastScanAt = 0
    this.lastSignature = ''
    this.timer = 0
    this.scanning = false
  }

  get supported() {
    return canPickFolders()
  }

  /** Folders with a usable grant right now. */
  get active() {
    return [...this.folders.values()].filter((f) => f.state === 'granted')
  }

  /** Bring back the folders from last time. Their permission may need a click to revive. */
  async init() {
    for (const { harness, handle } of await loadFolders()) {
      const adapter = adapterById(harness)
      if (!adapter) continue
      this.folders.set(harness, { adapter, handle, state: await permissionState(handle), threads: 0, error: '' })
    }
    this._status()
    if (this.active.length) await this.scan()
  }

  status() {
    return {
      supported: this.supported,
      lastScanAt: this.lastScanAt,
      folders: [...this.folders.entries()].map(([harness, f]) => ({
        harness,
        name: f.adapter.name,
        folder: f.handle.name,
        state: f.state,
        threads: f.threads,
        error: f.error,
      })),
      available: ADAPTERS.filter((a) => !this.folders.has(a.id)).map((a) => ({
        harness: a.id,
        name: a.name,
        folder: a.folder,
      })),
    }
  }

  _status() {
    this.onStatus?.(this.status())
  }

  /** From a click: open the picker for one harness's folder. Resolves to the adapter name, or '' on cancel. */
  async addFolder(harness) {
    let handle
    try {
      handle = await pickFolder(harness)
    } catch (err) {
      if (err?.name === 'AbortError') return ''
      throw err
    }
    return this.adopt(handle, harness)
  }

  /** From a drop: the folder that was dragged in, if it is one of ours. */
  async addDropped(event) {
    const handle = await droppedFolder(event)
    if (!handle) throw new Error('Drop a folder, such as your .claude folder')
    return this.adopt(handle)
  }

  async adopt(handle, preferred) {
    const adapter = await adapterFor(handle, preferred)
    if (!adapter) {
      const wanted = preferred && adapterById(preferred)
      throw new Error(
        wanted
          ? `That does not look like your ${wanted.folder} folder — it should contain ${wanted.name}'s sessions`
          : `That folder does not look like a harness folder — try ${ADAPTERS.map((a) => a.folder).join(', ')}`
      )
    }
    await saveFolder(adapter.id, handle)
    this.folders.set(adapter.id, { adapter, handle, state: 'granted', threads: 0, error: '' })
    this._status()
    await this.scan()
    return adapter.name
  }

  /** From a click: revive a remembered folder whose grant lapsed with the session. */
  async grant(harness) {
    const folder = this.folders.get(harness)
    if (!folder) return false
    const ok = await requestAccess(folder.handle)
    folder.state = ok ? 'granted' : 'denied'
    this._status()
    if (ok) await this.scan()
    return ok
  }

  async forget(harness) {
    await forgetFolder(harness)
    this.folders.delete(harness)
    this._status()
    await this.scan()
    // Removing the last folder is a request to stop showing those sessions anywhere, so the
    // server's copy goes too; otherwise the planet would fall back to the snapshot it just
    // stopped reading, on this computer and on every other one.
    if (!this.folders.size && this.publish) {
      this.lastSignature = ''
      await this.publish(this._snapshot([])).catch(() => {})
    }
  }

  _snapshot(threads) {
    return {
      threads: threads.map(({ ref, openHint, ...t }) => t),
      harnesses: this.harnesses,
      scannedAt: this.lastScanAt,
      machine: { label: navigator.platform || 'computer', platform: navigator.platform || '' },
    }
  }

  async scan() {
    if (this.scanning) return
    this.scanning = true
    try {
      const lists = []
      const harnesses = []
      const knownPaths = new Set()
      // Adapter order, not insertion order: the later ones may lean on what the earlier found.
      for (const adapter of ADAPTERS) {
        const folder = this.folders.get(adapter.id)
        if (!folder) continue
        if (folder.state !== 'granted') {
          harnesses.push({ id: adapter.id, name: adapter.name, detected: false, error: 'Needs permission' })
          continue
        }
        try {
          const threads = await adapter.scanThreads(folder.handle, { knownPaths: [...knownPaths] })
          for (const t of threads) if (t.projectPath) knownPaths.add(t.projectPath)
          folder.threads = threads.length
          folder.error = ''
          lists.push(threads)
          harnesses.push({ id: adapter.id, name: adapter.name, detected: true, error: '' })
        } catch (err) {
          // A grant that expired mid-session reads as NotAllowedError; anything else is the folder itself.
          folder.state = err?.name === 'NotAllowedError' ? 'prompt' : folder.state
          folder.error = err?.message || 'Could not read that folder'
          harnesses.push({ id: adapter.id, name: adapter.name, detected: true, error: folder.error })
        }
      }
      this.threads = lists.flat().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      this.harnesses = harnesses
      this.lastScanAt = Date.now()
      this._status()
      this.onThreads?.({ threads: this.threads, harnesses, scannedAt: this.lastScanAt })
      await this._publish()
    } finally {
      this.scanning = false
    }
  }

  async _publish() {
    if (!this.publish || !this.active.length) return
    const signature = signatureOf(this.threads)
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    try {
      await this.publish(this._snapshot(this.threads))
    } catch {
      // The planet still renders from the live scan; the snapshot is only for other devices.
      this.lastSignature = ''
    }
  }

  start(intervalMs) {
    this.stop()
    this.timer = setInterval(() => this.scan(), intervalMs)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = 0
  }

  /** The new-session deep link for a project, when the harness that owns it can offer one. */
  newSessionUrl(harness, folder) {
    const adapter = adapterById(harness)
    return adapter?.newSessionUrl ? adapter.newSessionUrl(folder) : ''
  }
}
