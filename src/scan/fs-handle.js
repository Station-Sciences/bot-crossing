/**
 * The filesystem helpers from `server/lib/fsutil.mjs`, over the browser's directory handles.
 *
 * A harness adapter in the browser reads the same folder the server-side adapter reads —
 * `~/.claude`, `~/.codex` — but through a `FileSystemDirectoryHandle` the person granted with
 * the File System Access API. Nothing here knows about a harness; it is the smallest set of
 * reads the adapters need, with the same contract as the Node versions: a head with its
 * trailing partial line dropped, a tail with its leading partial line dropped, and listings
 * that return nothing rather than throwing when a folder is missing.
 *
 * Every read goes through `getFile()`, which hands back a `File` whose `size` and
 * `lastModified` are the stat the Node code takes from `fsp.stat`. Slicing a `File` does not
 * read it — only `.text()` on the slice does — so a 12MB transcript costs the bytes asked for.
 */

/** `{ name, handle }` for every subdirectory. Missing or unreadable → `[]`. */
export async function listDirs(dir) {
  const out = []
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') out.push({ name, handle })
    }
  } catch {
    return []
  }
  return out
}

/** `{ name, handle }` for every file whose name passes `filter`. Missing → `[]`. */
export async function listFiles(dir, filter) {
  const out = []
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && filter(name)) out.push({ name, handle })
    }
  } catch {
    return []
  }
  return out
}

/** A child directory handle, or null when it is not there. */
export async function getDir(dir, name) {
  try {
    return await dir.getDirectoryHandle(name)
  } catch {
    return null
  }
}

/** `{ size, mtime }` for a file handle — the two numbers the scanners key their caches on. */
export async function stat(fileHandle) {
  const file = await fileHandle.getFile()
  return { size: file.size, mtime: file.lastModified }
}

/** Read the first chunk of a file, dropping a trailing partial line so JSON.parse never sees half a record. */
export async function readHead(fileHandle, bytes) {
  const file = await fileHandle.getFile()
  const want = Math.min(bytes, file.size)
  const text = await file.slice(0, want).text()
  return want < file.size ? text.slice(0, text.lastIndexOf('\n') + 1) : text
}

/** The last `bytes` of a file, with a leading partial line dropped. */
export async function readTail(fileHandle, bytes) {
  const file = await fileHandle.getFile()
  const want = Math.min(bytes, file.size)
  const text = await file.slice(file.size - want, file.size).text()
  return want === file.size ? text : text.slice(text.indexOf('\n') + 1)
}

export async function readText(fileHandle) {
  const file = await fileHandle.getFile()
  return file.text()
}

/** Parse a JSONL blob, skipping the partial or malformed lines a live file always has. */
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return out
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
