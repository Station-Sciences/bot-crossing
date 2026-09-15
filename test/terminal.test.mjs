/**
 * The terminal launcher: which emulator it picks, and when it refuses to try at all.
 *
 * Every emulator here is a shell script that records its argv and exits 0, named after a real
 * terminal so the flag table matches it. Absolute paths keep PATH out of it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openInTerminal } from '../server/lib/terminal.mjs'
import { withEnv, withPlatform, fakeExecutable } from './support/env.mjs'

const ARGV = ['/bin/true', 'x']
const posixOnly = { skip: process.platform === 'win32' }

async function withTmp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-terminal-'))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

const nothingInstalled = (dir) => ({
  PATH: dir,
  BOT_CROSSING_TERMINAL: undefined,
  TERMINAL: undefined,
  XDG_CURRENT_DESKTOP: '',
  DISPLAY: ':0',
})

test('openInTerminal refuses anything not already resolved to absolute paths', async () => {
  assert.equal((await openInTerminal(['ls'], '/tmp')).ok, false, 'relative argv[0]')
  assert.equal((await openInTerminal(['/bin/ls'], 'relative')).ok, false, 'relative cwd')
  assert.equal((await openInTerminal([], '/tmp')).ok, false, 'empty argv')
  assert.equal((await openInTerminal(['/bin/ls', 123], '/tmp')).ok, false, 'non-string argument')
})

test('BOT_CROSSING_TERMINAL wins over $TERMINAL, and the loser is never started', posixOnly, async () => {
  await withTmp(async (dir) => {
    const kitty = await fakeExecutable(dir, 'kitty')
    const alacritty = await fakeExecutable(dir, 'alacritty')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: kitty.file, TERMINAL: alacritty.file }
    const result = await withEnv(env, () => openInTerminal(ARGV, dir))
    assert.equal(result.ok, true)
    assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, ...ARGV])
    assert.equal(await alacritty.called(), false)
  })
})

test('a named terminal the table does not know is skipped, not guessed at', posixOnly, async () => {
  await withTmp(async (dir) => {
    const tilix = await fakeExecutable(dir, 'tilix')
    const kitty = await fakeExecutable(dir, 'kitty')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: tilix.file, TERMINAL: kitty.file }
    await withEnv(env, () => openInTerminal(ARGV, dir))
    assert.equal(await tilix.called(), false)
    assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, ...ARGV])
  })
})

test('with no terminal anywhere, the error says which variable to set', posixOnly, async () => {
  await withTmp(async (dir) => {
    const result = await withEnv(nothingInstalled(dir), () => openInTerminal(ARGV, dir))
    assert.equal(result.ok, false)
    assert.match(result.error, /BOT_CROSSING_TERMINAL/)
  })
})

test('a missing DISPLAY is a refusal on Linux and nothing at all on macOS', posixOnly, async () => {
  await withTmp(async (dir) => {
    const kitty = await fakeExecutable(dir, 'kitty')
    const headless = {
      ...nothingInstalled(dir),
      BOT_CROSSING_TERMINAL: kitty.file,
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      XDG_RUNTIME_DIR: undefined,
    }
    const onLinux = await withPlatform('linux', () => withEnv(headless, () => openInTerminal(ARGV, dir)))
    assert.match(onLinux.error, /graphical display/)
    const onMac = await withPlatform('darwin', () => withEnv(headless, () => openInTerminal(ARGV, dir)))
    assert.equal(onMac.ok, true)
  })
})
