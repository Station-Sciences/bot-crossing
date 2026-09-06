import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'

const adapterURL = new URL('../server/harnesses/codex.mjs', import.meta.url)
const event = (type, error = false) => JSON.stringify({
  timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, error },
}) + '\n'

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
  const names = ['CODEX_HOME', 'BOT_CROSSING_CODEX_BIN', 'BOT_CROSSING_DATA', 'PATH']
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.CODEX_HOME = dir
  process.env.BOT_CROSSING_DATA = path.join(dir, 'colony')
  delete process.env.BOT_CROSSING_CODEX_BIN
  t.after(async () => {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name]
      else process.env[name] = env[name]
    }
    await fsp.rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'state_5.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT, source TEXT DEFAULT 'vscode', title TEXT, name TEXT,
      preview TEXT, first_user_message TEXT, model TEXT, reasoning_effort TEXT,
      rollout_path TEXT, project_id TEXT, thread_source TEXT, archived INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 999999, is_pinned INTEGER DEFAULT 0, git_branch TEXT,
      created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE thread_spawn_edges (child_thread_id TEXT);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
  `)
  t.after(() => db.close())
  const add = async (overrides = {}, text = event('task_complete')) => {
    const id = overrides.id || randomUUID()
    const rollout = path.join(dir, id + '.jsonl')
    await fsp.writeFile(rollout, text)
    const now = Date.now()
    const row = {
      id, cwd: path.join(dir, 'repo'), source: 'vscode', title: 'Task', rollout_path: rollout,
      created_at: Math.floor(now / 1000), updated_at: Math.floor(now / 1000), ...overrides,
    }
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO threads (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row))
    return { id, rollout: row.rollout_path }
  }
  const load = async () => (await import(`${adapterURL}?test=${randomUUID()}`)).default
  return { dir, file, db, add, load }
}

test('canonical metadata, children, desktop project fallback and byte counts; scans are read-only', async (t) => {
  const f = await fixture(t)
  const root = path.join(f.dir, 'repo')
  f.db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p', 0, root)
  const parent = await f.add({
    name: 'Named task', title: 'Older title', preview: '<environment_context>noise</environment_context> Hello',
    project_id: 'p', cwd: path.join(f.dir, 'worktrees', 'abc', 'repo'),
    model: 'test-model', reasoning_effort: 'high', is_pinned: 1, git_branch: 'feature',
  }, event('task_started'))
  const child = await f.add()
  f.db.prepare('INSERT INTO thread_spawn_edges VALUES (?)').run(child.id)
  await f.add({ thread_source: 'subagent' })
  await f.add({ cwd: null })
  await f.add({ id: 'malformed-id' })
  await f.add({ source: '{"subagent":{"other":"guardian"}}', thread_source: 'guardian_review' })
  const archived = await f.add({ source: 'cli', archived: 1 })
  const exec = await f.add({ source: 'exec', thread_source: 'user' })
  const legacy = await f.add({ cwd: path.join(f.dir, 'worktrees', 'old', 'repo') })
  const assigned = await f.add({ cwd: path.join(f.dir, 'worktrees', 'assigned', 'repo') })
  await fsp.writeFile(path.join(f.dir, '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': { 'unread-thread-ids-by-host-v1': { local: [parent.id] } },
    'thread-workspace-root-hints': { [legacy.id]: root },
    'thread-project-assignments': { [assigned.id]: { projectId: 'legacy-project' } },
    'local-projects': { 'legacy-project': { rootPaths: [root] } },
  }))
  const fingerprint = async () => {
    const result = {}
    for (const file of await fsp.readdir(f.dir)) {
      const full = path.join(f.dir, file)
      const stat = await fsp.stat(full)
      if (stat.isFile()) result[file] = [stat.mtimeMs, createHash('sha256').update(await fsp.readFile(full)).digest('hex')]
    }
    return result
  }
  const before = await fingerprint()
  const mock = t.mock.method(childProcess, 'execFile', () => { throw new Error('scan spawned a process') })
  syncBuiltinESMExports()
  try {
    const c = await f.load()
    assert.equal(await c.detect(), true)
    const rows = await c.scanThreads()
    assert.equal(rows.length, 5)
    assert.equal(mock.mock.callCount(), 0)
    const row = rows.find((r) => r.id === parent.id)
    assert.equal(row.title, 'Named task')
    assert.equal(row.preview, 'Hello')
    assert.equal(row.projectPath, root)
    assert.equal(row.worktree, 'abc')
    assert.equal(row.model, 'test-model')
    assert.equal(row.effort, 'high')
    assert.equal(row.starred, true)
    assert.equal(row.unread, true)
    assert.equal(row.running, true)
    assert.equal(row.sizeBytes, (await fsp.stat(parent.rollout)).size)
    assert.equal(rows.find((r) => r.id === archived.id).archived, true)
    assert.equal(rows.find((r) => r.id === exec.id).source, 'exec')
    assert.equal(rows.find((r) => r.id === legacy.id).projectPath, root)
    assert.equal(rows.find((r) => r.id === assigned.id).projectPath, root)
    assert.ok(rows.every((r) => Object.values(r).every((v) => v !== undefined)))
    await c.scanThreads()
    assert.deepEqual(await fingerprint(), before)
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('lifecycle transitions, errors, cancellation, malformed and partial records, and stale activity', async (t) => {
  const f = await fixture(t)
  const row = await f.add({}, event('task_started'))
  const c = await f.load()
  const scan = async () => (await c.scanThreads())[0]
  assert.equal((await scan()).running, true)
  await fsp.appendFile(row.rollout, '{broken\nnull\n' + event('task_complete', true).trimEnd())
  assert.equal((await scan()).running, true, 'unfinished JSONL records are not authoritative')
  await fsp.appendFile(row.rollout, '\n')
  assert.equal((await scan()).running, false)
  assert.equal((await scan()).hasError, true)
  await fsp.appendFile(row.rollout, event('task_started'))
  assert.equal((await scan()).hasError, false)
  assert.equal((await scan()).running, true)
  await fsp.appendFile(row.rollout, event('turn_aborted'))
  assert.equal((await scan()).running, false)
  assert.equal((await scan()).hasError, false)
  await fsp.appendFile(row.rollout, event('task_started'))
  const old = new Date(Date.now() - 31 * 60 * 1000)
  await fsp.utimes(row.rollout, old, old)
  assert.equal((await scan()).running, false)
})

test('bounded tails retain append state but invalidate truncation, rewrite and replacement', async (t) => {
  const f = await fixture(t)
  const row = await f.add({}, event('task_started'))
  const c = await f.load()
  const scan = async () => (await c.scanThreads())[0]
  await scan()
  const noise = (JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024) } }) + '\n')
    .repeat(2100)
  await fsp.appendFile(row.rollout, noise)
  assert.equal((await scan()).running, true, 'cached lifecycle survives genuine append beyond tail budget')
  await fsp.writeFile(row.rollout, '{}\n')
  assert.equal((await scan()).running, false)
  await fsp.writeFile(row.rollout, event('task_started'))
  assert.equal((await scan()).running, true)
  await fsp.writeFile(row.rollout, noise)
  assert.equal((await scan()).running, false, 'larger in-place rewrite is not an append')
  await fsp.writeFile(row.rollout, event('task_started'))
  await scan()
  const previous = await fsp.stat(row.rollout)
  const replacement = row.rollout + '.tmp'
  await fsp.writeFile(replacement, ' '.repeat(previous.size - 3) + '{}\n')
  await fsp.utimes(replacement, previous.atime, previous.mtime)
  await fsp.rename(replacement, row.rollout)
  assert.equal((await scan()).running, false, 'same-size replacement with preserved mtime loses cached state')
})

test('missing, non-file and escaping rollouts do not hide other tasks', async (t) => {
  const f = await fixture(t)
  const good = await f.add()
  const missing = await f.add()
  await fsp.unlink(missing.rollout)
  const directory = await f.add({ rollout_path: f.dir })
  const escaping = await f.add({ rollout_path: '/etc/hosts' })
  const rows = await (await f.load()).scanThreads()
  assert.equal(rows.length, 4)
  assert.ok(rows.find((r) => r.id === good.id).sizeBytes > 0)
  for (const { id } of [missing, directory, escaping]) {
    const row = rows.find((r) => r.id === id)
    assert.equal(row.sizeBytes, 0)
    assert.equal(row.running, false)
  }
})

test('highest schema version, optional columns and unsupported runtime diagnostics', async (t) => {
  const f = await fixture(t)
  await f.add()
  const newer = new DatabaseSync(path.join(f.dir, 'state_12.sqlite'))
  const id = randomUUID()
  newer.exec('CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT, created_at INTEGER, updated_at INTEGER)')
  newer.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, f.dir, 'cli', 100, 200)
  newer.close()
  const c = await f.load()
  const rows = await c.scanThreads()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id)
  assert.equal(rows[0].createdAt, 100000)
  assert.equal(rows[0].lastActivityAt, 200000)
  assert.equal(rows[0].model, '')
  const version = Object.getOwnPropertyDescriptor(process.versions, 'node')
  try {
    Object.defineProperty(process.versions, 'node', { ...version, value: '22.11.0' })
    assert.match(await c.diagnostic(), /Node 22\.13/)
    await assert.rejects(c.scanThreads(), /Node 22\.13/)
  } finally {
    Object.defineProperty(process.versions, 'node', version)
  }
})

test('deep links validate IDs and encode paths; archive invokes only the standalone CLI', async (t) => {
  const f = await fixture(t)
  const c = await f.load()
  const id = randomUUID()
  assert.equal(c.openThread({ sessionId: '../bad' }).ok, false)
  assert.equal(c.openThread({ sessionId: id }).url, `codex://threads/${id}`)
  const folder = path.join(f.dir, 'a & b?#雪')
  const url = new URL(c.newSession(folder).url)
  assert.equal(url.searchParams.get('path'), folder)
  const log = path.join(f.dir, 'calls.json')
  const bin = path.join(f.dir, 'codex')
  await fsp.writeFile(bin, `#!${process.execPath}\n` +
    `require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  process.env.PATH = f.dir
  assert.equal((await c.setArchived({ sessionId: id }, true)).ok, true)
  assert.deepEqual(JSON.parse(await fsp.readFile(log)), ['archive', id])
  assert.equal((await c.setArchived({ sessionId: id }, false)).ok, true)
  assert.deepEqual(JSON.parse(await fsp.readFile(log)), ['unarchive', id])
  assert.equal((await c.setArchived({ sessionId: id }, 'false')).ok, false)
  assert.equal((await c.setArchived({ sessionId: '../bad' }, true)).ok, false)
  await fsp.writeFile(bin, `#!${process.execPath}\nprocess.stderr.write('archive failed');process.exit(1)\n`)
  assert.match((await c.setArchived({ sessionId: id }, true)).error, /archive failed/)
  await fsp.unlink(bin)
  assert.match((await c.setArchived({ sessionId: id }, true)).error, /No standalone Codex CLI/)
  const bundled = path.join(f.dir, 'Unsafe.app', 'Contents', 'Resources', 'codex')
  await fsp.mkdir(path.dirname(bundled), { recursive: true })
  await fsp.writeFile(bundled, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o700 })
  await fsp.symlink(bundled, bin)
  process.env.BOT_CROSSING_CODEX_BIN = bin
  assert.equal((await c.setArchived({ sessionId: id }, true)).ok, false)
})

