import test from 'node:test'
import assert from 'node:assert/strict'
import { STALE_MS, allSleeping, isAlarming, statusFor } from '../src/game/status.js'

const now = 10 * STALE_MS

test('the precedence is errored, running, merged, unread, stale, idle', () => {
  const t = { hasError: true, running: true, prState: 'MERGED', unread: true, lastActivityAt: 0 }
  assert.equal(statusFor({ ...t, lastActivityAt: now - 1000 }, now), 'blocked')
  assert.equal(statusFor({ ...t, hasError: false }, now), 'working')
  assert.equal(statusFor({ ...t, hasError: false, running: false }, now), 'celebrating')
  assert.equal(statusFor({ unread: true, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(statusFor({ lastActivityAt: 0 }, now), 'sleeping')
  assert.equal(statusFor({ lastActivityAt: now - 1000 }, now), 'idle')
})

test('an error goes quiet on the same three-day clock as everything else', () => {
  const failed = { hasError: true, lastActivityAt: now - STALE_MS }
  assert.equal(isAlarming(failed, now), true, 'still red at exactly three days')
  assert.equal(statusFor(failed, now), 'blocked')
  const abandoned = { hasError: true, lastActivityAt: now - STALE_MS - 1 }
  assert.equal(isAlarming(abandoned, now), false)
  assert.equal(statusFor(abandoned, now), 'sleeping', 'an old failure sleeps instead of holding its bot slumped')
  assert.equal(allSleeping([abandoned], now), true, 'and lets its repo fold away with the other quiet ones')
})

test('a repo is dormant only when every thread in it sleeps', () => {
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: 0 }], now), true)
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: now }], now), false)
  assert.equal(allSleeping([], now), false)
})
