/**
 * The harness seam: what an adapter is allowed to hand back, and the two things the colony has
 * historically got wrong about a thread — which repo it belongs to, and whether it is working.
 *
 * Fixture-driven. Nothing here reads a real harness, so it says the same thing on any machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HARNESSES } from '../server/harnesses/index.mjs'
import codex from '../server/harnesses/codex.mjs'
import claudeCode from '../server/harnesses/claude-code.mjs'
import opencode from '../server/harnesses/opencode.mjs'
import { readTail, findExecutable } from '../server/lib/fsutil.mjs'
import { schemeOf, openInTerminal } from '../server/lib/xdg.mjs'

// ── the contract ──────────────────────────────────────────────────────────────

test('every registered harness implements the interface, and none of them can write', () => {
  for (const h of HARNESSES) {
    assert.match(h.id, /^[a-z0-9-]+$/, `${h.id} is not a kebab-case id`)
    assert.equal(typeof h.name, 'string')
    for (const fn of ['detect', 'scanThreads', 'openThread', 'newSession']) {
      assert.equal(typeof h[fn], 'function', `${h.id} is missing ${fn}()`)
    }
    // The one rule the project will not bend on. An adapter that grows a write is a bug.
    assert.equal(h.setArchived, undefined, `${h.id} must not write to its harness`)
  }
})

test('harness ids are unique, and so are the id prefixes they hand out', () => {
  const ids = HARNESSES.map((h) => h.id)
  assert.equal(new Set(ids).size, ids.length)
})

// ── ids are prefixed, and refs from the page are not trusted ──────────────────

test('a session id that merely stringifies to a UUID is refused', async () => {
  // `RegExp.test` coerces, so an array holding a valid id passes the pattern and then travels on
  // as an array. Both adapters check the type first.
  const uuid = '2df3987c-02d3-405e-b8f5-da30e3835213'
  assert.equal((await claudeCode.openThread({ cliSessionId: [uuid] })).ok, false)
  assert.equal((await claudeCode.openThread({ desktopSessionId: { toString: () => `local_${uuid}` } })).ok, false)
  assert.equal(codex.openThread({ sessionId: [uuid] }).ok, false)
  assert.equal(codex.openThread({}).ok, false)
  assert.equal(codex.openThread(null).ok, false)
})

test('codex opens through the registered scheme and prefixes its ids', () => {
  const id = '019cc762-45a2-7112-89cd-cd345c17e834'
  const opened = codex.openThread({ sessionId: id })
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'codex')
  assert.equal(opened.url, `codex://threads/${id}`)
})

// ── a Codex install, faked on disk ────────────────────────────────────────────

const line = (type, payload, timestamp = '2026-09-07T12:00:00.000Z') => JSON.stringify({ timestamp, type, payload })

/** One id for every fixture, so a test can name it before the transcript exists. */
const SESSION_ID = '019cc762-45a2-7112-89cd-cd345c17e834'

async function fakeCodex(records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-fixture-'))
  const day = path.join(home, 'sessions', '2026', '09', '07')
  await fsp.mkdir(day, { recursive: true })
  await fsp.writeFile(path.join(day, `rollout-2026-09-07T12-00-00-${SESSION_ID}.jsonl`), records.join('\n') + '\n')
  return home
}

async function scanWith(home) {
  process.env.CODEX_HOME = home
  const mod = await import(`../server/harnesses/codex.mjs?${home}`)
  return mod.default
}

test('a CLI-only Codex session is found with no database at all', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo', git: { branch: 'main' } }),
    line('turn_context', { model: 'gpt-5.3-codex', effort: 'high' }),
    line('response_item', { type: 'message', role: 'user', content: [{ text: 'ship the thing' }] }),
    line('event_msg', { type: 'task_complete' }),
  ])
  const h = await scanWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `codex:${SESSION_ID}`, 'ids are prefixed')
  assert.equal(t.project, 'demo')
  assert.equal(t.model, 'gpt-5.3-codex')
  assert.equal(t.effort, 'high')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.preview, 'ship the thing')
  assert.ok(t.sizeBytes > 0, 'sizeBytes is transcript bytes, not a token count')
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an interrupted turn is not an error — escape must not redden an astronaut', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'turn_aborted' }),
  ])
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, false)
  assert.equal(t.running, false, 'an aborted turn is not still running')
  await fsp.rm(home, { recursive: true, force: true })
})

