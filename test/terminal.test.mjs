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

import { openInTerminal, shellQuote, shellLine } from '../server/lib/terminal.mjs'
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

// ── macOS: Terminal.app and iTerm, through osascript ──────────────────────────

test('every argv element is single-quoted, and the quoting survives every metacharacter', () => {
  const nasty = `it's $HOME \`x\` "q" \\ ; & | > < * ? ( ) { } ~ ! #`
  assert.equal(shellQuote(nasty), `'it'\\''s $HOME \`x\` "q" \\ ; & | > < * ? ( ) { } ~ ! #'`)
  assert.equal(shellLine('/Users/a b/repo', ['/usr/local/bin/node', 'bin/queue.mjs']), "cd '/Users/a b/repo' && '/usr/local/bin/node' 'bin/queue.mjs'")
})

test('on macOS with nothing driven installed, Terminal.app is opened through osascript with one quoted line', posixOnly, async () => {
  await withTmp(async (dir) => {
    const osascript = await fakeExecutable(dir, 'osascript')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: 'terminal' }
    const result = await withPlatform('darwin', () => withEnv(env, () => openInTerminal(['/bin/true', "it's", 'x'], dir)))
    assert.equal(result.ok, true, result.error)
    const argv = await osascript.argv()
    assert.equal(argv[0], '-e')
    assert.equal(argv[1], 'tell application "Terminal"')
    const script = argv.filter((_, i) => i % 2 === 1).join('\n')
    // The shell line is 'it'\''s'; inside an AppleScript string its backslash is doubled.
    assert.match(script, /do script "cd '.*' && '\/bin\/true' 'it'\\\\''s' 'x'"/, 'the shell line, as an AppleScript string')
    assert.match(script, /end tell$/)
  })
})

test('iTerm is chosen by name and typed into a new window', posixOnly, async () => {
  await withTmp(async (dir) => {
    const osascript = await fakeExecutable(dir, 'osascript')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: 'iTerm' }
    const result = await withPlatform('darwin', () => withEnv(env, () => openInTerminal(ARGV, dir)))
    assert.equal(result.ok, true, result.error)
    const script = (await osascript.argv()).filter((_, i) => i % 2 === 1).join('\n')
    assert.match(script, /^tell application "iTerm"/)
    assert.match(script, /create window with default profile/)
    assert.match(script, /write text "cd '/)
  })
})

test('a driven terminal still wins over Terminal.app on macOS, and Linux never reaches osascript', posixOnly, async () => {
  await withTmp(async (dir) => {
    const osascript = await fakeExecutable(dir, 'osascript')
    const kitty = await fakeExecutable(dir, 'kitty')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: kitty.file }
    const onMac = await withPlatform('darwin', () => withEnv(env, () => openInTerminal(ARGV, dir)))
    assert.equal(onMac.ok, true)
    assert.equal(await kitty.called(), true)
    assert.equal(await osascript.called(), false)

  })
  await withTmp(async (dir) => {
    const osascript = await fakeExecutable(dir, 'osascript')
    const onLinux = await withPlatform('linux', () => withEnv({ ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: 'terminal' }, () => openInTerminal(ARGV, dir)))
    assert.equal(onLinux.ok, false)
    assert.equal(await osascript.called(), false)
  })
})

test('a line break in the command is refused rather than typed', posixOnly, async () => {
  await withTmp(async (dir) => {
    const osascript = await fakeExecutable(dir, 'osascript')
    const env = { ...nothingInstalled(dir), BOT_CROSSING_TERMINAL: 'terminal' }
    const result = await withPlatform('darwin', () => withEnv(env, () => openInTerminal(['/bin/true', 'a\nb'], dir)))
    assert.equal(result.ok, false)
    assert.equal(await osascript.called(), false)
  })
})
