/** Unarchive, end to end against real files in a throwaway home directory. Run with `npm test`. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  adapter,
  api,
  readJson,
  readState,
  setupHome,
  teardownHome,
  threadById,
  userRecord,
  uuid,
  writeDesktopRecord,
  writeJson,
  writeTranscript,
} from './helpers.mjs'

before(setupHome)
after(teardownHome)

const archive = (thread, archived) =>
  api('POST', '/api/archive', { id: thread.id, harness: thread.harness, ref: thread.ref, archived })

/** A desktop thread, archived through the colony the normal way. */
async function archivedDesktopThread(n) {
  const cli = uuid(n)
  await writeTranscript(cli, [userRecord(cli, 'Opening prompt')])
  const file = await writeDesktopRecord({
    sessionId: `local_${uuid(n + 1000)}`,
    cliSessionId: cli,
    title: `Thread ${n}`,
    cwd: 'C:\\Dev\\repo',
  })
  await archive(await threadById(cli), true)
  assert.equal((await threadById(cli)).archived, true)
  assert.equal((await readJson(file)).isArchived, true)
  return { id: cli, file }
}

test('unarchiving clears the colony list and the harness flag, and the thread comes back', async () => {
  const { id, file } = await archivedDesktopThread(1)

  const res = await archive(await threadById(id), false)
  assert.equal(res.status, 200)
  assert.equal(res.body.archived, false)

  assert.equal((await readState()).archived.includes(id), false)
  assert.equal((await readJson(file)).isArchived, false)
  assert.equal((await threadById(id)).archived, false)
})

test('an unarchive is re-asserted when a running app writes its stale archived copy back', async () => {
  const { id, file } = await archivedDesktopThread(2)
  await archive(await threadById(id), false)

  // The desktop app, still holding the record in memory, rewrites it as archived.
  const record = await readJson(file)
  record.isArchived = true
  await writeJson(file, record)

  assert.equal((await threadById(id)).archived, false)
  assert.equal((await readJson(file)).isArchived, false)
})

test('a thread archived only in Claude Code can be unarchived from the colony', async () => {
  const cli = uuid(3)
  await writeTranscript(cli, [userRecord(cli, 'Opening prompt')])
  const file = await writeDesktopRecord({
    sessionId: `local_${uuid(1003)}`,
    cliSessionId: cli,
    title: 'Archived in the app',
    cwd: 'C:\\Dev\\repo',
    isArchived: true,
  })
  const thread = await threadById(cli)
  assert.equal(thread.archived, true)

  await archive(thread, false)
  assert.equal((await readJson(file)).isArchived, false)
  assert.equal((await threadById(cli)).archived, false)
})

test('a terminal-only thread archived in the colony comes back, and the colony lets go at once', async () => {
  const id = uuid(4)
  await writeTranscript(id, [userRecord(id, 'Opening prompt')])
  await archive(await threadById(id), true)
  assert.equal((await threadById(id)).archived, true)

  await archive(await threadById(id), false)
  assert.equal((await threadById(id)).archived, false)
  // No app owns this thread, so there is nothing to keep re-asserting against.
  assert.equal((await readState()).unarchivedAt[id], undefined)
})

test('archiving again after an unarchive wins over the earlier unarchive', async () => {
  const { id, file } = await archivedDesktopThread(5)
  await archive(await threadById(id), false)
  await archive(await threadById(id), true)

  assert.equal((await readState()).unarchivedAt[id], undefined)
  assert.equal((await threadById(id)).archived, true)
  assert.equal((await readJson(file)).isArchived, true)
})

test('once the app has restarted, an archive made inside it is not undone by an old unarchive', async (t) => {
  const { id, file } = await archivedDesktopThread(7)
  await archive(await threadById(id), false)

  // The app relaunches after the unarchive, loading the unarchived record...
  const realStart = adapter.appStartedAt
  t.after(() => {
    adapter.appStartedAt = realStart
  })
  const launchedAt = Date.now() + 1000
  adapter.appStartedAt = async () => launchedAt

  // ...and then you archive the thread inside the app yourself.
  const record = await readJson(file)
  record.isArchived = true
  await writeJson(file, record)

  assert.equal((await threadById(id)).archived, true)
  assert.equal((await readJson(file)).isArchived, true)
  assert.equal((await readState()).unarchivedAt[id], undefined)
})

test('a page saving its state whole does not drop a pending unarchive', async () => {
  const { id } = await archivedDesktopThread(6)
  await archive(await threadById(id), false)
  const pending = (await readState()).unarchivedAt[id]
  assert.ok(pending)

  await api('PUT', '/api/state', { opened: [], plots: {}, seen: {}, settings: null })
  assert.equal((await readState()).unarchivedAt[id], pending)
})
