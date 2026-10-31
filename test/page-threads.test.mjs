import test from 'node:test'
import assert from 'node:assert/strict'
import { threadsForPage } from '../server/lib/page-threads.mjs'

const full = (id, extra = {}) => ({
  id,
  harness: 'claude-code',
  project: 'alpha',
  title: `Thread ${id}`,
  lastActivityAt: 5,
  ref: { cliSessionId: id, desktopSessionId: `desk-${id}` },
  running: false,
  unread: true,
  preview: 'a long transcript preview '.repeat(40),
  subagents: [{ id: 'sub' }],
  ...extra,
})

test('live threads go whole, colony archives as stubs, harness archives not at all', () => {
  const out = threadsForPage([
    full('live'),
    full('here', { archived: true, archivedInHarness: false, archivedAs: ['desk-here'] }),
    full('harness', { archived: true, archivedInHarness: true }),
    // No archive list on disk: the only archived flag is the harness's own.
    full('unreconciled', { archived: true }),
  ])
  assert.deepEqual(
    out.map((t) => t.id),
    ['live', 'here']
  )
  assert.equal(out[0].preview.length > 100, true)
  assert.deepEqual(out[1], {
    id: 'here',
    harness: 'claude-code',
    project: 'alpha',
    title: 'Thread here',
    lastActivityAt: 5,
    archived: true,
    archivedInHarness: false,
    archivedAs: ['desk-here'],
  })
})
