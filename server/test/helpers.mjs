/**
 * A throwaway home directory, and the server modules loaded against it.
 *
 * The adapters read their locations from the environment at import time, so this module
 * points HOME / USERPROFILE / APPDATA / BOT_CROSSING_DATA at a temp dir *before* importing
 * anything under server/. node --test runs each test file in its own process, so every
 * file that imports this gets a fresh home of its own.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.APPDATA = path.join(root, 'AppData', 'Roaming')
process.env.BOT_CROSSING_DATA = path.join(root, 'data')

const adapterModule = await import('../harnesses/claude-code.mjs')
export const adapter = adapterModule.default
export const { readTranscriptMeta } = adapterModule
const { apiMiddleware } = await import('../api.mjs')

const { DESKTOP_SESSIONS, CLI_PROJECTS } = adapter.paths
const PROJECT_DIR = path.join(CLI_PROJECTS, 'C--Dev-repo')
const ORG_DIR = path.join(DESKTOP_SESSIONS, 'account', 'org')

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const line = (o) => JSON.stringify(o) + '\n'

export async function setupHome() {
  await fsp.mkdir(path.join(root, '.claude', 'sessions'), { recursive: true })
}

export async function teardownHome() {
  await fsp.rm(root, { recursive: true, force: true })
}

export async function writeTranscript(id, records) {
  await fsp.mkdir(PROJECT_DIR, { recursive: true })
  const file = path.join(PROJECT_DIR, `${id}.jsonl`)
  await fsp.writeFile(file, records.map(line).join(''))
  return file
}

export async function writeDesktopRecord(record) {
  await fsp.mkdir(ORG_DIR, { recursive: true })
  const file = path.join(ORG_DIR, `${record.sessionId}.json`)
  await fsp.writeFile(file, JSON.stringify(record, null, 2))
  return file
}

export const readJson = async (file) => JSON.parse(await fsp.readFile(file, 'utf8'))
export const writeJson = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2))

export const userRecord = (id, text) => ({
  type: 'user',
  sessionId: id,
  cwd: 'C:\\Dev\\repo',
  timestamp: '2026-09-14T10:00:00.000Z',
  message: { role: 'user', content: text },
})

/** Drive the middleware the way Vite would, with a same-origin request. */
export async function api(method, pathname, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.url = pathname
  req.method = method
  req.headers = { host: 'localhost:5274', origin: 'http://localhost:5274' }
  let status = 0
  let out = ''
  const res = {
    writeHead: (s) => {
      status = s
    },
    end: (chunk) => {
      out = String(chunk || '')
    },
  }
  await apiMiddleware(req, res)
  return { status, body: out ? JSON.parse(out) : null }
}

export const readState = () => readJson(path.join(root, 'data', 'colony.json'))

/** One thread as the page sees it, straight off a fresh scan. */
export async function threadById(id) {
  const { threads } = (await api('GET', '/api/threads')).body
  return threads.find((t) => t.id === id)
}
