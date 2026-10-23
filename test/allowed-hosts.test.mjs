/**
 * BOT_CROSSING_ALLOWED_HOSTS: extra names the Host check accepts, for a server that is
 * reached through an address it cannot see on its own interfaces (WSL2 behind Windows).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withServer } from './support/with-server.mjs'
import { withEnv } from './support/env.mjs'

/** A GET with an explicit Host header. An unknown route answers 404 once past the gate, 403 when refused. */
function statusFor(port, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/nope', headers: { Host: host } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      .on('error', reject)
  })
}

test('names in BOT_CROSSING_ALLOWED_HOSTS pass the Host check, others still do not', async () => {
  await withEnv({ BOT_CROSSING_ALLOWED_HOSTS: 'my-pc.example, 192.0.2.10' }, () =>
    withServer(async ({ call }) => {
      const port = new URL((await call('/api/nope')).url).port
      assert.equal(await statusFor(port, 'my-pc.example:5274'), 404)
      assert.equal(await statusFor(port, '192.0.2.10:5274'), 404)
      assert.equal(await statusFor(port, 'evil.example:5274'), 403)
    })
  )
})

test('an entry is read the way a request Host is: any case, with a port, bracketed or bare IPv6', async () => {
  await withEnv({ BOT_CROSSING_ALLOWED_HOSTS: 'My-PC.example, 192.0.2.10:5274, [fd00::1], fd00::2' }, () =>
    withServer(async ({ call }) => {
      const port = new URL((await call('/api/nope')).url).port
      assert.equal(await statusFor(port, 'my-pc.example:5274'), 404)
      assert.equal(await statusFor(port, '192.0.2.10:5274'), 404)
      assert.equal(await statusFor(port, '[fd00::1]:5274'), 404)
      assert.equal(await statusFor(port, '[fd00::2]:5274'), 404)
      assert.equal(await statusFor(port, 'evil.example:5274'), 403)
    })
  )
})

test('with the variable unset a foreign Host is refused as before', async () => {
  await withEnv({ BOT_CROSSING_ALLOWED_HOSTS: undefined }, () =>
    withServer(async ({ call }) => {
      const port = new URL((await call('/api/nope')).url).port
      assert.equal(await statusFor(port, 'my-pc.example:5274'), 403)
      assert.equal(await statusFor(port, 'localhost:5274'), 404)
    })
  )
})
