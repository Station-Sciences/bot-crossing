import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { scanCronJobs } from '../server/scan.mjs'

test('scanCronJobs returns an array of scheduled jobs or empty list', async () => {
  const jobs = await scanCronJobs()
  assert.ok(Array.isArray(jobs), 'scanCronJobs must return an array')
})

async function withServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-tasks-'))
  process.env.BOT_CROSSING_DATA = dir
  const { apiMiddleware } = await import(`../server/api.mjs?${dir}`)

  const server = http.createServer((req, res) => apiMiddleware(req, res, () => {
    res.statusCode = 404
    res.end()
  }))

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const call = (pathname, opts = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...opts,
      headers: { Origin: `http://127.0.0.1:${port}`, ...(opts.headers || {}) },
    })

  try {
    await run({ call, dir })
  } finally {
    server.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('/api/tasks returns in-flight tasks and scheduled cronjobs', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/tasks')
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.tasks), 'tasks must be an array')
    assert.ok(Array.isArray(data.cronjobs), 'cronjobs must be an array')
    assert.ok(typeof data.scannedAt === 'number', 'scannedAt must be a timestamp')
  })
})
