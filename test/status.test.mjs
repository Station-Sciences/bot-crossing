import test from 'node:test'
import assert from 'node:assert/strict'
import { STALE_MS, allSleeping, statusFor } from '../src/game/status.js'

const now = 10 * STALE_MS

test('the precedence is errored, running, merged, unread, stale, idle', () => {
  const t = { hasError: true, running: true, prState: 'MERGED', unread: true, lastActivityAt: 0 }
  assert.equal(statusFor(t, now), 'blocked')
  assert.equal(statusFor({ ...t, hasError: false }, now), 'working')
  assert.equal(statusFor({ ...t, hasError: false, running: false }, now), 'celebrating')
  assert.equal(statusFor({ unread: true, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(statusFor({ lastActivityAt: 0 }, now), 'sleeping')
  assert.equal(statusFor({ lastActivityAt: now - 1000 }, now), 'idle')
})

test('a repo is dormant only when every thread in it sleeps', () => {
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: 0 }], now), true)
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: now }], now), false)
  assert.equal(allSleeping([], now), false)
})
