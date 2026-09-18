/**
 * Put a command in a new terminal window.
 *
 * Only `server/api.mjs` uses this, on Linux and macOS. It is split out because it is a page of
 * terminal-emulator trivia with nothing to do with HTTP, and nothing in here knows about a
 * particular harness — an adapter never imports it. An adapter hands the server an argv; the
 * server decides whether a terminal is the right place for it.
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findExecutable } from './fsutil.mjs'
import { openInTerminalWindows } from './win-terminal.mjs'

/**
 * How each terminal wants "run this command in this directory". The command comes after the
 * terminal's own end-of-options marker where it has one, so nothing in it is ever read as a
 * flag; the working directory is also set on the spawn itself, which is all the xterm family
 * needs and what the D-Bus terminals forward to their server anyway.
 *
 * Only terminals whose flags are documented are listed. `tilix` is deliberately absent: its `-e`
 * takes one string that it re-splits itself, which would mean building a shell string.
 */
const TERMINALS = {
  'gnome-terminal': (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  kgx: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  ptyxis: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  konsole: (dir, cmd) => ['--workdir', dir, '-e', ...cmd],
  'xfce4-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  'mate-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  kitty: (dir, cmd) => [`--directory=${dir}`, ...cmd],
  alacritty: (dir, cmd) => ['--working-directory', dir, '-e', ...cmd],
  ghostty: (dir, cmd) => [`--working-directory=${dir}`, '-e', ...cmd],
  wezterm: (dir, cmd) => ['start', '--cwd', dir, '--', ...cmd],
  foot: (dir, cmd) => [`--working-directory=${dir}`, ...cmd],
  terminator: (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  xterm: (_dir, cmd) => ['-e', ...cmd],
  uxterm: (_dir, cmd) => ['-e', ...cmd],
  urxvt: (_dir, cmd) => ['-e', ...cmd],
  rxvt: (_dir, cmd) => ['-e', ...cmd],
  st: (_dir, cmd) => ['-e', ...cmd],
}

const GENERAL_ORDER = [
  'gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal', 'kitty', 'alacritty', 'ghostty',
  'wezterm', 'foot', 'terminator', 'ptyxis', 'kgx', 'xterm', 'uxterm', 'urxvt', 'rxvt', 'st',
]

/**
 * A terminal that ships with the desktop first. `XDG_CURRENT_DESKTOP` is a colon list, such as
 * `ubuntu:GNOME`, and GNOME gets the three it has shipped over the years in the order they are
 * most likely to be the one actually configured.
 */
function desktopOrder() {
  const parts = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':')
  if (parts.includes('kde')) return ['konsole']
  if (parts.includes('xfce')) return ['xfce4-terminal']
  if (parts.includes('mate')) return ['mate-terminal']
  if (parts.some((p) => ['gnome', 'ubuntu', 'unity', 'cinnamon', 'x-cinnamon'].includes(p))) {
    return ['gnome-terminal', 'kgx', 'ptyxis']
  }
  return []
}

/**
 * Is there anywhere for a window to appear? Deliberately loose: only the plainly headless case
 * is refused here, so that it gets a message saying so, and anything less clear-cut is left to
 * the launch itself, whose exit code is the real answer. Wayland clients find their socket
 * without the variable being set, so the runtime dir is checked too.
 */
async function hasDisplay() {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true
  const run = process.env.XDG_RUNTIME_DIR
  if (!run) return false
  try {
    return (await fsp.readdir(run)).some((name) => name.startsWith('wayland-'))
  } catch {
    return false
  }
}

/**
 * A terminal that refuses does so at once — well under 50 ms on a GNOME desktop — while a window
 * takes longer than this to come up. A refusal slower than this is knowingly reported as a
 * success: the alternative, treating every late non-zero exit as a failure, would open a second
 * terminal whenever the command inside the first one ended quickly.
 */
const REFUSAL_MS = 300
/** After this a foreground terminal (xterm, Debian's `--wait` wrapper) is plainly up. */
const GRACE_MS = 1500
/**
 * And a ceiling on the whole walk. Each candidate can cost `GRACE_MS`, and a machine with
 * several terminals installed and a display that is misbehaving would otherwise hold the request
 * for the sum of them while the page waits on a spinner. Better to give up and say so.
 */
const WALK_BUDGET_MS = 4000

/**
 * Spawn a terminal and say whether it actually came up. The D-Bus terminals hand the window to a
 * service and exit 0 at once; when they cannot — no display, a flag they reject — they exit
 * non-zero just as fast, and that is the failure worth reporting instead of a toast that says
 * "opened". A non-zero exit that arrives *later* is different: the window came up and the command
 * inside it has ended, which is the user's to see and no reason to open a second terminal on top.
 */
function trySpawn(cmd, args, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true })
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) })
      return
    }
    const startedAt = Date.now()
    let timer = null
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', (err) => done({ ok: false, error: err?.message || String(err) }))
    child.on('exit', (code, signal) => {
      if (code === 0 || Date.now() - startedAt >= REFUSAL_MS) return done({ ok: true })
      const how = signal ? `signal ${signal}` : `code ${code}`
      done({ ok: false, error: `${path.basename(cmd)} exited with ${how}` })
    })
    timer = setTimeout(() => {
      child.unref()
      done({ ok: true })
    }, GRACE_MS)
  })
}

