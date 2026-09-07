/**
 * Filesystem helpers shared by every harness adapter.
 *
 * Nothing in here knows about a particular harness — an adapter is free to ignore the lot
 * and read its data however it likes. See `server/harnesses/README.md` for the contract.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Read the first chunk of a file without pulling a 12MB transcript into memory. */
export async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Drop a trailing partial line so JSON.parse never sees half a record.
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
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

export async function listFiles(dir, filter) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name))
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** Does this path exist at all? Adapters use it to answer `detect()`. */
export async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Best-effort reverse of the encoding both Claude Code and Cursor use for a project folder's
 * name: `-Users-you-Some-Dir` on macOS and Linux, `C--Users-you-Some-Dir` on Windows, where
 * the drive's colon became a dash too. Shared, because the second adapter to need it
 * re-implemented it without the drive letter and resolved nothing at all on Windows.
 */
export function decodeProjectDir(name) {
  const drive = /^([A-Za-z])--(.*)$/.exec(name)
  if (drive) return `${drive[1]}:\\${drive[2].replace(/-/g, '\\')}`
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name
}
