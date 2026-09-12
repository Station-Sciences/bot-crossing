import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  addRepositoryIdentity,
  clearRepositoryIdentityCache,
  normalizeRemote,
  workspaceRoot,
} from '../server/lib/repository-identity.mjs'
import { migrateLegacyPlotCells, preferredProjectPath } from '../src/game/project-groups.js'

const execFileAsync = promisify(execFile)
const git = (cwd, ...args) => execFileAsync('git', ['-C', cwd, ...args])

test('normalizes common spellings of one remote', () => {
  const expected = 'github.com/neurophos/models'
  assert.equal(normalizeRemote('git@github.com:Neurophos/models.git'), expected)
  assert.equal(normalizeRemote('ssh://git@github.com/Neurophos/models.git'), expected)
  assert.equal(normalizeRemote('https://github.com/Neurophos/models'), expected)
})

test('classifies the first directory below home as the workspace root', () => {
  assert.deepEqual(workspaceRoot('/Users/greg/nph/models', '/Users/greg'), {
    key: 'path:/Users/greg/nph',
    name: 'nph',
    path: '/Users/greg/nph',
  })
  assert.deepEqual(workspaceRoot('C:\\Users\\greg\\private\\app', 'C:\\Users\\greg'), {
    key: 'path:c:\\users\\greg\\private',
    name: 'private',
    path: 'C:\\Users\\greg\\private',
  })
  assert.equal(workspaceRoot('/tmp/build', '/Users/greg').name, 'Other')
})

test('one remote produces one plot across direct, nested, worktree, and submodule copies', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-identity-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const root = path.join(home, 'nph')
  const direct = path.join(root, 'models')
  const nested = path.join(root, 'build', '_deps', 'models-src')
  const worktree = path.join(root, 'models-worktree')
  const umbrella = path.join(root, 'umbrella')
  const submodule = path.join(umbrella, 'deps', 'models')

  await fsp.mkdir(direct, { recursive: true })
  await git(direct, 'init')
  await git(direct, 'config', 'user.email', 'test@example.com')
  await git(direct, 'config', 'user.name', 'Test')
  await fsp.writeFile(path.join(direct, 'README'), 'models\n')
  await git(direct, 'add', 'README')
  await git(direct, 'commit', '-m', 'seed')
  await git(direct, 'remote', 'add', 'origin', 'git@github.com:Neurophos/models.git')
  await git(direct, 'worktree', 'add', '-b', 'test-worktree', worktree)

  await fsp.mkdir(nested, { recursive: true })
  await git(nested, 'init')
  await git(nested, 'remote', 'add', 'origin', 'https://github.com/neurophos/models')

  await fsp.mkdir(umbrella, { recursive: true })
  await git(umbrella, 'init')
  await git(umbrella, 'config', 'user.email', 'test@example.com')
  await git(umbrella, 'config', 'user.name', 'Test')
  await execFileAsync('git', ['-c', 'protocol.file.allow=always', '-C', umbrella, 'submodule', 'add', direct, 'deps/models'])
  await git(submodule, 'remote', 'set-url', 'origin', 'ssh://git@github.com/Neurophos/models.git')

  clearRepositoryIdentityCache()
  const threads = await addRepositoryIdentity(
    [direct, nested, worktree, submodule].map((folder, i) => ({
      id: String(i),
      cwd: folder,
      projectPath: folder,
    })),
    home,
  )
  assert.equal(new Set(threads.map((thread) => thread.repoKey)).size, 1)
  assert.equal(new Set(threads.map((thread) => thread.plotKey)).size, 1)
  assert.deepEqual(new Set(threads.map((thread) => thread.project)), new Set(['models']))
})

test('unrelated non-git workspaces never merge', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-paths-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const one = path.join(home, 'nph', 'one', 'same')
  const two = path.join(home, 'nph', 'two', 'same')
  await Promise.all([fsp.mkdir(one, { recursive: true }), fsp.mkdir(two, { recursive: true })])
  clearRepositoryIdentityCache()
  const threads = await addRepositoryIdentity(
    [one, two].map((folder, i) => ({ id: String(i), cwd: folder, projectPath: folder, project: 'same' })),
    home,
  )
  assert.notEqual(threads[0].plotKey, threads[1].plotKey)
})

test('prefers a direct checkout for plot-level actions', () => {
  const threads = [
    { repoPath: '/tmp/models', workspaceRootPath: '/Users/greg/nph', lastActivityAt: 40 },
    { repoPath: '/Users/greg/nph/phoebe/models', workspaceRootPath: '/Users/greg/nph', lastActivityAt: 30 },
    { repoPath: '/Users/greg/nph/models', workspaceRootPath: '/Users/greg/nph', lastActivityAt: 10 },
    { repoPath: '/Users/greg/nph/models', workspaceRootPath: '/Users/greg/nph', lastActivityAt: 20 },
  ]
  assert.equal(preferredProjectPath(threads), '/Users/greg/nph/models')
})

test('migrates only unambiguous legacy layout names', () => {
  const cells = new Map([
    ['models', [{ q: 1, r: 2 }]],
    ['common', [{ q: 3, r: 4 }]],
  ])
  migrateLegacyPlotCells(cells, [
    { project: 'models', plotKey: 'nph::models' },
    { project: 'common', plotKey: 'nph::common-a' },
    { project: 'common', plotKey: 'nph::common-b' },
  ])
  assert.deepEqual(cells.get('nph::models'), [{ q: 1, r: 2 }])
  assert.equal(cells.has('models'), false)
  assert.equal(cells.has('common'), true)
})
