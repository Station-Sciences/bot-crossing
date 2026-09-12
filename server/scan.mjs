/**
 * Harness-agnostic thread scanning.
 *
 * This module knows nothing about any particular agent harness: it asks every harness that
 * is present on this machine for its threads, stamps each one with which harness it came
 * from, and hands back a single list sorted by recency. Everything harness-specific lives
 * in `server/harnesses/` — see the README there.
 */
import { HARNESSES, detectedHarnesses, harnessById } from './harnesses/index.mjs'
import { addRepositoryIdentity } from './lib/repository-identity.mjs'

/**
 * Every thread from every detected harness.
 *
 * A harness that throws is skipped rather than allowed to take the scan down with it: one
 * broken adapter should cost you that harness's threads, not the whole colony.
 */
export async function scanThreads() {
  const harnesses = await detectedHarnesses()
  const lists = await Promise.all(
    harnesses.map(async (h) => {
      try {
        const threads = await h.scanThreads()
        return threads.map((t) => ({ ...t, harness: h.id, harnessName: h.name }))
      } catch (err) {
        console.warn(`bot-crossing: harness "${h.id}" failed to scan —`, err?.message || err)
        return []
      }
    })
  )
  const threads = await addRepositoryIdentity(lists.flat())
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/** What the HUD shows in the harness list: who is installed, and what they can do. */
export async function harnessStatus() {
  const detected = new Set((await detectedHarnesses()).map((h) => h.id))
  return Promise.all(
    HARNESSES.map(async (h) => ({
      id: h.id,
      name: h.name,
      detected: detected.has(h.id),
      // Optional. An adapter that can see its harness but cannot read it — wrong Node, a store
      // it does not understand — says why here instead of failing silently on every poll.
      error: h.diagnostic ? await h.diagnostic().catch(() => '') : '',
    }))
  )
}

/** The harness to use when a caller has not said — the first one present on this machine. */
export async function defaultHarness() {
  const [first] = await detectedHarnesses()
  return first?.id || ''
}

const dispatch = (harnessId) => {
  const h = harnessById(harnessId)
  if (!h) throw new Error(`Unknown harness "${harnessId}"`)
  return h
}

/** Both may be async: an adapter that has to look for a CLI on disk cannot answer synchronously. */
export const openThread = async (harnessId, ref) => dispatch(harnessId).openThread(ref)

export const newSession = async (harnessId, dir) => dispatch(harnessId).newSession(dir)
