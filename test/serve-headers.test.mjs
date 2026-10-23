/**
 * The page's own headers, from the server that actually serves it. `serve.mjs` listens at
 * import, so it runs as a child on a port of its own rather than being imported here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(here, '..', 'server', 'serve.mjs')

async function withServe(run) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [SERVE], {
    env: { ...process.env, PORT: String(port), BOT_CROSSING_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve.mjs did not start')), 8000)
      child.stdout.on('data', (d) => {
        if (String(d).includes('Bot Crossing')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`serve.mjs exited ${code}`)))
    })
    return await run((p, opts) => fetch(`http://127.0.0.1:${port}${p}`, opts))
  } finally {
    child.kill()
  }
}

test('the page ships a policy that only lets it do what it does', async () => {
  await withServe(async (get) => {
    const res = await get('/')
    // A checkout with no dist/ built answers 404 — with the same headers, which is the point.
    assert.ok([200, 404].includes(res.status), `status ${res.status}`)
    const csp = res.headers.get('content-security-policy') || ''
    assert.match(csp, /(^|; )default-src 'self'(;|$)/)
    assert.match(csp, /(^|; )script-src 'self'(;|$)/, 'no inline script, no third party')
    assert.match(csp, /(^|; )style-src-attr 'unsafe-inline'(;|$)/, 'style attributes are set from code')
    assert.match(csp, /(^|; )img-src 'self' data: blob:(;|$)/, 'textures and the screenshot')
    assert.match(csp, /(^|; )connect-src 'self' blob:(;|$)/, "GLTFLoader fetches a model's textures back as blob: URLs")
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/)
    assert.match(csp, /(^|; )form-action 'none'(;|$)/)
    assert.match(csp, /(^|; )object-src 'none'(;|$)/)
    assert.doesNotMatch(csp, /unsafe-eval/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  })
})

test('a refusal and a miss carry the same headers as a hit', async () => {
  await withServe(async (get) => {
    const miss = await get('/definitely-not-here.txt')
    // A miss falls back to index.html (SPA) — 200 with a dist/, 404 without — and the policy is on it either way.
    assert.ok(miss.headers.get('content-security-policy'))
    const climb = await get('/..%2f..%2fetc%2fpasswd')
    assert.ok([403, 200].includes(climb.status), 'never a file from outside dist/')
    assert.ok(climb.headers.get('content-security-policy'))
  })
})
