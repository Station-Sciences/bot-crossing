/**
 * The harness registry.
 *
 * Adding support for another agent harness means writing one module next to this file and
 * adding it to the list below. Nothing else in the codebase needs to change — the scanner,
 * the API and the browser all talk to harnesses only through the interface documented in
 * `server/harnesses/README.md`.
 */
import claudeCode from './claude-code.mjs'
import codex from './codex.mjs'

export const HARNESSES = [claudeCode, codex]

export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || null

/**
 * Which harnesses have data on this machine. Detection is per-scan rather than cached at
 * boot so that installing one while the colony is running is picked up on the next poll.
 */
export async function detectedHarnesses() {
  const flags = await Promise.all(
    HARNESSES.map(async (h) => {
      try {
        return await h.detect()
      } catch {
        return false
      }
    })
  )
  return HARNESSES.filter((_, i) => flags[i])
}
