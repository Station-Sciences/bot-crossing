/**
 * Lightweight filesystem watcher for agent transcript and session directories.
 * Debounces changes and notifies listeners so updates can be pushed via SSE in real time.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

function candidateDirs() {
  const dirs = [
    // Claude Code
    path.join(HOME, '.claude', 'projects'),
    path.join(HOME, '.claude', 'sessions'),
    // Antigravity
    process.env.BOT_CROSSING_ANTIGRAVITY_DIR ||
      process.env.ANTIGRAVITY_BRAIN_DIR ||
      path.join(HOME, '.gemini', 'antigravity-ide', 'brain'),
    // Codex
    path.join(HOME, '.codex', 'sessions'),
    // Colony map data
    process.env.BOT_CROSSING_DATA || path.join(process.cwd(), 'data'),
  ]

  // macOS / Linux Claude desktop sessions if present
  if (process.platform === 'darwin') {
    dirs.push(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'))
  } else if (process.platform === 'linux') {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude', 'claude-code-sessions'))
  }

  return dirs.filter((d) => {
    try {
      return fs.existsSync(d) && fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
}

export function startWatcher(onChange, debounceMs = 750) {
  let debounceTimer = null
  const watchers = []

  const trigger = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      try {
        onChange?.()
      } catch (err) {
        console.warn('bot-crossing watcher callback error:', err?.message || err)
      }
    }, debounceMs)
  }

  const dirs = candidateDirs()
  for (const dir of dirs) {
    try {
      // Node's fs.watch recursive option is supported on macOS and Windows, and Linux on newer kernels
      const w = fs.watch(dir, { recursive: true }, () => trigger())
      w.on('error', () => {})
      watchers.push(w)
    } catch {
      try {
        const w = fs.watch(dir, () => trigger())
        w.on('error', () => {})
        watchers.push(w)
      } catch {}
    }
  }

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) {
        try {
          w.close()
        } catch {}
      }
    },
  }
}
