/**
 * The folders the person has let this page read, remembered between visits.
 *
 * A `FileSystemDirectoryHandle` survives a reload only if it is stored somewhere structured
 * clone can reach — IndexedDB — and the read permission on it has to be asked for again on
 * the next visit, from a click. Chrome remembers the answer ("allow on every visit") from
 * version 122; an installed web app keeps it with no prompt at all. So the shape here is:
 * the store holds handles, `permissionState` says whether one is usable right now, and
 * `requestAccess` is only ever called from a user gesture.
 *
 * Handles are keyed by the harness they belong to, one folder per harness. Chrome will not
 * hand over the home directory itself, so `~/.claude` and `~/.codex` are two separate picks.
 */

const DB = 'botcrossing'
const STORE = 'folders'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const store = t.objectStore(STORE)
    const req = fn(store)
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

/** Can this browser pick a folder at all? Chromium yes; Safari and Firefox no. */
export const canPickFolders = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** Every stored handle, as `{ harness, handle }`. */
export async function loadFolders() {
  try {
    const db = await openDb()
    const keys = await tx(db, 'readonly', (s) => s.getAllKeys())
    const values = await tx(db, 'readonly', (s) => s.getAll())
    db.close()
    return keys.map((harness, i) => ({ harness, handle: values[i] })).filter((f) => f.handle)
  } catch {
    return []
  }
}

export async function saveFolder(harness, handle) {
  const db = await openDb()
  await tx(db, 'readwrite', (s) => s.put(handle, harness))
  db.close()
}

export async function forgetFolder(harness) {
  const db = await openDb()
  await tx(db, 'readwrite', (s) => s.delete(harness))
  db.close()
}

/** 'granted' | 'prompt' | 'denied' — without asking. */
export async function permissionState(handle) {
  try {
    return await handle.queryPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

/** Ask for read access. Must run from a user gesture; resolves to whether it is now granted. */
export async function requestAccess(handle) {
  try {
    return (await handle.requestPermission({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * Open the native picker. `id` keeps a separate "last folder" per harness so the second
 * pick does not start where the first one ended. Rejects with AbortError on cancel.
 */
export async function pickFolder(harness) {
  return window.showDirectoryPicker({ id: `botcrossing-${harness}`, mode: 'read' })
}

/** A dropped folder, from a drag-and-drop event, or null when what was dropped is not one. */
export async function droppedFolder(event) {
  const item = [...(event.dataTransfer?.items || [])].find((i) => i.kind === 'file')
  if (!item || typeof item.getAsFileSystemHandle !== 'function') return null
  const handle = await item.getAsFileSystemHandle()
  return handle && handle.kind === 'directory' ? handle : null
}
