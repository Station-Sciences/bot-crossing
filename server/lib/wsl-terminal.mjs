/**
 * WSL plumbing: put a command in a Windows Terminal tab that runs inside this distro.
 *
 * Under WSL the server is a Linux process, so `openInTerminal` would otherwise walk the Linux
 * emulators — and the one it finds is usually a bare X window drawn through WSLg, if anything.
 * The terminal the person actually uses is Windows Terminal, which WSL interop can launch
 * directly: `wt.exe` opens a tab, and `wsl.exe -d <distro> --cd <dir>` puts it back in here.
 *
 * The command runs inside an interactive login shell, because that is where PATH is built —
 * nvm, ~/.local/bin and the rest live in the shell's rc files, and a bare `wsl.exe -e` would
 * start the CLI without them. When the command ends the tab drops to that shell rather than
 * closing, for the same reason `cmd /k` is used on Windows: you are meant to keep typing in it.
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { findExecutable } from './fsutil.mjs'

/** True when this Linux process is running under WSL with Windows interop available. */
export async function isWsl() {
  if (process.platform !== 'linux') return false
  if (!process.env.WSL_DISTRO_NAME) return false
  return fsp.access('/proc/sys/fs/binfmt_misc/WSLInterop').then(() => true, () => false)
}

/** Single-quote for a POSIX shell: the one form in which nothing inside is special. */
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The argument list for `wt.exe`, or null when the command cannot be carried safely.
 *
 * Three parsers stand between this array and the shell: WSL interop builds a Windows command
 * line, Windows Terminal splits it into subcommands on `;`, and `wsl.exe` splits what is left
 * by the MSVC rules. Single quotes and backslashes pass all three untouched; a `;` survives
 * only when escaped as `\;`, which Windows Terminal turns back into `;`; a double quote does not
 * survive reliably at all, so a command containing one is refused rather than mangled.
 */
export function wslTerminalArgs(argv, cwd, { distro, shell = '/bin/bash' }) {
  const parts = [...argv, cwd, shell, distro]
  if (!distro || parts.some((s) => typeof s !== 'string' || s.includes('"'))) return null
  const script = `${argv.map(shellQuote).join(' ')}; exec ${shellQuote(shell)} -l`
  return [
    '-w', '0', 'new-tab',
    'wsl.exe', '-d', distro, '--cd', cwd,
    '-e', shell, '-lic', script.replace(/;/g, '\\;'),
  ]
}

/**
 * Open `argv` in a new Windows Terminal tab, in this distro, sitting in `cwd`. Returns null when
 * Windows Terminal is not there or the command cannot be carried, so the caller falls back to
 * the Linux walk; otherwise `{ ok, error? }`. `wt.exe` hands the tab to its running window and
 * exits 0 at once, so a non-zero exit is a refusal worth reporting.
 */
export async function openInTerminalWsl(argv, cwd) {
  const wt = await findExecutable('wt.exe')
  if (!wt) return null
  const args = wslTerminalArgs(argv, cwd, {
    distro: process.env.WSL_DISTRO_NAME,
    shell: process.env.SHELL || '/bin/bash',
  })
  if (!args) return null
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(wt, args, { stdio: 'ignore', detached: true })
    } catch (err) {
      return resolve({ ok: false, error: err?.message || String(err) })
    }
    child.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }))
    child.on('exit', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `wt.exe exited with code ${code}` })
    })
    child.unref()
  })
}
