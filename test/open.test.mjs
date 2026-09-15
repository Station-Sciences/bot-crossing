/**
 * Opening a thread the way the page asked: the desktop app by default, or a terminal running
 * the harness's own CLI.
 *
 * `present` is exercised directly with stubbed adapter answers for the branching, and the two
 * endpoints once each through a real socket, with a fake CLI and a fake terminal on disk, because
 * only that proves `via` makes it from the request body to the spawn.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { present } from '../server/api.mjs'
import { withServer } from './support/with-server.mjs'
import { withEnv, withPlatform, fakeExecutable } from './support/env.mjs'

const SKIP = { skip: process.platform === 'win32' }
const UUID = '2df3987c-02d3-405e-b8f5-da30e3835213'

describe('present', () => {
  describe('when the page asks for a terminal', () => {
    describe('and the adapter offered no command', () => {
      it('should say the CLI was not found', async () => {
        const shown = await present({ ok: true, url: 'claude://resume?session=x' }, 'terminal')
        assert.match(shown.error, /CLI/)
      })
    })

    describe('and the command has no cwd', () => {
      it('should say there is no folder on record', async () => {
        const shown = await present({ ok: true, url: '', command: { argv: ['/bin/true'], cwd: '' } }, 'terminal')
        assert.match(shown.error, /no folder on record/)
      })
    })

    describe("and the command's cwd is not on this machine", () => {
      it('should say so', async () => {
        const command = { argv: ['/bin/true'], cwd: '/definitely/not/here' }
        const shown = await present({ ok: true, url: '', command }, 'terminal')
        assert.match(shown.error, /not on this machine/)
      })
    })

    describe('and the platform is win32', () => {
      it('should say Windows is not supported yet', async () => {
        const command = { argv: ['/bin/true'], cwd: os.tmpdir() }
        const shown = await withPlatform('win32', () => present({ ok: true, url: '', command }, 'terminal'))
        assert.match(shown.error, /Windows/)
      })
    })

    describe("and the adapter's answer was not ok", () => {
      it("should pass the adapter's reason through", async () => {
        const shown = await present({ ok: false, error: 'nope' }, 'terminal')
        assert.equal(shown.error, 'nope')
      })
    })
  })
})

/** A fake `claude` on PATH and a fake `kitty` as the terminal, both gone again afterwards. */
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

describe('POST /api/open', SKIP, () => {
  describe('when the page asks for a terminal and the CLI and a terminal are both present', () => {
    const open = () =>
      withFakes(({ dir, claude, kitty }) =>
        withServer(async ({ call }) => {
          const ref = { cliSessionId: UUID, cwd: dir }
          const res = await post(call, '/api/open', { harness: 'claude-code', ref, via: 'terminal' })
          return { dir, claude, res, body: await res.json(), kittyArgv: await kitty.argv() }
        })
      )

    it('should answer 200', async () => {
      const { res } = await open()
      assert.equal(res.status, 200)
    })

    it('should say a terminal is what opened', async () => {
      const { body } = await open()
      assert.deepEqual(body, { ok: true, via: 'terminal' })
    })

    it("should run claude --resume <id> in the thread's folder", async () => {
      const { dir, claude, kittyArgv } = await open()
      assert.deepEqual(kittyArgv, [`--directory=${dir}`, claude.file, '--resume', UUID])
    })
  })

  describe('when the page asks for a terminal and the CLI is absent', () => {
    // Codex, because this machine may well have a real `claude` in one of the install dirs.
    it('should answer 400 naming the CLI', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-nocli-'))
      try {
        const res = await withEnv({ PATH: dir }, () =>
          withServer(({ call }) =>
            post(call, '/api/open', { harness: 'codex', ref: { sessionId: UUID, cwd: dir }, via: 'terminal' })
          )
        )
        assert.equal(res.status, 400)
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('POST /api/new-session', SKIP, () => {
  describe('when the page asks for a terminal', () => {
    it('should run the bare CLI in that folder', async () => {
      const { dir, claude, kittyArgv } = await withFakes(({ dir, claude, kitty }) =>
        withServer(async ({ call }) => {
          await post(call, '/api/new-session', { harness: 'claude-code', folder: dir, via: 'terminal' })
          return { dir, claude, kittyArgv: await kitty.argv() }
        })
      )
      assert.deepEqual(kittyArgv, [`--directory=${dir}`, claude.file])
    })
  })
})