test('a task started long ago is not still running', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
  ])
  const day = path.join(home, 'sessions', '2026', '09', '07')
  const [file] = await fsp.readdir(day)
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000)
  await fsp.utimes(path.join(day, file), old, old)
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false, 'Codex writes nothing when killed, so the window has to bound it')
  await fsp.rm(home, { recursive: true, force: true })
})

test('malformed records are skipped rather than throwing the scan away', async () => {
  const home = await fakeCodex([
    'not json at all',
    '{"half": ',
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('response_item', { type: 'message', role: 'user', content: 'hello' }),
  ])
  const h = await scanWith(home)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)
  assert.equal(threads[0].preview, 'hello')
  await fsp.rm(home, { recursive: true, force: true })
})

test('an absent Codex is simply not detected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-empty-'))
  const h = await scanWith(home)
  assert.equal(await h.detect(), false)
  assert.deepEqual(await h.scanThreads(), [])
  await fsp.rm(home, { recursive: true, force: true })
})

// ── shared helpers ────────────────────────────────────────────────────────────

test('readTail drops the partial line it lands in the middle of', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'tail-')), 'x.jsonl')
  await fsp.writeFile(f, 'first line\nsecond line\nthird line\n')
  assert.equal(await readTail(f, 15), 'third line\n')
  assert.equal(await readTail(f, 1000), 'first line\nsecond line\nthird line\n')
})

test('findExecutable refuses junk, and refuses a directory that sits on PATH', async () => {
  assert.equal(await findExecutable(''), null)
  assert.equal(await findExecutable(null), null)
  assert.equal(await findExecutable('.'), null)
  assert.equal(await findExecutable('definitely-not-a-real-binary-xyz'), null)
})

test('openInTerminal refuses anything not already resolved to absolute paths', async () => {
  assert.equal((await openInTerminal(['ls'], '/tmp')).ok, false, 'relative argv[0]')
  assert.equal((await openInTerminal(['/bin/ls'], 'relative')).ok, false, 'relative cwd')
  assert.equal((await openInTerminal([], '/tmp')).ok, false, 'empty argv')
  assert.equal((await openInTerminal(['/bin/ls', 123], '/tmp')).ok, false, 'non-string argument')
})

// ── Cursor, faked on disk ─────────────────────────────────────────────────────

async function fakeCursor(dirName, records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-fixture-'))
  const dir = path.join(home, dirName, 'agent-transcripts', SESSION_ID)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return home
}

async function cursorWith(home) {
  process.env.BOT_CROSSING_CURSOR_PROJECTS = home
  const mod = await import(`../server/harnesses/cursor.mjs?${home}`)
  return mod.default
}

const askedFor = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })

test('a Cursor transcript yields a thread with the typed query as its title', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<timestamp>Tuesday, Sep 8, 2026, 4:08 PM (UTC-7)</timestamp>\n<user_query>\nwhat project is this?\n</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'It is…' }] } },
    { type: 'turn_ended', status: 'success' },
  ])
  const h = await cursorWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `cursor:${SESSION_ID}`)
  // Cursor's own wrapper tags are scaffolding, not something a person typed.
  assert.equal(t.title, 'what project is this?')
  assert.equal(t.running, false, 'a closed turn is not running')
  assert.equal(t.hasError, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a transcript from before turn_ended existed is not reported as mid-turn', async () => {
  // The older corpus carries no markers at all. Reading "no marker" as "still working" would
  // light up every historical thread on the map.
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>old thread</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a failed turn is an error, and an open turn is running', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>do it</user_query>'),
    { type: 'turn_ended', status: 'error' },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('Cursor offers a folder link but never a per-thread one it cannot honour', async () => {
  const home = await fakeCursor('tmp', [askedFor('<user_query>hi</user_query>')])
  const h = await cursorWith(home)
  assert.equal(h.openThread({ sessionId: SESSION_ID }).ok, false)
  const opened = h.newSession('/tmp/some repo')
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'cursor')
  assert.ok(opened.url.includes('%20'), 'a space in the path is escaped, not left raw')
  assert.equal(h.newSession('relative/path').ok, false)
  await fsp.rm(home, { recursive: true, force: true })
})

