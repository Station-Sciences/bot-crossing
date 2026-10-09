// test/neighbors.test.mjs
/**
 * Everything a friend's machine sends is untrusted input to this one. These tests feed the
 * fetcher a fake friend that lies, stalls, and changes its mind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { SHARE_PATH } from '../server/share.mjs'
import { createNeighborFetcher, validateSnapshot } from '../server/neighbors.mjs'
import { withServer } from './support/with-server.mjs'

const KEY = 'abcdefabcdefabcdefabcdefabcdefab'
const ID = 'n:0123456789abcdef'

const goodSnapshot = (extra = {}) => ({
  v: 1,
  name: 'Mark',
  generatedAt: 1,
  projects: [{ name: 'bot-crossing', cells: [[0, 0]] }],
  threads: [{
    id: ID, project: 'bot-crossing', harness: 'claude-code', harnessName: 'Claude Code',
    running: true, unread: false, hasError: false, prState: '', lastActivityAt: 60000,
    createdAt: 0, sizeBucket: 12, isErrand: false,
  }],
  ...extra,
})

/** A fake friend whose behaviour the test can change between requests. */
async function withFriend(run) {
  const friend = { reply: (req, res) => { res.writeHead(200); res.end(JSON.stringify(goodSnapshot())) } }
  const server = http.createServer((req, res) => friend.reply(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    return await run({ friend, url })
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── validation ───────────────────────────────────────────────────────────────

test('a good snapshot passes through with unknown fields dropped', () => {
  const out = validateSnapshot(goodSnapshot({ extra: 'x', threads: [{ ...goodSnapshot().threads[0], title: 'leak?' }] }))
  assert.equal(out.ok, true)
  assert.equal('extra' in out.snapshot, false)
  assert.equal('title' in out.snapshot.threads[0], false)
})

test('another version asks for an update rather than guessing', () => {
  assert.deepEqual(validateSnapshot(goodSnapshot({ v: 2 })), { ok: false, reason: 'needs-update' })
})

test('oversized or shapeless snapshots are refused', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `p${i}`, cells: [] }))
  assert.equal(validateSnapshot(goodSnapshot({ projects: many })).ok, false)
  assert.equal(validateSnapshot({ v: 1 }).ok, false)
  assert.equal(validateSnapshot('nope').ok, false)
  assert.equal(validateSnapshot(null).ok, false)
})

test('strings are trimmed and cleaned, cells must be whole-number pairs', () => {
  const out = validateSnapshot(goodSnapshot({
    name: 'Mark\u0007' + 'x'.repeat(200),
    projects: [{ name: 'bot-crossing', cells: [[0, 0], [1.5, 0], ['a', 1], [2, 2, 2], [3, 3]] }],
  }))
  assert.equal(out.snapshot.name.length, 40)
  assert.doesNotMatch(out.snapshot.name, /\u0007/)
  assert.deepEqual(out.snapshot.projects[0].cells, [[0, 0], [3, 3]])
})

test('threads with a bad id or an unknown project are dropped', () => {
  const t = goodSnapshot().threads[0]
  const out = validateSnapshot(goodSnapshot({ threads: [t, { ...t, id: 'claude-code:real' }, { ...t, id: 'n:fedcba9876543210', project: 'ghost' }] }))
  assert.equal(out.snapshot.threads.length, 1)
})

// ── fetching ─────────────────────────────────────────────────────────────────

test('a friend who answers is online', async () => {
  await withFriend(async ({ url, friend }) => {
    let auth = ''
    friend.reply = (req, res) => { auth = req.headers.authorization; res.end(JSON.stringify(goodSnapshot())) }
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'online')
    assert.equal(r.snapshot.name, 'Mark')
    assert.equal(auth, `Bearer ${KEY}`)
  })
})

test('a friend who goes quiet is away, and their last snapshot is kept', async () => {
  await withFriend(async ({ url, friend }) => {
    const fetcher = createNeighborFetcher({ timeoutMs: 200 })
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = () => {} // never answers
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot.name, 'Mark')
    assert.ok(r.lastSeenAt > 0)
  })
})

test('a friend never reached is unreachable, with nothing to draw', async () => {
  const [r] = await createNeighborFetcher({ timeoutMs: 200 }).refresh([{ id: 'nb_1', url: 'http://127.0.0.1:9', key: KEY }])
  assert.deepEqual(r, { id: 'nb_1', status: 'unreachable', lastSeenAt: 0, snapshot: null })
})

test('a rotated key reads as bad-key', async () => {
  await withFriend(async ({ url, friend }) => {
    friend.reply = (req, res) => { res.writeHead(401); res.end('{}') }
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'bad-key')
  })
})

test('a friend on another version reads as needs-update', async () => {
  await withFriend(async ({ url, friend }) => {
    friend.reply = (req, res) => res.end(JSON.stringify(goodSnapshot({ v: 2 })))
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'needs-update')
  })
})

test('garbage from a friend is treated as them being away', async () => {
  await withFriend(async ({ url, friend }) => {
    const fetcher = createNeighborFetcher()
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = (req, res) => res.end('<html>not json</html>')
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot.name, 'Mark')
  })
})

test('a snapshot older than a week is let go', async () => {
  await withFriend(async ({ url, friend }) => {
    let t = 1_000_000
    const fetcher = createNeighborFetcher({ timeoutMs: 200, now: () => t })
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = () => {}
    t += 8 * 24 * 3600 * 1000
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot, null)
  })
})

test('only http and https are fetched, and only the share path', async () => {
  let asked = []
  const fetchImpl = async (u) => { asked.push(String(u)); throw new Error('stop') }
  const fetcher = createNeighborFetcher({ fetchImpl })
  await fetcher.refresh([
    { id: 'a', url: 'file:///etc/passwd', key: KEY },
    { id: 'b', url: 'http://10.0.0.5:5275/anything?x=1', key: KEY },
  ])
  assert.deepEqual(asked, [`http://10.0.0.5:5275${SHARE_PATH}`])
})

test('/api/neighbors fetches every saved friend', async () => {
  await withFriend(async ({ url }) => {
    await withServer(async ({ call, put }) => {
      await put({ neighbors: [{ id: 'nb_1', url, key: KEY, slot: 0, addedAt: 1 }] })
      const body = await (await call('/api/neighbors')).json()
      assert.equal(body.neighbors.length, 1)
      assert.equal(body.neighbors[0].status, 'online')
      assert.equal(body.neighbors[0].snapshot.threads.length, 1)
    })
  })
})
