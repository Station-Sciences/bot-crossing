/**
 * Harness adapter: Roo Code (rooveterinaryinc.roo-cline) — autonomous AI coding agent for VS Code.
 *
 * Reads task sessions from:
 *   <VS Code globalStorage>/rooveterinaryinc.roo-cline/tasks/<taskId>/
 *
 * Read-only, without exception. Nothing here writes to Roo Code's files.
 */
import { createVSCodeAdapter } from '../lib/vscode-tasks.mjs'

const adapter = createVSCodeAdapter({
  id: 'roo-code',
  name: 'Roo Code',
  envVar: 'BOT_CROSSING_ROO_CODE_DIR',
  extDirName: 'rooveterinaryinc.roo-cline',
})

export const { id, name, detect, scanThreads, openThread, newSession } = adapter
export default adapter