/**
 * Run `argv` in a new terminal window with `cwd` as its working directory.
 *
 * The caller has already resolved both: `argv[0]` is an absolute executable and `cwd` an
 * existing directory. Which terminal is up to the machine — `BOT_CROSSING_TERMINAL` if set, then
 * `$TERMINAL`, then the desktop's own, then whatever is installed, then Debian's
 * `x-terminal-emulator` alternative. That last is tried by name and given `-e`, the one form
 * Debian policy guarantees, because on Ubuntu it is a wrapper script that knows no other flags —
 * pass it `--working-directory` and it opens an empty window. Which is also why a real
 * `gnome-terminal` is looked for first.
 *
 * A named terminal the table does not know is skipped rather than guessed at: `-e` means "the
 * rest of the line" to xterm and "one string, which I will split" to tilix, and guessing wrong
 * opens a window on the wrong command — worse than moving on to a terminal we do know.
 *
 * On macOS the desktop walk finds nothing, so only a named terminal works there — kitty,
 * alacritty, ghostty and wezterm take the same flags on both. Terminal.app and iTerm are not
 * driven: `open -a` cannot hand them an argv without a shell string in between.
 */
export async function openInTerminal(argv, cwd) {
  // Windows shares none of the trivia below — no PATH walk over sixteen emulators, no display
  // to check — so it is a different file entirely, reached through the same door. The caller
  // asks for a terminal and does not learn which platform it is on.
  if (process.platform === 'win32') return openInTerminalWindows(argv, cwd)

  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }
  // A macOS session always has a window server; only Linux can be headless in a way worth naming.
  if (process.platform === 'linux' && !(await hasDisplay())) {
    return { ok: false, error: 'No graphical display to open a terminal on' }
  }

  const preferred = [
    process.env.BOT_CROSSING_TERMINAL || '',
    process.env.TERMINAL || '',
    ...desktopOrder(),
    ...GENERAL_ORDER,
    'x-terminal-emulator',
  ]
  const names = [...new Set(preferred.filter(Boolean))]
  const deadline = Date.now() + WALK_BUDGET_MS
  const tried = new Set()
  let lastError = ''
  let ranOut = false

  for (const name of names) {
    if (Date.now() >= deadline) {
      ranOut = true
      break
    }
    const resolved = await findExecutable(name)
    if (!resolved || tried.has(resolved)) continue
    tried.add(resolved)

    const base = path.basename(name)
    let args
    if (base === 'x-terminal-emulator') args = ['-e', ...argv]
    else if (TERMINALS[base]) args = TERMINALS[base](cwd, argv)
    else continue

    const result = await trySpawn(resolved, args, cwd)
    if (result.ok) return { ok: true }
    lastError = result.error
  }

  if (ranOut) {
    return { ok: false, error: 'Gave up waiting for a terminal to open — is the display responding?' }
  }
  return {
    ok: false,
    error: lastError
      ? `Could not open a terminal (${lastError})`
      : 'No terminal emulator found — set BOT_CROSSING_TERMINAL or $TERMINAL, or install one (gnome-terminal, kitty, xterm)',
  }
}
