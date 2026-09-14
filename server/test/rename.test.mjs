/**
 * Rename, end to end against real files in a throwaway home directory.
 *
 * The adapters read their locations from the environment at import time, so this file
 * points HOME / USERPROFILE / APPDATA / BOT_CROSSING_DATA at a temp dir *before* importing
 * anything under server/. Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.APPDATA = path.join(root, 'AppData', 'Roaming')
process.env.BOT_CROSSING_DATA = path.join(root, 'data')

const adapter = (await import('../harnesses/claude-code.mjs')).default
const { readTranscriptMeta } = await import('../harnesses/claude-code.mjs')
const { apiMiddleware } = await import('../api.mjs')

const { DESKTOP_SESSIONS, CLI_PROJECTS } = adapter.paths
const PROJECT_DIR = path.join(CLI_PROJECTS, 'C--Dev-repo')
const ORG_DIR = path.join(DESKTOP_SESSIONS, 'account', 'org')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const line = (o) => JSON.stringify(o) + '\n'

async function writeTranscript(id, records) {
  await fsp.mkdir(PROJECT_DIR, { recursive: true })
  const file = path.join(PROJECT_DIR, `${id}.jsonl`)
  await fsp.writeFile(file, records.map(line).join(''))
  return file
}

async function writeDesktopRecord(record) {
  await fsp.mkdir(ORG_DIR, { recursive: true })
  const file = path.join(ORG_DIR, `${record.sessionId}.json`)
  await fsp.writeFile(file, JSON.stringify(record, null, 2))
  return file
}

const userRecord = (id, text) => ({
  type: 'user',
  sessionId: id,
  cwd: 'C:\\Dev\\repo',
  timestamp: '2026-09-14T10:00:00.000Z',
  message: { role: 'user', content: text },
})

/** Drive the middleware the way Vite would, with a same-origin request. */
async function api(method, pathname, body) {
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

const readState = async () => JSON.parse(await fsp.readFile(path.join(root, 'data', 'colony.json'), 'utf8'))

before(async () => {
  await fsp.mkdir(path.join(root, '.claude', 'sessions'), { recursive: true })
})

after(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

test('the last custom title in a transcript wins, matching the CLI', () => {
  const meta = readTranscriptMeta([
    { type: 'custom-title', customTitle: 'First name', sessionId: 'x' },
    { type: 'custom-title', customTitle: 'Second name', sessionId: 'x' },
  ])
  assert.equal(meta.customTitle, 'Second name')
})

test('a custom title past the first 192KB of a transcript is still read', async () => {
  const id = uuid(1)
  const filler = Array.from({ length: 40 }, (_, i) => userRecord(id, 'x'.repeat(8000) + i))
  await writeTranscript(id, [
    userRecord(id, 'Opening prompt'),
    ...filler,
    { type: 'custom-title', customTitle: 'Named late', sessionId: id },
  ])
  const threads = await adapter.scanThreads()
  const thread = threads.find((t) => t.id === id)
  assert.equal(thread.title, 'Named late')
})

test('setTitle on a terminal-only thread appends the same record /rename writes', async () => {
  const id = uuid(2)
  const file = await writeTranscript(id, [userRecord(id, 'Opening prompt')])
  const [before] = (await adapter.scanThreads()).filter((t) => t.id === id)
  assert.equal(before.canRename, true)

  const result = await adapter.setTitle(before.ref, 'Fresh name')
  assert.equal(result.ok, true)

  const lines = (await fsp.readFile(file, 'utf8')).trimEnd().split('\n')
  assert.deepEqual(JSON.parse(lines.at(-1)), { type: 'custom-title', customTitle: 'Fresh name', sessionId: id })

  const [after] = (await adapter.scanThreads()).filter((t) => t.id === id)
  assert.equal(after.title, 'Fresh name')
})

test('setTitle on a desktop thread rewrites only the title key of its record', async () => {
  const cli = uuid(3)
  const desktop = `local_${uuid(4)}`
  await writeTranscript(cli, [userRecord(cli, 'Opening prompt')])
  const file = await writeDesktopRecord({
    sessionId: desktop,
    cliSessionId: cli,
    title: 'Old name',
    cwd: 'C:\\Dev\\repo',
    model: 'claude-fable-5-1',
    createdAt: 1,
    lastActivityAt: 2,
  })
  const [before] = (await adapter.scanThreads()).filter((t) => t.id === cli)
  assert.equal(before.title, 'Old name')

  const result = await adapter.setTitle(before.ref, 'New name')
  assert.equal(result.ok, true)

  const record = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(record.title, 'New name')
  assert.equal(record.model, 'claude-fable-5-1')
  assert.equal(record.cwd, 'C:\\Dev\\repo')

  const [after] = (await adapter.scanThreads()).filter((t) => t.id === cli)
  assert.equal(after.title, 'New name')
})

test('setTitle refuses an empty title and an unknown thread', async () => {
  assert.equal((await adapter.setTitle({ cliSessionId: uuid(2) }, '   ')).ok, false)
  assert.equal((await adapter.setTitle({ cliSessionId: uuid(999) }, 'Nobody')).ok, false)
  assert.equal((await adapter.setTitle({ cliSessionId: '../../etc/passwd' }, 'Nope')).ok, false)
})

test('POST /api/rename saves the name in the colony and in the harness', async () => {
  const id = uuid(5)
  await writeTranscript(id, [userRecord(id, 'Opening prompt')])
  const [thread] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === id)

  const res = await api('POST', '/api/rename', {
    id,
    harness: thread.harness,
    ref: thread.ref,
    title: '  Renamed via colony  ',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.title, 'Renamed via colony')
  assert.equal(res.body.harnessRecord, true)

  assert.equal((await readState()).titles[id], 'Renamed via colony')
  const [after] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === id)
  assert.equal(after.title, 'Renamed via colony')
})

test('POST /api/rename rejects a missing id or a blank title', async () => {
  assert.equal((await api('POST', '/api/rename', { title: 'x' })).status, 400)
  assert.equal((await api('POST', '/api/rename', { id: uuid(5), title: '' })).status, 400)
})

test('the colony lets go of its copy once the harness agrees, so a later /rename shows through', async () => {
  const id = uuid(6)
  const file = await writeTranscript(id, [userRecord(id, 'Opening prompt')])
  const [thread] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === id)
  await api('POST', '/api/rename', { id, harness: thread.harness, ref: thread.ref, title: 'Colony name' })

  // A terminal-only thread has no app that could stomp it: one agreeing scan is enough.
  await api('GET', '/api/threads')
  assert.equal((await readState()).titles[id], undefined)

  // Now the user renames it in Claude Code itself; nothing here should hide that.
  await fsp.appendFile(file, line({ type: 'custom-title', customTitle: 'CLI name', sessionId: id }))
  const [after] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === id)
  assert.equal(after.title, 'CLI name')
})

test('a desktop thread keeps the colony name until the app has restarted, and is re-asserted if stomped', async () => {
  const cli = uuid(7)
  const desktop = `local_${uuid(8)}`
  await writeTranscript(cli, [userRecord(cli, 'Opening prompt')])
  const file = await writeDesktopRecord({ sessionId: desktop, cliSessionId: cli, title: 'Old name', cwd: 'C:\\Dev\\repo' })
  const [thread] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === cli)
  await api('POST', '/api/rename', { id: cli, harness: thread.harness, ref: thread.ref, title: 'Colony name' })

  await api('GET', '/api/threads')
  assert.equal((await readState()).titles[cli], 'Colony name')

  // The desktop app writes the record back from memory with the old title.
  const record = JSON.parse(await fsp.readFile(file, 'utf8'))
  record.title = 'Old name'
  await fsp.writeFile(file, JSON.stringify(record, null, 2))

  const [after] = (await api('GET', '/api/threads')).body.threads.filter((t) => t.id === cli)
  assert.equal(after.title, 'Colony name')
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).title, 'Colony name')
})
