/**
 * Windows plumbing: how you put a command in a terminal window here.
 *
 * The counterpart to `openInTerminal` in `xdg.mjs`, and deliberately a separate file for the
 * same reason that one is: it is a page of platform trivia with nothing to do with HTTP, and
 * nothing in it knows about a particular harness. An adapter hands the server an argv; the
 * server decides whether a terminal is the right place for it.
 *
 * Two terminals, tried in order. Windows Terminal is the one worth having — it takes the
 * working directory as a flag and the command as trailing arguments, so nothing in the argv
 * is ever read as a flag of its own. Plain `cmd.exe` is the fallback that is on every machine.
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findExecutable } from './fsutil.mjs'

/**
 * `start` is a cmd builtin rather than a program, so it cannot be spawned directly — it has to
 * be reached through `cmd /c`. Its first quoted argument is swallowed as the new window's
 * title, which is why the empty string is there: without it the first real argument disappears
 * and the window opens on whatever the second one happened to be.
 *
 * `/k` keeps the window open after the command exits. That is the point of the feature — you
 * are meant to keep typing in it — and it is also what makes a failure visible instead of a
 * window that flashes and is gone before you read the error.
 */
const TERMINALS = {
  'wt.exe': (cwd, argv) => ['-d', cwd, ...argv],
  'cmd.exe': (_cwd, argv) => ['/c', 'start', '', 'cmd.exe', '/k', ...argv],
}

const ORDER = ['wt.exe', 'cmd.exe']

function trySpawn(bin, args, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      // Detached and unref'd: the terminal has to outlive this request, and it must not hold
      // the dev server open when you stop it.
      child = spawn(bin, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    } catch (err) {
      return resolve({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    // A spawn that is going to fail does so immediately; one that survives the tick is running.
    const settled = setTimeout(() => {
      child.unref()
      resolve({ ok: true })
    }, 120)
    child.once('error', (err) => {
      clearTimeout(settled)
      resolve({ ok: false, error: String(err && err.message ? err.message : err) })
    })
  })
}

/**
 * Open `argv` in a terminal sitting in `cwd`.
 *
 * Both arguments are validated the same way `openInTerminal` validates them, and for the same
 * reason: this function will hand what it is given to the OS, so a relative path or an empty
 * string is refused here rather than resolved against whatever directory the server happens to
 * be running in.
 */
export async function openInTerminalWindows(argv, cwd) {
  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }
  const usable = await fsp.stat(cwd).then((st) => st.isDirectory(), () => false)
  if (!usable) return { ok: false, error: 'That folder is not a directory any more' }

  let lastError = ''
  for (const name of ORDER) {
    const resolved = await findExecutable(name)
    if (!resolved) continue
    const result = await trySpawn(resolved, TERMINALS[name](cwd, argv), cwd)
    if (result.ok) return { ok: true }
    lastError = result.error
  }

  return {
    ok: false,
    error: lastError
      ? `Could not open a terminal (${lastError})`
      : 'No terminal found — install Windows Terminal, or check that cmd.exe is on your PATH',
  }
}
