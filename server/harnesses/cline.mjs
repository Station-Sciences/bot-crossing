/**
 * Harness adapter: Cline (saoudrizwan.claude-dev) — autonomous coding agent for VS Code.
 *
 * Reads task sessions from:
 *   <VS Code globalStorage>/saoudrizwan.claude-dev/tasks/<taskId>/
 *
 * Read-only, without exception. Nothing here writes to Cline's files.
 */
import { createVSCodeAdapter } from '../lib/vscode-tasks.mjs'

const adapter = createVSCodeAdapter({
  id: 'cline',
  name: 'Cline',
  envVar: 'BOT_CROSSING_CLINE_DIR',
  extDirName: 'saoudrizwan.claude-dev',
})

export const { id, name, detect, scanThreads, openThread, newSession } = adapter
export default adapter
