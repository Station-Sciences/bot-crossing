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

/**
 * The last `bytes` of a file, with a leading partial line dropped. The mirror of `readHead`,
 * for the questions only the end of a transcript answers — whose turn it is right now.
 */
export async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const want = Math.min(bytes, size)
    const buf = Buffer.allocUnsafe(want)
    const { bytesRead } = await fh.read(buf, 0, want, size - want)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return want === size ? text : text.slice(text.indexOf('\n') + 1)
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

/**
 * Where an executable is, as an absolute path, or null. PATH first, then `extraDirs` — the
 * places an installer puts a binary that a server started with a thin PATH (an IDE launcher, a
 * service unit) would not see. Candidates are resolved rather than joined: the caller may spawn
 * from a different working directory than this check ran in, and a relative PATH entry would
 * then name two different files. X_OK alone passes for a directory, hence the stat.
 *
 * It never looks inside an application bundle, and no caller should hand it a path that does.
 * Running a binary out of somebody else's `.app` is how you get the OS blaming us for it.
 *
 * `BOT_CROSSING_CLI_DIRS`, when set, stands in for every caller's `extraDirs`, and empty means
 * PATH alone. It is the same kind of override as `CLAUDE_CONFIG_DIR`: the suite uses it to test
 * "no CLI installed" on a machine that has one in `/opt/homebrew/bin`, which an emptied PATH
 * alone would still find. Kept here rather than per adapter, so one switch covers them all.
 */
export async function findExecutable(name, extraDirs = []) {
  if (typeof name !== 'string' || !name) return null
  const explicit = name.includes('/') || name.includes(path.sep)
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const override = process.env.BOT_CROSSING_CLI_DIRS
  const installDirs = override === undefined ? extraDirs : override.split(path.delimiter).filter(Boolean)

  for (const dir of explicit ? ['.'] : [...onPath, ...installDirs]) {
    const candidate = path.resolve(dir, name)
    try {
      await fsp.access(candidate, fsp.constants.X_OK)
      if ((await fsp.stat(candidate)).isFile()) return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
