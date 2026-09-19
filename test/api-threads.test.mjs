/**
 * What `/api/threads` hands the page. Its own process (node --test runs each file in one),
 * so the harness roots can be pointed at a fixture before any harness module is imported —
 * they read their env once, at import.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'api-threads-'))
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
process.env.BOT_CROSSING_CLAUDE_DESKTOP = path.join(root, 'claude-code-sessions')
// Only the harness this fixture fakes. The others would scan whatever is really on the box.
process.env.BOT_CROSSING_DISABLE_HARNESSES = 'codex,cursor,antigravity,hermes,kilocode,opencode'

const { default: test } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { withServer } = await import('./support/with-server.mjs')

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

async function record(org, sessionId, cliSessionId, extra = {}) {
  const r = {
    sessionId,
    cliSessionId,
    cwd: '/tmp/demo',
    title: `Thread ${cliSessionId.slice(0, 4)}`,
    createdAt: 1,
    lastActivityAt: Date.now(),
    lastFocusedAt: Date.now(),
    ...extra,
  }
  await fsp.writeFile(path.join(org, `${sessionId}.json`), JSON.stringify(r))
}

test('a thread archived in the desktop app is not sent to the page at all', async () => {
  const org = path.join(process.env.BOT_CROSSING_CLAUDE_DESKTOP, 'account', 'org')
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-demo')
  await fsp.mkdir(org, { recursive: true })
  await fsp.mkdir(project, { recursive: true })
  for (const id of [SESSION_A, SESSION_B]) {
    await fsp.writeFile(
      path.join(project, `${id}.jsonl`),
      JSON.stringify({ type: 'user', cwd: '/tmp/demo', message: { role: 'user', content: 'hi' } }) + '\n'
    )
  }
  await record(org, 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', SESSION_A)
  await record(org, 'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', SESSION_B, { isArchived: true })

  await withServer(async ({ call }) => {
    const res = await call('/api/threads')
    assert.equal(res.status, 200)
    const { threads } = await res.json()
    const ids = threads.map((t) => t.id)
    assert.ok(ids.includes(`claude-code:${SESSION_A}`), 'the live thread is sent')
    assert.ok(!ids.includes(`claude-code:${SESSION_B}`), 'the archived one is not — the page drops it unread anyway')
    assert.ok(threads.every((t) => !t.archived), 'nothing in the payload is archived')
  })
  await fsp.rm(root, { recursive: true, force: true })
})
