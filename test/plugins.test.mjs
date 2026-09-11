import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

async function withServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-plugins-'))
  process.env.BOT_CROSSING_DATA = dir
  const { apiMiddleware } = await import(`../server/api.mjs?cacheBust=${Date.now()}_${Math.random()}`)

  const server = http.createServer((req, res) => apiMiddleware(req, res, () => {
    res.writeHead(404)
    res.end()
  }))

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    await run({ base, dir })
  } finally {
    server.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('PluginManager: reports status on /api/plugins without breaking core', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/plugins`, {
      headers: { Origin: base }
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.installed !== undefined)
  })
})

test('PluginManager: reports client script list on /api/plugins/client-scripts', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/plugins/client-scripts`, {
      headers: { Origin: base }
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.scripts))
  })
})
