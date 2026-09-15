import fsp from 'node:fs/promises'
import path from 'node:path'

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