// ── OpenCode, faked on disk ─────────────────────────────────────────────────

const OPENCODE_SESSION = 'ses_eeeeddddccccbbbbaaaa00000000'

async function fakeOpencode() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-fixture-'))
  const dbFile = path.join(home, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run(OPENCODE_SESSION, 'global', null, '/tmp/demo', 'Fix the thing', 'build', JSON.stringify({ id: 'muse-spark', providerID: 'opencode-go', variant: 'xhigh' }), now - 60000, now, null)
  ins.run('ses_child11111111111111111111111', 'global', OPENCODE_SESSION, '/tmp/demo', 'Do subtask (@general subagent)', 'general', null, now - 50000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('msg_user1', OPENCODE_SESSION, now - 60000, now - 60000, JSON.stringify({ role: 'user', time: { created: now - 60000 } }))
  mins.run('msg_asst1', OPENCODE_SESSION, now - 59000, now - 58000, JSON.stringify({ role: 'assistant', time: { created: now - 59000, completed: now - 58000 }, finish: 'stop' }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('prt_user1', 'msg_user1', OPENCODE_SESSION, now - 60000, now - 60000, JSON.stringify({ type: 'text', text: '  ship   the thing  ' }))
  pins.run('prt_asst1', 'msg_asst1', OPENCODE_SESSION, now - 59000, now - 58000, JSON.stringify({ type: 'text', text: 'done' }))
  db.close()
  process.env.OPENCODE_DB = dbFile
  return { home, h: opencode }
}

test('opencode lists only top-level sessions with mapped fields', async () => {
  const { home, h } = await fakeOpencode()
  try {
    assert.equal(await h.detect(), true)
    const threads = await h.scanThreads()
    assert.equal(threads.length, 1)
    const [t] = threads
    assert.equal(t.id, `opencode:${OPENCODE_SESSION}`)
    assert.equal(t.project, 'demo')
    assert.equal(t.projectPath, '/tmp/demo')
    assert.equal(t.cwd, '/tmp/demo')
    assert.equal(t.worktree, '')
    assert.equal(t.title, 'Fix the thing')
    assert.equal(t.preview, 'ship the thing')
    assert.equal(t.model, 'muse-spark')
    assert.equal(t.canOpen, false)
    assert.deepEqual(t.ref, { sessionId: OPENCODE_SESSION, cwd: '/tmp/demo' })
    assert.ok(t.sizeBytes > 0, 'sizeBytes is transcript bytes, not a token count')
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('an absent opencode is simply not detected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-empty-'))
  process.env.OPENCODE_DB = path.join(home, 'missing.db')
  try {
    assert.equal(await opencode.detect(), false)
    assert.deepEqual(await opencode.scanThreads(), [])
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('opencode running is bounded by the activity window and errors come from the last turn only', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-status-'))
  const dbFile = path.join(home, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('ses_running1111111111111111111111', 'global', null, '/tmp/a', 'Running now', 'build', null, now - 60000, now, null)
  ins.run('ses_stale11111111111111111111111', 'global', null, '/tmp/b', 'Stale open turn', 'build', null, now - 6 * 60 * 60 * 1000, now - 6 * 60 * 60 * 1000, null)
  ins.run('ses_error111111111111111111111111', 'global', null, '/tmp/c', 'Failed turn', 'build', null, now - 60000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('m_run', 'ses_running1111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000 } }))
  mins.run('m_stale', 'ses_stale11111111111111111111111', now - 6 * 60 * 60 * 1000, now - 6 * 60 * 60 * 1000, JSON.stringify({ role: 'assistant', time: { created: now - 6 * 60 * 60 * 1000 } }))
  mins.run('m_err', 'ses_error111111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'stop' }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('p_run', 'm_run', 'ses_running1111111111111111111111', now, now, JSON.stringify({ type: 'step-start' }))
  pins.run('p_err', 'm_err', 'ses_error111111111111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error' } }))
  db.close()
  process.env.OPENCODE_DB = dbFile
  try {
    const byId = new Map((await opencode.scanThreads()).map((t) => [t.id, t]))
    assert.equal(byId.get('opencode:ses_running1111111111111111111111').running, true)
    assert.equal(byId.get('opencode:ses_stale11111111111111111111111').running, false, 'an open turn from hours ago is not still running')
    assert.equal(byId.get('opencode:ses_error111111111111111111111111').hasError, true)
    assert.equal(byId.get('opencode:ses_running1111111111111111111111').hasError, false)
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a turn the user stopped is not an error — denial and abort must not redden an astronaut', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-denied-'))
  const dbFile = path.join(home, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('ses_denied1111111111111111111111', 'global', null, '/tmp/d', 'Denied turn', 'build', null, now - 60000, now, null)
  ins.run('ses_aborted111111111111111111111', 'global', null, '/tmp/e', 'Aborted turn', 'build', null, now - 60000, now, null)
  ins.run('ses_failed1111111111111111111111', 'global', null, '/tmp/f', 'Failed turn', 'build', null, now - 60000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('m_denied', 'ses_denied1111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'tool-calls' }))
  mins.run('m_aborted', 'ses_aborted111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'stop' }))
  mins.run('m_failed', 'ses_failed1111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'stop' }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('p_denied', 'm_denied', 'ses_denied1111111111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } }))
  pins.run('p_aborted', 'm_aborted', 'ses_aborted111111111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'error', error: 'Tool execution aborted' } }))
  pins.run('p_failed', 'm_failed', 'ses_failed1111111111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'write', state: { status: 'error', error: 'SchemaError(Expected string, got object)' } }))
  db.close()
  process.env.OPENCODE_DB = dbFile
  try {
    const byId = new Map((await opencode.scanThreads()).map((t) => [t.id, t]))
    assert.equal(byId.get('opencode:ses_denied1111111111111111111111').hasError, false, 'a rejected permission is the user stopping the turn, not a failure')
    assert.equal(byId.get('opencode:ses_aborted111111111111111111111').hasError, false, 'an aborted call is a cancellation, not a failure')
    assert.equal(byId.get('opencode:ses_failed1111111111111111111111').hasError, true, 'a genuine tool failure still reddens the astronaut')
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a message-level abort is the user stopping, but a provider error is a failure', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-msgerr-'))
  const dbFile = path.join(home, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('ses_msgabort11111111111111111111', 'global', null, '/tmp/g', 'Aborted message', 'build', null, now - 60000, now, null)
  ins.run('ses_msgapi1111111111111111111111', 'global', null, '/tmp/h', 'Provider failure', 'build', null, now - 60000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('m_abort', 'ses_msgabort11111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, error: { name: 'MessageAbortedError' } }))
  mins.run('m_api', 'ses_msgapi1111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, error: { name: 'APIError' } }))
  db.close()
  process.env.OPENCODE_DB = dbFile
  try {
    const byId = new Map((await opencode.scanThreads()).map((t) => [t.id, t]))
    assert.equal(byId.get('opencode:ses_msgabort11111111111111111111').hasError, false)
    assert.equal(byId.get('opencode:ses_msgabort11111111111111111111').running, false)
    assert.equal(byId.get('opencode:ses_msgapi1111111111111111111111').hasError, true)
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('opencode refuses untrusted refs and offers no per-thread link', async () => {  const { home, h } = await fakeOpencode()
  try {
    const uuid = OPENCODE_SESSION
    assert.equal(h.openThread({ sessionId: [uuid] }).ok, false)
    assert.equal(h.openThread({ sessionId: { toString: () => uuid } }).ok, false)
    assert.equal(h.openThread({ sessionId: uuid }).ok, false)
    assert.equal(h.openThread(null).ok, false)
    assert.equal(h.openThread({}).ok, false)
    const opened = await h.newSession('/tmp/some repo')
    assert.equal(opened.ok, true)
    assert.equal(schemeOf(opened.url), 'opencode')
    assert.ok(opened.url.includes('directory='), 'the directory rides along')
    assert.equal((await h.newSession('relative/path')).ok, false)
  } finally {
    delete process.env.OPENCODE_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})
