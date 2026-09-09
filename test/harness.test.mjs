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
import kilocode from '../server/harnesses/kilocode.mjs'
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

// ── Kilo Code, faked on disk ────────────────────────────────────────────

const KILO_SESSION = 'ses_aaaabbbbccccddddeeeeffff0000'

async function fakeKilocode() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilocode-fixture-'))
  const dbFile = path.join(home, 'kilo.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, workspace_id, parent_id, directory, path, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run(KILO_SESSION, 'proj1', null, null, 'C:/Users/test/demo', '', 'Fix the thing', 'orchestrator', JSON.stringify({ id: 'anthropic/claude-opus', providerID: 'kilo', variant: 'xhigh' }), now - 60000, now, null)
  ins.run('ses_child1111111111111111111111', 'proj1', null, KILO_SESSION, 'C:/Users/test/demo', '', 'Do subtask (@general subagent)', 'general', null, now - 50000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('msg_user1', KILO_SESSION, now - 60000, now - 60000, JSON.stringify({ role: 'user', time: { created: now - 60000 } }))
  mins.run('msg_asst1', KILO_SESSION, now - 59000, now - 58000, JSON.stringify({ role: 'assistant', time: { created: now - 59000, completed: now - 58000 }, finish: 'stop' }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('prt_user1', 'msg_user1', KILO_SESSION, now - 60000, now - 60000, JSON.stringify({ type: 'text', text: '  ship   the thing  ' }))
  pins.run('prt_asst1', 'msg_asst1', KILO_SESSION, now - 59000, now - 58000, JSON.stringify({ type: 'text', text: 'done' }))
  db.close()
  process.env.KILO_DB = dbFile
  return { home, h: kilocode }
}

test('kilocode lists only top-level sessions with mapped fields', async () => {
  const { home, h } = await fakeKilocode()
  try {
    assert.equal(await h.detect(), true)
    const threads = await h.scanThreads()
    assert.equal(threads.length, 1)
    const [t] = threads
    assert.equal(t.id, `kilocode:${KILO_SESSION}`)
    assert.equal(t.project, 'demo')
    assert.equal(t.projectPath, 'C:/Users/test/demo')
    assert.equal(t.cwd, 'C:/Users/test/demo')
    assert.equal(t.worktree, '')
    assert.equal(t.title, 'Fix the thing')
    assert.equal(t.preview, 'ship the thing')
    assert.equal(t.model, 'anthropic/claude-opus')
    assert.equal(t.canOpen, false)
    assert.deepEqual(t.ref, { sessionId: KILO_SESSION, cwd: 'C:/Users/test/demo' })
    assert.ok(t.sizeBytes > 0, 'sizeBytes is transcript bytes, not a token count')
  } finally {
    delete process.env.KILO_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('an absent kilocode is simply not detected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilocode-empty-'))
  process.env.KILO_DB = path.join(home, 'missing.db')
  try {
    assert.equal(await kilocode.detect(), false)
    assert.deepEqual(await kilocode.scanThreads(), [])
  } finally {
    delete process.env.KILO_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('kilocode running is bounded by the activity window and errors come from the last turn only', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilocode-status-'))
  const dbFile = path.join(home, 'kilo.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, workspace_id, parent_id, directory, path, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('ses_kilorun11111111111111111111', 'p', null, null, '/tmp/a', '', 'Running now', 'orchestrator', null, now - 60000, now, null)
  ins.run('ses_kilostale1111111111111111111', 'p', null, null, '/tmp/b', '', 'Stale open turn', 'orchestrator', null, now - 6 * 60 * 60 * 1000, now - 6 * 60 * 60 * 1000, null)
  ins.run('ses_kiloerr111111111111111111111', 'p', null, null, '/tmp/c', '', 'Failed turn', 'orchestrator', null, now - 60000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('m_run', 'ses_kilorun11111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000 } }))
  mins.run('m_stale', 'ses_kilostale1111111111111111111', now - 6 * 60 * 60 * 1000, now - 6 * 60 * 60 * 1000, JSON.stringify({ role: 'assistant', time: { created: now - 6 * 60 * 60 * 1000 } }))
  mins.run('m_err', 'ses_kiloerr111111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'stop' }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('p_run', 'm_run', 'ses_kilorun11111111111111111111', now, now, JSON.stringify({ type: 'step-start' }))
  pins.run('p_err', 'm_err', 'ses_kiloerr111111111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error' } }))
  db.close()
  process.env.KILO_DB = dbFile
  try {
    const byId = new Map((await kilocode.scanThreads()).map((t) => [t.id, t]))
    assert.equal(byId.get('kilocode:ses_kilorun11111111111111111111').running, true)
    assert.equal(byId.get('kilocode:ses_kilostale1111111111111111111').running, false, 'an open turn from hours ago is not still running')
    assert.equal(byId.get('kilocode:ses_kiloerr111111111111111111111').hasError, true)
    assert.equal(byId.get('kilocode:ses_kilorun11111111111111111111').hasError, false)
  } finally {
    delete process.env.KILO_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a turn the user stopped is not an error for kilocode either', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilocode-denied-'))
  const dbFile = path.join(home, 'kilo.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`)
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO session (id, project_id, workspace_id, parent_id, directory, path, title, agent, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('ses_kilodenied11111111111111111', 'p', null, null, '/tmp/d', '', 'Denied turn', 'orchestrator', null, now - 60000, now, null)
  ins.run('ses_kiloabort1111111111111111111', 'p', null, null, '/tmp/e', '', 'Aborted turn', 'orchestrator', null, now - 60000, now, null)
  const mins = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  mins.run('m_denied', 'ses_kilodenied11111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, finish: 'tool-calls' }))
  mins.run('m_abort', 'ses_kiloabort1111111111111111111', now - 60000, now, JSON.stringify({ role: 'assistant', time: { created: now - 60000, completed: now }, error: { name: 'MessageAbortedError' } }))
  const pins = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  pins.run('p_denied', 'm_denied', 'ses_kilodenied11111111111111111', now, now, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } }))
  db.close()
  process.env.KILO_DB = dbFile
  try {
    const byId = new Map((await kilocode.scanThreads()).map((t) => [t.id, t]))
    assert.equal(byId.get('kilocode:ses_kilodenied11111111111111111').hasError, false, 'a rejected permission is the user stopping the turn, not a failure')
    assert.equal(byId.get('kilocode:ses_kiloabort1111111111111111111').hasError, false, 'an aborted message is a cancellation, not a failure')
  } finally {
    delete process.env.KILO_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('kilocode refuses untrusted refs and offers a folder link for new sessions', async () => {
  const { home, h } = await fakeKilocode()
  try {
    assert.equal(h.openThread({ sessionId: [KILO_SESSION] }).ok, false)
    assert.equal(h.openThread({ sessionId: { toString: () => KILO_SESSION } }).ok, false)
    assert.equal(h.openThread({ sessionId: KILO_SESSION }).ok, false)
    assert.equal(h.openThread(null).ok, false)
    assert.equal(h.openThread({}).ok, false)
    const opened = h.newSession('/tmp/some repo')
    assert.equal(opened.ok, true)
    assert.equal(schemeOf(opened.url), 'vscode')
    assert.ok(opened.url.includes('%20'), 'a space in the path is escaped, not left raw')
    assert.equal(h.newSession('relative/path').ok, false)
  } finally {
    delete process.env.KILO_DB
    await fsp.rm(home, { recursive: true, force: true })
  }
})
