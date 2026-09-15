/**
 * The terminal launcher: which emulator it picks, and when it refuses to try at all.
 *
 * Every emulator here is a shell script that records its argv and exits 0, named after a real
 * terminal so the flag table matches it. Absolute paths keep PATH out of it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openInTerminal } from '../server/lib/terminal.mjs'
import { withEnv, withPlatform, fakeExecutable } from './support/env.mjs'

const ON_WINDOWS = process.platform === 'win32'
const ARGV = ['/bin/true', 'x']

async function withTmp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-terminal-'))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

const noTerminals = (dir) => ({
  PATH: dir,
  BOT_CROSSING_TERMINAL: undefined,
  TERMINAL: undefined,
  XDG_CURRENT_DESKTOP: '',
  DISPLAY: ':0',
})

describe('openInTerminal', () => {
  it('should refuse anything not already resolved to absolute paths', async () => {
    assert.equal((await openInTerminal(['ls'], '/tmp')).ok, false, 'relative argv[0]')
    assert.equal((await openInTerminal(['/bin/ls'], 'relative')).ok, false, 'relative cwd')
    assert.equal((await openInTerminal([], '/tmp')).ok, false, 'empty argv')
    assert.equal((await openInTerminal(['/bin/ls', 123], '/tmp')).ok, false, 'non-string argument')
  })

  describe('when BOT_CROSSING_TERMINAL and $TERMINAL both name known emulators', { skip: ON_WINDOWS }, () => {
    const run = () =>
      withTmp(async (dir) => {
        const kitty = await fakeExecutable(dir, 'kitty')
        const alacritty = await fakeExecutable(dir, 'alacritty')
        const env = { ...noTerminals(dir), BOT_CROSSING_TERMINAL: kitty.file, TERMINAL: alacritty.file }
        await withEnv(env, () => openInTerminal(ARGV, dir))
        return { dir, kittyArgv: await kitty.argv().catch(() => null), alacrittyCalled: await alacritty.called() }
      })

    it('should run the command in BOT_CROSSING_TERMINAL', async () => {
      const { dir, kittyArgv } = await run()
      assert.deepEqual(kittyArgv, [`--directory=${dir}`, ...ARGV])
    })

    it('should leave $TERMINAL alone', async () => {
      const { alacrittyCalled } = await run()
      assert.equal(alacrittyCalled, false)
    })

    describe('and BOT_CROSSING_TERMINAL is one the table does not know', () => {
      it('should fall through to $TERMINAL', async () => {
        await withTmp(async (dir) => {
          const tilix = await fakeExecutable(dir, 'tilix')
          const kitty = await fakeExecutable(dir, 'kitty')
          const env = { ...noTerminals(dir), BOT_CROSSING_TERMINAL: tilix.file, TERMINAL: kitty.file }
          await withEnv(env, () => openInTerminal(ARGV, dir))
          assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, ...ARGV])
        })
      })
    })
  })

  describe('when nothing names a terminal and none is installed', { skip: ON_WINDOWS }, () => {
    it('should say to set BOT_CROSSING_TERMINAL', async () => {
      await withTmp(async (dir) => {
        const result = await withEnv(noTerminals(dir), () => openInTerminal(ARGV, dir))
        assert.match(result.error, /BOT_CROSSING_TERMINAL/)
      })
    })
  })

  describe('when there is no display', { skip: ON_WINDOWS }, () => {
    const headless = (dir, terminal) => ({
      ...noTerminals(dir),
      BOT_CROSSING_TERMINAL: terminal,
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      XDG_RUNTIME_DIR: undefined,
    })

    describe('and the platform is darwin', () => {
      it('should not refuse for want of one', async () => {
        await withTmp(async (dir) => {
          const kitty = await fakeExecutable(dir, 'kitty')
          const result = await withPlatform('darwin', () =>
            withEnv(headless(dir, kitty.file), () => openInTerminal(ARGV, dir))
          )
          assert.equal(result.ok, true)
        })
      })
    })

    describe('and the platform is linux', () => {
      it('should refuse and say so', async () => {
        await withTmp(async (dir) => {
          const kitty = await fakeExecutable(dir, 'kitty')
          const result = await withPlatform('linux', () =>
            withEnv(headless(dir, kitty.file), () => openInTerminal(ARGV, dir))
          )
          assert.match(result.error, /graphical display/)
        })
      })
    })
  })
})
