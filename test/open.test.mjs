/**
 * Opening a thread the way the page asked: the desktop app by default, or a terminal running
 * the harness's own CLI.
 *
 * `present` gets stubbed adapter answers for the branching. The two endpoints go through a real
 * socket once each, with a fake CLI and a fake terminal on disk, because only that proves `via`
 * makes it from the request body to the spawn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { present } from '../server/api.mjs'
import { withServer } from './support/with-server.mjs'
import { withEnv, withNoCli, withPlatform, fakeExecutable } from './support/env.mjs'

const posixOnly = { skip: process.platform === 'win32' }
const UUID = '2df3987c-02d3-405e-b8f5-da30e3835213'

// ── present, given what an adapter said ───────────────────────────────────────

test('asked for a terminal, present never opens the app instead', async () => {
  const noCommand = await present({ ok: true, url: 'claude://resume?session=x' }, 'terminal')
  assert.equal(noCommand.ok, false)
  assert.match(noCommand.error, /CLI/, 'a missing CLI is named, not papered over with the deep link')

  const noCwd = await present({ ok: true, url: '', command: { argv: ['/bin/true'], cwd: '' } }, 'terminal')
  assert.match(noCwd.error, /no folder on record/)

  const gone = { argv: ['/bin/true'], cwd: '/definitely/not/here' }
  assert.match((await present({ ok: true, url: '', command: gone }, 'terminal')).error, /not on this machine/)
})

/**
 * PATH points at an empty folder, so neither Windows Terminal nor `cmd.exe` can be found and
 * nothing is started. With the machine's own PATH this used to open a real `cmd.exe` window on
 * every Windows test run, sitting on "'/bin/true' is not recognized".
 */
test('asked for a terminal on Windows with none to be found, present names what to install', async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-nopath-'))
  try {
    const command = { argv: ['/bin/true'], cwd: os.tmpdir() }
    const shown = await withEnv({ PATH: empty }, () =>
      withPlatform('win32', () => present({ ok: true, url: '', command }, 'terminal'))
    )
    assert.equal(shown.ok, false)
    assert.match(shown.error, /Windows Terminal/)
  } finally {
    await fsp.rm(empty, { recursive: true, force: true })
  }
})

test("an adapter's own refusal passes through whatever the page asked for", async () => {
  assert.equal((await present({ ok: false, error: 'nope' }, 'terminal')).error, 'nope')
  assert.equal((await present({ ok: false, error: 'nope' }, 'app')).error, 'nope')
})

// ── the endpoints, against a real socket ──────────────────────────────────────

async function withFakes(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-open-'))
  try {
    const claude = await fakeExecutable(dir, 'claude')
    const kitty = await fakeExecutable(dir, 'kitty')
    const env = { PATH: dir, BOT_CROSSING_TERMINAL: kitty.file, DISPLAY: ':0' }
    return await withEnv(env, () => fn({ dir, claude, kitty }))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

const post = (call, p, body) => call(p, { method: 'POST', body: JSON.stringify(body) })

test('/api/open with via: terminal resumes the session in its own folder', posixOnly, async () => {
  await withFakes(({ dir, claude, kitty }) =>
    withServer(async ({ call }) => {
      const ref = { cliSessionId: UUID, cwd: dir }
      const res = await post(call, '/api/open', { harness: 'claude-code', ref, via: 'terminal' })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { ok: true, via: 'terminal' }, 'the page is told a terminal opened')
      assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, claude.file, '--resume', UUID])
    })
  )
})

test('/api/open with via: terminal and no CLI is a 400 that names the CLI', posixOnly, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-nocli-'))
  try {
    await withNoCli(() =>
      withServer(async ({ call }) => {
        const body = { harness: 'codex', ref: { sessionId: UUID, cwd: dir }, via: 'terminal' }
        const res = await post(call, '/api/open', body)
        assert.equal(res.status, 400)
        assert.match((await res.json()).error, /CLI/)
      })
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('/api/new-session with via: terminal starts the bare CLI in that folder', posixOnly, async () => {
  await withFakes(({ dir, claude, kitty }) =>
    withServer(async ({ call }) => {
      await post(call, '/api/new-session', { harness: 'claude-code', folder: dir, via: 'terminal' })
      assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, claude.file])
    })
  )
})