test('API confirms database archives without subprocesses and preserves Claude restart semantics', async (t) => {
  const f = await fixture(t)
  const { HARNESSES } = await import('../server/harnesses/index.mjs')
  const previous = [...HARNESSES]
  t.after(() => HARNESSES.splice(0, HARNESSES.length, ...previous))
  let codexArchived = false
  let codexCalls = 0
  let claudeCalls = 0
  let restarted = false
  const now = Date.now()
  HARNESSES.splice(0, HARNESSES.length,
    { id: 'codex', name: 'Codex', archiveSync: 'database', detect: async () => true,
      diagnostic: async () => 'Runtime diagnostic',
      scanThreads: async () => [{ id: 'codex-task', archived: codexArchived, canArchive: true, lastActivityAt: now }],
      setArchived: async () => { codexCalls++; return { ok: false, error: 'No standalone Codex CLI' } },
    },
    { id: 'claude-code', name: 'Claude Code', detect: async () => true,
      scanThreads: async () => [{ id: 'claude-task', archived: false, canArchive: true, lastActivityAt: now }],
      appStartedAt: async () => restarted ? now + 1000 : now - 1000,
      setArchived: async () => { claudeCalls++; return { ok: true } },
    })
  await fsp.mkdir(process.env.BOT_CROSSING_DATA)
  await fsp.writeFile(path.join(process.env.BOT_CROSSING_DATA, 'colony.json'), JSON.stringify({
    archived: ['codex-task', 'claude-task'], archivedAt: { 'codex-task': now, 'claude-task': now },
  }))
  const { apiMiddleware } = await import(`../server/api.mjs?test=${randomUUID()}`)
  const request = (url, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = new PassThrough()
    Object.assign(req, { url, method, headers: { host: '127.0.0.1:5274', origin: 'http://127.0.0.1:5274' } })
    let status
    const res = { writeHead(code) { status = code }, end(text) { resolve({ status, body: JSON.parse(text) }) } }
    apiMiddleware(req, res).catch(reject)
    if (body) req.end(JSON.stringify(body))
  })
  let response = await request('/api/threads')
  assert.equal(response.body.threads.find((r) => r.id === 'codex-task').archivePending, true)
  assert.equal(response.body.threads.find((r) => r.id === 'claude-task').archivePending, true)
  assert.equal(codexCalls, 0)
  assert.equal(claudeCalls, 1)
  assert.deepEqual(response.body.warnings, ['Runtime diagnostic'])
  codexArchived = true
  restarted = true
  response = await request('/api/threads')
  assert.ok(response.body.threads.every((r) => r.archivePending === false))
  assert.equal(codexCalls, 0)
  response = await request('/api/archive', 'POST', { id: 'codex-task', harness: 'codex', ref: {}, archived: true })
  assert.equal(response.status, 400)
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, /No standalone/)
})
