/**
 * VS Code as the place a thread lands when its harness's own app is not installed.
 *
 * Only `server/api.mjs` uses this. An adapter says what VS Code should show — `editor: { uri,
 * folder }`, the extension's `vscode://<publisher.name>/…` link and the repo it belongs in —
 * and this decides how, so no harness knowledge lives here.
 *
 * The folder goes first and is awaited: the `code` CLI fronts the window that already has it
 * (or opens one), and VS Code hands a `vscode://` URL to the last focused window — so the
 * extension link that follows lands beside the right repo rather than in whatever was open.
 * `--open-url` is the flag VS Code's own Linux protocol handler uses; it is undocumented in
 * `--help` but stable, and it saves depending on the OS knowing the `vscode:` scheme.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from './fsutil.mjs'

const CODE_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/snap/bin']

export const codeBinary = () => findExecutable(process.env.BOT_CROSSING_CODE || 'code', CODE_DIRS)

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000 }, (err) => resolve(!err))
  })
}

/**
 * `folder` must already be checked by the caller — it came from the page. Either half may be
 * missing; with neither there is nothing to do.
 */
export async function openInVsCode({ uri, folder } = {}) {
  if (!uri && !folder) return { ok: false, error: 'Nothing to open in VS Code' }
  const bin = await codeBinary()
  if (!bin) return { ok: false, error: 'VS Code’s `code` command was not found on this machine' }
  if (folder && !(await run(bin, [folder]))) return { ok: false, error: 'VS Code would not open that folder' }
  if (uri && !(await run(bin, ['--open-url', uri]))) return { ok: false, error: 'VS Code would not open that thread' }
  return { ok: true, via: 'vscode' }
}
