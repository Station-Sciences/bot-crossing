/**
 * CLI command generator for various agent harnesses.
 *
 * Used by the HUD to copy direct resume/open commands to the user's clipboard,
 * and to prepare commands when launching or resuming sessions with prompts.
 */
export function cliCommandFor(thread, prompt = '') {
  if (!thread) return ''
  const h = thread.harness
  const ref = thread.ref || {}
  const pFlag = prompt ? ` -p ${JSON.stringify(prompt)}` : ''

  if (h === 'claude-code') {
    if (ref.cliSessionId) return `claude --resume ${ref.cliSessionId}${pFlag}`
    return `claude${pFlag}`
  }
  if (h === 'codex') {
    if (ref.sessionId) {
      return prompt
        ? `codex resume ${ref.sessionId} ${JSON.stringify(prompt)}`
        : `codex resume ${ref.sessionId}`
    }
    return prompt ? `codex ${JSON.stringify(prompt)}` : `codex`
  }
  if (h === 'cline' || h === 'roo-code') {
    return `code "${thread.projectPath || thread.cwd || '.'}"`
  }
  if (h === 'cursor') {
    return `cursor "${thread.projectPath || thread.cwd || '.'}"`
  }
  if (h === 'antigravity') {
    return `antigravity "${thread.projectPath || thread.cwd || '.'}"`
  }
  return `cd "${thread.projectPath || thread.cwd || '.'}"`
}
