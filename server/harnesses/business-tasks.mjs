/**
 * Harness adapter: Business Tasks — not a coding harness at all.
 *
 * Sherman's CEO/content system (Claude, in a separate chat session) hands off actionable items
 * here the same way a coding agent hands off a thread: something exists, it needs a human, and
 * clicking it should take you straight to where you act on it. `data/business-tasks.json` is
 * that hand-off point — a small hand-edited (or Claude-edited) file, read-only from this side,
 * exactly like a harness's own session records.
 *
 * Each task becomes one astronaut in its own "Business Tasks" zone. `unread: true` is what
 * gives it the "?" — a task nobody has captured yet reads as unanswered, which is the truth.
 * `lastActivityAt` is pinned to when the task was added rather than refreshed on every scan, so
 * a task that sits uncaptured drifts toward the colony's own "asleep for a while" look instead
 * of pretending to be freshly active — a task you're ignoring should look ignored.
 *
 * Read-only, no subprocess: see the ground rules in `server/harnesses/README.md`. This adapter
 * never writes `data/business-tasks.json` — there is no delete route. `"done": true` marks a
 * task finished; `"deleted": true` marks it withdrawn instead of finished. Both just drop the
 * task out of `scanThreads()`; neither ever removes the entry from the file. Editing the file
 * by hand (or asking Claude to) is the only way in or out, same as `newSession()` below says.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { exists } from '../lib/fsutil.mjs'

const TASKS_FILE = process.env.BOT_CROSSING_BUSINESS_TASKS || path.join(process.cwd(), 'data', 'business-tasks.json')

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `business:${raw}`

async function scanThreads() {
  let raw
  try {
    raw = await fsp.readFile(TASKS_FILE, 'utf8')
  } catch {
    return []
  }

  let tasks
  try {
    tasks = JSON.parse(raw)
  } catch {
    // Being hand-edited mid-save is a normal thing to trip over — skip this pass, not the harness.
    return []
  }
  if (!Array.isArray(tasks)) return []

  const threads = []
  for (const task of tasks) {
    try {
      if (!task || typeof task !== 'object' || !task.id || task.done || task.deleted) continue
      const addedAt = Date.parse(task.addedAt) || Date.now()
      threads.push({
        id: ID(task.id),
        title: String(task.title || 'Untitled task'),
        preview: String(task.preview || ''),
        project: 'Business Tasks',
        projectPath: '',
        worktree: '',
        cwd: '',
        gitBranch: '',
        model: String(task.category || ''),
        effort: '',
        createdAt: addedAt,
        lastActivityAt: addedAt,
        lastFocusedAt: 0,
        unread: true,
        running: false,
        hasError: false,
        starred: false,
        routine: false,
        prState: '',
        archived: false,
        sizeBytes: 400 + String(task.preview || '').length * 20,
        source: 'manual',
        canOpen: Boolean(task.url),
        ref: { url: task.url || '' },
      })
    } catch {
      // One malformed task costs itself, not the rest of the list.
    }
  }
  return threads
}

/** The URL is all this adapter ever hands back — `present()` on the server opens it generically. */
function openThread(ref) {
  if (!ref?.url) return { ok: false, error: 'This task has no page to open.' }
  return { ok: true, url: ref.url }
}

function newSession() {
  return {
    ok: false,
    error:
      'Business tasks are managed by editing data/business-tasks.json directly — add one, set "done": true, or set "deleted": true to withdraw one. Nothing is ever removed from the file.',
  }
}

const detect = () => exists(TASKS_FILE)

export default {
  id: 'business-tasks',
  name: 'Business Tasks',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { TASKS_FILE },
}
