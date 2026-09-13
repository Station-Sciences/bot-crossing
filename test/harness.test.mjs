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

// ── Antigravity, faked on disk ────────────────────────────────────────────────

async function fakeAntigravity(records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'antigravity-fixture-'))
  const dir = path.join(home, SESSION_ID, '.system_generated', 'logs')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'transcript.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return home
}

async function antigravityWith(home) {
  process.env.BOT_CROSSING_ANTIGRAVITY_DIR = home
  const mod = await import(`../server/harnesses/antigravity.mjs?${home}`)
  return mod.default
}

test('an Antigravity transcript yields a thread with cleaned prompt as title', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-13T10:00:00Z',
      content: '<USER_REQUEST>\nbuild a space station\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nActive Document: /tmp/my-space-app/main.js\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-13T10:01:00Z',
      content: 'I will build it.',
    },
  ])
  const h = await antigravityWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `antigravity:${SESSION_ID}`)
  assert.equal(t.title, 'build a space station')
  assert.equal(t.project, 'my-space-app')
  assert.equal(t.running, false)
  assert.equal(t.unread, false)
  assert.equal(t.hasError, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity pending ask_question is detected as unread/waiting', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nneed advice\n</USER_REQUEST>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      created_at: new Date().toISOString(),
      tool_calls: [
        {
          name: 'ask_question',
          args: { questions: [{ question: 'Which path?', options: ['A', 'B'] }] },
        },
      ],
    },
  ])
  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  assert.equal(t.unread, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity pending artifact review is detected as unread/waiting', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nmake a plan\n</USER_REQUEST>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [
        {
          name: 'write_to_file',
          args: {
            TargetFile: '/path/plan.md',
            ArtifactMetadata: { RequestFeedback: true, Summary: 'test plan', UserFacing: true },
          },
        },
      ],
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'Here is the plan for your review.',
    },
  ])
  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  assert.equal(t.unread, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity running turn is detected as running', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nworking now\n</USER_REQUEST>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      created_at: new Date().toISOString(),
    },
  ])
  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity turn with tool execution is detected as running', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nrun tests\n</USER_REQUEST>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'RUN_COMMAND',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'Tests running...',
    },
  ])
  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, true)
  assert.equal(t.unread, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity tool call pending user permission for >3s is detected as unread/waiting', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date(Date.now() - 10000).toISOString(),
      content: '<USER_REQUEST>\nquery db\n</USER_REQUEST>',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.now() - 10000).toISOString(),
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node -e sqlite' } }],
    },
  ])
  const transcriptPath = path.join(home, SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl')
  const tenSecsAgo = new Date(Date.now() - 10000)
  await fsp.utimes(transcriptPath, tenSecsAgo, tenSecsAgo)

  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  assert.equal(t.unread, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an absent Antigravity is not detected', async () => {
  const home = path.join(os.tmpdir(), 'antigravity-absent-' + SESSION_ID)
  const h = await antigravityWith(home)
  assert.equal(await h.detect(), false)
  assert.deepEqual(await h.scanThreads(), [])
})

test('an Antigravity transcript older than 7 days is skipped by default', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-06-01T10:00:00Z',
      content: '<USER_REQUEST>\nold chat\n</USER_REQUEST>',
    },
  ])
  const transcriptPath = path.join(home, SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl')
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await fsp.utimes(transcriptPath, tenDaysAgo, tenDaysAgo)

  const h = await antigravityWith(home)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 0)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity transcript older than 7 days is included if MAX_DAYS allows it', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-06-01T10:00:00Z',
      content: '<USER_REQUEST>\nold chat\n</USER_REQUEST>',
    },
  ])
  const transcriptPath = path.join(home, SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl')
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await fsp.utimes(transcriptPath, tenDaysAgo, tenDaysAgo)

  process.env.BOT_CROSSING_ANTIGRAVITY_MAX_DAYS = '14'
  const h = await antigravityWith(home)
  const threads = await h.scanThreads()
  delete process.env.BOT_CROSSING_ANTIGRAVITY_MAX_DAYS
  assert.equal(threads.length, 1)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity thread with projectPath has canOpen=true and openThread returns URL', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\ncheck files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nActive Document: /home/rayrayaray/Project/my-app/index.js\n</ADDITIONAL_METADATA>',
    },
  ])
  const h = await antigravityWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.canOpen, true)
  assert.equal(t.cwd, '/home/rayrayaray/Project/my-app')

  const res = await h.openThread(t.ref)
  assert.equal(res.ok, true)
  assert.equal(res.url, 'antigravity-ide://file/home/rayrayaray/Project/my-app')

  const noDirRes = await h.openThread({})
  assert.equal(noDirRes.ok, false)

  await fsp.rm(home, { recursive: true, force: true })
})
