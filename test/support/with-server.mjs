import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

/** `call` sets the `Origin` header the same-origin check expects, so a test never trips it by accident. */
export async function withServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
  process.env.BOT_CROSSING_DATA = dir
  // Imported per-server so DATA_DIR is read fresh; the query string defeats the module cache.
  const { apiMiddleware } = await import(`../../server/api.mjs?${dir}`)
  const server = http.createServer((req, res) => apiMiddleware(req, res, null))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (p, opts) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      ...opts,
    })
  try {
    return await run({ call, dir, put: (b) => call('/api/state', { method: 'PUT', body: JSON.stringify(b) }) })
  } finally {
    server.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}
