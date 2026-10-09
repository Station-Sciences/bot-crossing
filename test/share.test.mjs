// test/share.test.mjs
/**
 * The one listener in this project that answers anything but its own page. Every test here is
 * about what it refuses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SHARE_PATH, createShareService, keysMatch, pickLanAddress } from '../server/share.mjs'

const KEY = 'abcdefabcdefabcdefabcdefabcdefab'

async function withService(run, { key = KEY } = {}) {
  const service = createShareService({
    host: '127.0.0.1',
    port: 0,
    getKey: async () => key,
    snapshot: async () => ({ v: 1, name: 'Mark', projects: [], threads: [] }),
  })
  await service.sync(true)
  const base = `http://127.0.0.1:${service.status().port}`
  try {
    return await run({ service, base })
  } finally {
    await service.close()
  }
}

const auth = (key) => ({ headers: { Authorization: `Bearer ${key}` } })

test('keys are compared whole, and an empty expected key matches nothing', () => {
  assert.equal(keysMatch(KEY, KEY), true)
  assert.equal(keysMatch(KEY.slice(0, 31), KEY), false)
  assert.equal(keysMatch('', ''), false)
  assert.equal(keysMatch(undefined, KEY), false)
})

test('the right key gets the snapshot', async () => {
  await withService(async ({ base }) => {
    const res = await fetch(base + SHARE_PATH, auth(KEY))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).name, 'Mark')
  })
})

test('no key, or the wrong one, is refused', async () => {
  await withService(async ({ base }) => {
    assert.equal((await fetch(base + SHARE_PATH)).status, 401)
    assert.equal((await fetch(base + SHARE_PATH, auth('0'.repeat(32)))).status, 401)
  })
})

test('nothing but the one path and method is answered', async () => {
  await withService(async ({ base }) => {
    for (const p of ['/', '/api/state', '/api/threads', '/api/open', '/share/v2/colony', SHARE_PATH + '/x']) {
      assert.equal((await fetch(base + p, auth(KEY))).status, 404, p)
    }
    assert.equal((await fetch(base + SHARE_PATH, { method: 'POST', ...auth(KEY) })).status, 404)
  })
})

test('sharing with no key configured refuses everyone', async () => {
  await withService(async ({ base }) => {
    assert.equal((await fetch(base + SHARE_PATH, auth(''))).status, 401)
  }, { key: '' })
})

test('a caller hammering the port is slowed down', async () => {
  await withService(async ({ base }) => {
    const codes = []
    for (let i = 0; i < 32; i++) codes.push((await fetch(base + SHARE_PATH, auth('0'.repeat(32)))).status)
    assert.equal(codes.filter((c) => c === 401).length, 30)
    assert.equal(codes.at(-1), 429)
  })
})

test('turning sharing off closes the port', async () => {
  const service = createShareService({ host: '127.0.0.1', port: 0, getKey: async () => KEY, snapshot: async () => ({}) })
  await service.sync(true)
  const { port } = service.status()
  assert.equal(service.status().listening, true)
  await service.sync(false)
  assert.equal(service.status().listening, false)
  await assert.rejects(fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(KEY)))
})

test('a port already in use is reported, not thrown', async () => {
  await withService(async ({ service }) => {
    const taken = service.status().port
    const second = createShareService({ host: '127.0.0.1', port: taken, getKey: async () => KEY, snapshot: async () => ({}) })
    await second.sync(true)
    const status = second.status()
    assert.equal(status.listening, false)
    assert.match(status.error, new RegExp(String(taken)))
    await second.close()
  })
})

// ── wired into the server ────────────────────────────────────────────────────

import { withServer } from './support/with-server.mjs'
import { withEnv } from './support/env.mjs'

const shareEnv = { BOT_CROSSING_SHARE_PORT: '0', BOT_CROSSING_SHARE_HOST: '127.0.0.1' }

test('turning sharing on in the colony file opens the port, and off closes it', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      let info = await (await call('/api/sharing')).json()
      assert.equal(info.listening, false)
      assert.equal(typeof info.defaultName, 'string')
      assert.ok('lanAddress' in info)

      await put({ sharing: { enabled: true, key: KEY, name: 'Mark' } })
      info = await (await call('/api/sharing')).json()
      assert.equal(info.listening, true)
      const res = await fetch(`http://127.0.0.1:${info.port}${SHARE_PATH}`, auth(KEY))
      assert.equal(res.status, 200)
      const snap = await res.json()
      assert.equal(snap.v, 1)
      assert.equal(snap.name, 'Mark')

      await put({ sharing: { enabled: false, key: KEY, name: 'Mark' } })
      assert.equal((await (await call('/api/sharing')).json()).listening, false)
    })
  )
})

test('rotating the key locks out the old one at once', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      await put({ sharing: { enabled: true, key: KEY, name: '' } })
      const { port } = await (await call('/api/sharing')).json()
      const fresh = '1'.repeat(32)
      await put({ sharing: { enabled: true, key: fresh, name: '' } })
      assert.equal((await fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(KEY))).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(fresh))).status, 200)
    })
  )
})

test('the local API is not reachable through the share port', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      await put({ sharing: { enabled: true, key: KEY, name: '' } })
      const { port } = await (await call('/api/sharing')).json()
      for (const p of ['/api/state', '/api/threads', '/api/sharing', '/api/neighbors']) {
        assert.equal((await fetch(`http://127.0.0.1:${port}${p}`, auth(KEY))).status, 404, p)
      }
    })
  )
})

test('friends asking within a few seconds share one scan, and a save starts a fresh one', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      await put({ sharing: { enabled: true, key: KEY, name: 'Mark' } })
      const { port } = await (await call('/api/sharing')).json()
      const get = async () => (await fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(KEY))).json()
      const first = await get()
      await new Promise((r) => setTimeout(r, 20))
      assert.equal((await get()).generatedAt, first.generatedAt, 'served from the same scan')
      await put({ sharing: { enabled: true, key: KEY, name: 'Marcus' } })
      assert.equal((await get()).name, 'Marcus', 'a rename shows on the next request, not after the cache runs out')
    })
  )
})

// ── the address in the link ──────────────────────────────────────────────────

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal })

test("the link's address is the real network, not a virtual adapter that happens to come first", () => {
  assert.equal(pickLanAddress({
    'vEthernet (WSL)': [v4('172.20.16.1')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4('192.168.1.42')],
  }), '192.168.1.42')
  assert.equal(pickLanAddress({ docker0: [v4('172.17.0.1')], eth0: [v4('10.1.2.3')] }), '10.1.2.3')
})

test('a private address on a virtual adapter beats a public one, and a public one beats nothing', () => {
  assert.equal(pickLanAddress({ eth0: [v4('203.0.113.5')], 'VirtualBox Host-Only': [v4('192.168.56.1')] }), '192.168.56.1')
  assert.equal(pickLanAddress({ eth0: [v4('172.32.0.1')], eth1: [v4('203.0.113.5')] }), '172.32.0.1')
  assert.equal(pickLanAddress({ lo: [v4('127.0.0.1', true)] }), '')
  assert.equal(pickLanAddress({}), '')
})
