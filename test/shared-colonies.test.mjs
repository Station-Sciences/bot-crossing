/**
 * Shared colonies: the guest socket's allowlist, the merge's collision safety, and the
 * discovery datagram's parsing. Nothing here touches the real network beyond loopback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { GuestServer, guestThread, hostAllowed, normalizeIp } from '../server/guest.mjs'
import { Neighbors, cleanNeighbor } from '../server/neighbors.mjs'
import { Discovery } from '../server/discovery.mjs'
import { allocateCells, colonyAnchor } from '../src/world/plots.js'

// ── the guest socket ──────────────────────────────────────────────────────────

const FIXTURE_THREAD = {
  id: 'claude-code:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: 'Fix the flux capacitor',
  project: 'wra',
  projectPath: 'C:\\somewhere\\wra',
  canOpen: true,
  ref: { desktopSessionId: 'local_x', cliSessionId: 'y', cwd: 'C:\\somewhere\\wra' },
  transcriptFile: 'C:\\Users\\chantal\\.claude\\projects\\x\\y.jsonl',
  running: true,
  sizeBytes: 12345,
}

async function withGuest(fn) {
  const guest = new GuestServer({
    port: 0, // any free port — the tests read it back off the socket
    instanceId: 'test-instance',
    getName: () => 'Chantal',
    getThreads: async () => [FIXTURE_THREAD],
    getAllowedHosts: () => [], // loopback is always allowed, so the tests still reach it
  })
  guest.start()
  await new Promise((resolve) => guest._server.once('listening', resolve))
  const base = `http://127.0.0.1:${guest._server.address().port}`
  try {
    await fn(base)
  } finally {
    guest.stop()
  }
}

test('guest threads carry nothing actionable and no local paths', () => {
  const t = guestThread(FIXTURE_THREAD)
  assert.equal(t.canOpen, false)
  assert.equal(t.ref, undefined)
  assert.equal(t.transcriptFile, undefined)
  // Everything a visitor legitimately looks at is still there.
  assert.equal(t.title, FIXTURE_THREAD.title)
  assert.equal(t.running, true)
})

test('the guest socket answers info and threads, and nothing else', async () => {
  await withGuest(async (base) => {
    const info = await (await fetch(`${base}/guest/info`)).json()
    assert.equal(info.app, 'bot-crossing')
    assert.equal(info.name, 'Chantal')

    const res = await fetch(`${base}/guest/threads`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.threads.length, 1)
    assert.equal(body.threads[0].ref, undefined)
    assert.equal(body.threads[0].canOpen, false)

    // The action routes of the real API must not exist here — that absence is the security
    // model, so it is asserted rather than assumed.
    for (const path of ['/api/open', '/api/state', '/api/new-session', '/api/threads', '/guest/anything']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} must not exist on the guest socket`)
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await fetch(`${base}/guest/threads`, { method })).status, 405, `${method} must be refused`)
    }
  })
})

// ── the origin check ────────────────────────────────────────────────────────────

test('the guest socket answers only loopback and added neighbours', () => {
  // Loopback, however it is spelled, always: the local page and the tests reach the socket.
  assert.equal(hostAllowed('127.0.0.1', []), true)
  assert.equal(hostAllowed('::1', []), true)
  assert.equal(hostAllowed('::ffff:127.0.0.1', []), true)

  // A LAN host is answered only when it is on the neighbour list.
  const neighbours = ['192.168.55.42', 'chantal-pc']
  assert.equal(hostAllowed('192.168.55.42', neighbours), true)
  // Node reports a v4 client on a dual-stack socket with the ::ffff: prefix.
  assert.equal(hostAllowed('::ffff:192.168.55.42', neighbours), true)
  // A stranger on the same LAN is refused, even with sharing on and an allowlist set.
  assert.equal(hostAllowed('192.168.55.99', neighbours), false)
  assert.equal(hostAllowed('192.168.55.99', []), false)
  assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1')
})

// ── the merge ─────────────────────────────────────────────────────────────────

test('cleanNeighbor drops garbage and keeps the valid shape', () => {
  assert.equal(cleanNeighbor(null), null)
  assert.equal(cleanNeighbor({ host: '', port: 5275 }), null)
  assert.equal(cleanNeighbor({ host: 'chantal-pc', port: 0 }), null)
  assert.equal(cleanNeighbor({ host: 'chantal pc; rm -rf', port: 5275 }), null)
  assert.deepEqual(cleanNeighbor({ name: 'Chantal', host: 'chantal-pc', port: 5275 }), {
    name: 'Chantal',
    host: 'chantal-pc',
    port: 5275,
  })
  // A nameless neighbour is named after its host rather than refused.
  assert.equal(cleanNeighbor({ host: '10.0.0.7', port: 5275 }).name, '10.0.0.7')
})

test('merged threads can never collide with local ones, and are inert', () => {
  const n = new Neighbors()
  n.setConfigured([{ name: 'Chantal', host: 'chantal-pc', port: 5275 }])
  // Seed the cache directly — the fetch path is the guest-socket test's job.
  n._cache.set('chantal-pc:5275', {
    name: 'Chantal',
    okAt: Date.now(),
    fetchedAt: Date.now(),
    threads: [{ ...guestThread(FIXTURE_THREAD) }],
  })

  const { threads, colonies } = n.merged()
  assert.equal(threads.length, 1)
  const t = threads[0]
  // Same session id scanned on both machines still yields a distinct id here.
  assert.equal(t.id, `guest:chantal-pc:5275:${FIXTURE_THREAD.id}`)
  // Same repo name on both machines still yields a distinct plot.
  assert.equal(t.project, 'Chantal · wra')
  assert.equal(t.colony, 'Chantal')
  assert.equal(t.canOpen, false)
  assert.equal(t.ref, undefined)

  assert.equal(colonies.length, 1)
  assert.equal(colonies[0].online, true)
})

test('a neighbour that stopped answering goes offline but keeps its last threads', () => {
  const n = new Neighbors()
  n.setConfigured([{ name: 'Chantal', host: 'chantal-pc', port: 5275 }])
  n._cache.set('chantal-pc:5275', {
    name: 'Chantal',
    okAt: Date.now() - 10 * 60 * 1000, // long silent
    fetchedAt: Date.now(),
    threads: [guestThread(FIXTURE_THREAD)],
  })
  const { threads, colonies } = n.merged()
  assert.equal(colonies[0].online, false)
  assert.equal(threads.length, 1, 'the district survives the machine sleeping')
  assert.equal(threads[0].colonyOnline, false)
})

test('removing a neighbour drops its cache with it', () => {
  const n = new Neighbors()
  n.setConfigured([{ name: 'Chantal', host: 'chantal-pc', port: 5275 }])
  n._cache.set('chantal-pc:5275', { name: 'Chantal', okAt: Date.now(), fetchedAt: Date.now(), threads: [] })
  n.setConfigured([])
  assert.equal(n.merged().threads.length, 0)
  assert.equal(n.merged().colonies.length, 0)
})

// ── district layout ─────────────────────────────────────────────────────────────

const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2

test("a visiting colony's repos cluster near its anchor, out past the home zones", () => {
  const anchor = colonyAnchor('Chantal')
  const layout = allocateCells([
    { id: 'home-a', size: 20 },
    { id: 'home-b', size: 10 },
    { id: 'Chantal · wra', size: 3, anchor },
    { id: 'Chantal · mios', size: 5, anchor },
  ])

  // Both of Chantal's repos land within a couple of rings of her anchor…
  for (const id of ['Chantal · wra', 'Chantal · mios']) {
    const cells = layout.get(id)
    assert.ok(cells.length > 0, `${id} got no cells`)
    const nearest = Math.min(...cells.map((c) => hexDist(c, anchor)))
    assert.ok(nearest <= 2, `${id} settled ${nearest} rings from its anchor`)
  }

  // …and well clear of the home zones, which sit in the middle.
  const home = [...layout.get('home-a'), ...layout.get('home-b')]
  const guest = layout.get('Chantal · mios')
  const farthestHome = Math.max(...home.map((c) => hexDist(c, { q: 0, r: 0 })))
  const nearestGuest = Math.min(...guest.map((c) => hexDist(c, { q: 0, r: 0 })))
  assert.ok(nearestGuest > farthestHome, 'the district overlaps the home zones instead of standing apart')
})

test("a district member stranded far from its anchor is pulled back to the district", () => {
  const anchor = colonyAnchor('Chantie')
  // Its memory says it sits near the middle of the map — a stale placement from before its
  // colony was known. It must not stay there; it belongs in Chantie's district.
  const stale = new Map([['Chantie · bot-crossing', [{ q: 0, r: 0 }]]])
  const layout = allocateCells(
    [
      { id: 'Chantie · mios', size: 60, anchor },
      { id: 'Chantie · bot-crossing', size: 1, anchor },
    ],
    stale
  )
  const root = layout.get('Chantie · bot-crossing')[0]
  assert.ok(hexDist(root, anchor) <= 3, `bot-crossing stayed ${hexDist(root, anchor)} rings from the anchor`)
})

test('two colonies that both know a repo called "wra" get separate districts', () => {
  const layout = allocateCells([
    { id: 'Chantal · wra', size: 2, anchor: colonyAnchor('Chantal') },
    { id: 'Bram · wra', size: 2, anchor: colonyAnchor('Bram') },
  ])
  const c = layout.get('Chantal · wra')
  const b = layout.get('Bram · wra')
  // No shared cell between the two districts.
  const cKeys = new Set(c.map((x) => `${x.q},${x.r}`))
  assert.ok(b.every((x) => !cKeys.has(`${x.q},${x.r}`)), 'the two "wra" districts overlap')
})

// ── discovery ─────────────────────────────────────────────────────────────────

test('discovery parses well-formed announcements and refuses everything else', () => {
  const d = new Discovery({ instanceId: 'me' })
  const from = { address: '10.0.0.7' }
  const hear = (msg) => d._onMessage(Buffer.from(JSON.stringify(msg)), from)

  hear({ v: 1, app: 'bot-crossing', name: 'Chantal', guestPort: 5275, instanceId: 'her' })
  assert.equal(d.peers().length, 1)
  assert.deepEqual(d.peers()[0].host, '10.0.0.7')

  // Our own echo, a wrong app, a bad port, an empty name: none of them become peers.
  hear({ v: 1, app: 'bot-crossing', name: 'Me', guestPort: 5275, instanceId: 'me' })
  hear({ v: 1, app: 'other-thing', name: 'X', guestPort: 5275, instanceId: 'x' })
  hear({ v: 1, app: 'bot-crossing', name: 'X', guestPort: 999999, instanceId: 'x' })
  hear({ v: 1, app: 'bot-crossing', name: '   ', guestPort: 5275, instanceId: 'x' })
  d._onMessage(Buffer.from('not json'), from)
  assert.equal(d.peers().length, 1)

  // And a peer that goes quiet falls off the list.
  d._peers.get('10.0.0.7:5275').lastSeen = Date.now() - 10 * 60 * 1000
  assert.equal(d.peers().length, 0)
})
