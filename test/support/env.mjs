import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** PATH alone is not enough: the Codex adapter also walks Homebrew and npm-global install dirs. */
export async function withNoCodexCli(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-nocli-'))
  try {
    return await withEnv({ PATH: dir, BOT_CROSSING_CODEX_EXTRA_DIRS: '' }, fn)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

export async function withEnv(overrides, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export async function withPlatform(name, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: name, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

/** The log path is baked into the script so nothing depends on the environment reaching the child. */
export async function fakeExecutable(dir, name) {
  const file = path.join(dir, name)
  const log = `${file}.argv`
  await fsp.writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`, { mode: 0o755 })
  return {
    file,
    argv: async () => (await fsp.readFile(log, 'utf8')).split('\n').filter(Boolean),
    called: async () => fsp.access(log).then(() => true, () => false),
  }
}
