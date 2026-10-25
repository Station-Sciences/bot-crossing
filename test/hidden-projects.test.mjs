/**
 * The colony only draws repos that are alive today.
 *
 * A harness never deletes a transcript, so left alone the map grows a zone for every repo you
 * have ever run a session in and never shrinks. `liveThreadsForColony` is the line that keeps it
 * to what is actually working: a live process, or activity inside the last day. Everything older
 * is still on disk and comes back the moment it stirs — it just stops owning ground meanwhile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_WINDOW_MS,
  isActiveToday,
  liveThreadsForColony,
} from '../src/game/hidden-projects.js'

const NOW = 1_000_000_000_000
const thread = (over = {}) => ({ id: 't', project: 'repo', archived: false, lastActivityAt: NOW, ...over })

test('a thread that stirred in the last day keeps its ground', () => {
  assert.equal(isActiveToday(thread({ lastActivityAt: NOW - 60_000 }), NOW), true)
  assert.equal(isActiveToday(thread({ lastActivityAt: NOW - (ACTIVE_WINDOW_MS - 1) }), NOW), true)
})

test('a thread quiet for more than a day loses its ground', () => {
  assert.equal(isActiveToday(thread({ lastActivityAt: NOW - ACTIVE_WINDOW_MS - 1 }), NOW), false)
})

test('a live process holds its ground however long it has been quiet', () => {
  const stale = thread({ lastActivityAt: NOW - 10 * ACTIVE_WINDOW_MS, hasLiveProcess: true })
  assert.equal(isActiveToday(stale, NOW), true)
})

test('a thread with no activity stamp at all is treated as long gone', () => {
  assert.equal(isActiveToday({ id: 't', project: 'repo' }, NOW), false)
})

test('the colony draws only the repos that are active today', () => {
  const threads = [
    thread({ id: 'fresh', lastActivityAt: NOW - 1000 }),
    thread({ id: 'live', lastActivityAt: NOW - 5 * ACTIVE_WINDOW_MS, hasLiveProcess: true }),
    thread({ id: 'stale', lastActivityAt: NOW - 2 * ACTIVE_WINDOW_MS }),
  ]
  const drawn = liveThreadsForColony(threads, new Set(), new Set(), NOW).map((t) => t.id)
  assert.deepEqual(drawn, ['fresh', 'live'], 'the day-old repo is folded away, the live one is not')
})

test('active-today is applied on top of archive and hide, not instead of them', () => {
  const threads = [
    thread({ id: 'archivedId', lastActivityAt: NOW }),
    thread({ id: 'hiddenId', project: 'secret', lastActivityAt: NOW }),
    thread({ id: 'ok', lastActivityAt: NOW }),
  ]
  const drawn = liveThreadsForColony(threads, new Set(['archivedId']), new Set(['secret']), NOW).map((t) => t.id)
  assert.deepEqual(drawn, ['ok'])
})
