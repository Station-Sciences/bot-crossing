import test from 'node:test'
import assert from 'node:assert/strict'
import { cliCommandFor } from '../src/game/commands.js'
import claudeCode from '../server/harnesses/claude-code.mjs'

test('cliCommandFor formats resume commands correctly for each harness', () => {
  assert.equal(
    cliCommandFor({ harness: 'claude-code', ref: { cliSessionId: 'abc-123' } }),
    'claude --resume abc-123'
  )

  assert.equal(
    cliCommandFor({ harness: 'claude-code', ref: { cliSessionId: 'abc-123' } }, 'fix the tests'),
    'claude --resume abc-123 -p "fix the tests"'
  )

  assert.equal(
    cliCommandFor({ harness: 'codex', ref: { sessionId: 'xyz-789' } }),
    'codex resume xyz-789'
  )

  assert.equal(
    cliCommandFor({ harness: 'codex', ref: { sessionId: 'xyz-789' } }, 'continue refactor'),
    'codex resume xyz-789 "continue refactor"'
  )

  assert.equal(
    cliCommandFor({ harness: 'cline', projectPath: '/home/user/project' }),
    'code "/home/user/project"'
  )

  assert.equal(
    cliCommandFor({ harness: 'roo-code', cwd: '/home/user/roo-repo' }),
    'code "/home/user/roo-repo"'
  )

  assert.equal(
    cliCommandFor({ harness: 'antigravity', projectPath: '/home/user/anti' }),
    'antigravity "/home/user/anti"'
  )

  assert.equal(
    cliCommandFor({ harness: 'cursor', cwd: '/home/user/cursor-repo' }),
    'cursor "/home/user/cursor-repo"'
  )

  assert.equal(cliCommandFor(null), '')
})

test('claudeCode.openThread includes -p prompt flag when prompt argument is passed', async () => {
  const cliSessionId = '2df3987c-02d3-405e-b8f5-da30e3835213'
  const res = await claudeCode.openThread({ cliSessionId, cwd: '/tmp/proj' }, 'ship the release')
  assert.equal(res.ok, true)
  if (res.command) {
    assert.deepEqual(res.command.argv.slice(-2), ['-p', 'ship the release'])
  }
})

test('/api/terminal route rejects missing or non-existent folders', async () => {
  const { apiMiddleware } = await import('../server/api.mjs')
  let statusCode = 0
  let body = ''
  const req = {
    url: '/api/terminal',
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost:5274' },
    on: (evt, cb) => {
      if (evt === 'data') cb(Buffer.from(JSON.stringify({ folder: '/tmp/nonexistent-folder-12345' })))
      if (evt === 'end') cb()
    },
  }
  const res = {
    writeHead: (code) => { statusCode = code },
    end: (payload) => { body = payload },
  }

  await apiMiddleware(req, res)
  assert.equal(statusCode, 400)
  assert.ok(JSON.parse(body).error.includes('not on this machine'))
})

test('only harnesses with remote CLI prompt injection support canPrompt', async () => {
  const ag = (await import('../server/harnesses/antigravity.mjs')).default
  const cursor = (await import('../server/harnesses/cursor.mjs')).default
  const codex = (await import('../server/harnesses/codex.mjs')).default

  // Antigravity, Cursor, Codex threads do not claim canPrompt
  assert.equal((await ag.scanThreads()).every((t) => !t.canPrompt), true)
  assert.equal((await cursor.scanThreads()).every((t) => !t.canPrompt), true)
  assert.equal((await codex.scanThreads()).every((t) => !t.canPrompt), true)
})

