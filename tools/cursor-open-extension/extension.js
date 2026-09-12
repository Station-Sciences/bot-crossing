const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')

const FILE = path.join(os.homedir(), '.cursor', 'bot-crossing-open.json')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_AGE_MS = 30_000

function activate(context) {
  let lastRequestId = ''

  const tryFocus = async () => {
    let request
    try {
      request = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    } catch {
      return
    }
    if (
      !request ||
      typeof request.composerId !== 'string' ||
      !UUID.test(request.composerId) ||
      typeof request.requestId !== 'string' ||
      request.requestId === lastRequestId ||
      !Number(request.at) ||
      Date.now() - Number(request.at) > MAX_AGE_MS
    ) {
      return
    }

    if (request.workspacePath) {
      const normalize = (value) => {
        const resolved = path.resolve(String(value))
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
      }
      const wanted = normalize(request.workspacePath)
      const folders = vscode.workspace.workspaceFolders || []
      if (!folders.some((folder) => normalize(folder.uri.fsPath) === wanted)) return
    }

    // Consume before focusing: a stale request must never hijack a later window activation.
    lastRequestId = request.requestId
    try {
      fs.unlinkSync(FILE)
    } catch {
      /* another window consumed it */
    }
    try {
      await vscode.commands.executeCommand('composer.focusComposer', request.composerId)
    } catch {
      /* workspace opening still succeeded; a later click writes a fresh request */
    }
  }

  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const watcher = fs.watch(path.dirname(FILE), { persistent: false }, (_event, name) => {
      if (name === path.basename(FILE)) void tryFocus()
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch {
    /* polling below remains available */
  }
  const interval = setInterval(tryFocus, 2000)
  context.subscriptions.push({ dispose: () => clearInterval(interval) })
  void tryFocus()
}

function deactivate() {}

module.exports = { activate, deactivate }
