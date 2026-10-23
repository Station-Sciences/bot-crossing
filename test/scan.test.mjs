/**
 * Project names: the disambiguation that should only fire when two checkouts really do collide.
 *
 * The interesting cases are all Windows, because Windows is where one folder on disk reaches the
 * scanner spelled three different ways — `C:\…`, `c:\…`, and `\\?\C:\…`. Counted as three paths
 * instead of one, a name that nothing collides with looks ambiguous against itself, and both
 * plots get renamed to their full absolute paths on a machine that has no collision at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { disambiguateProjects, placeWorktrees } from '../server/scan.mjs'

const thread = (id, project, projectPath) => ({ id, project, projectPath })
const names = (threads) => disambiguateProjects(threads).map((t) => t.project)

test('one checkout spelled with and without the extended-length prefix is still one project', () => {
  assert.deepEqual(
    names([
      thread('a', 'geh', '\\\\?\\C:\\Users\\me\\Documents\\Codex\\geh'),
      thread('b', 'geh', 'C:\\Users\\me\\Documents\\Codex\\geh'),
    ]),
    ['geh', 'geh']
  )
})

test('the drive letter alone never splits a project in two', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', 'c:\\work\\foo'),
      thread('b', 'foo', 'C:\\work\\foo'),
    ]),
    ['foo', 'foo']
  )
})

test('all three spellings of one path collapse together', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\C:\\work\\foo'),
      thread('b', 'foo', 'c:\\work\\foo'),
      thread('c', 'foo', 'C:\\work\\foo'),
    ]),
    ['foo', 'foo', 'foo']
  )
})

test('two real checkouts of the same repo still separate', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', 'C:\\work\\1\\foo'),
      thread('b', 'foo', 'C:\\work\\2\\foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

test('a prefixed path and a real second checkout separate on the path, not the prefix', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\C:\\work\\1\\foo'),
      thread('b', 'foo', 'C:\\work\\2\\foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

test('a share is not a drive — \\\\?\\UNC\\… keeps its own identity', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '\\\\?\\UNC\\server\\share\\foo'),
      thread('b', 'foo', 'C:\\work\\foo'),
    ]),
    ['share/foo', 'work/foo']
  )
})

test('posix paths are untouched by any of it', () => {
  assert.deepEqual(
    names([
      thread('a', 'foo', '/home/me/1/foo'),
      thread('b', 'foo', '/home/me/2/foo'),
    ]),
    ['1/foo', '2/foo']
  )
})

// ── worktrees ─────────────────────────────────────────────────────────────────

/**
 * A repository and one linked worktree of it somewhere else entirely, the way Codex lays them out:
 * the checkout's `.git` is a file naming the repository's `.git/worktrees/<name>`.
 */
async function repoWithWorktree() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-wt-'))
  const repo = path.join(root, 'projects', 'storefront')
  const checkout = path.join(root, '.codex', 'worktrees', 'b7af', 'storefront')
  await fsp.mkdir(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true })
  await fsp.mkdir(checkout, { recursive: true })
  await fsp.writeFile(path.join(checkout, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`)
  return { root, repo, checkout }
}

test('a linked worktree joins its repository, named by git rather than by the folder it sits in', async () => {
  const { root, repo, checkout } = await repoWithWorktree()
  try {
    const [placed] = await placeWorktrees([{ id: 'a', project: 'storefront', projectPath: checkout, worktree: '' }])
    assert.equal(placed.projectPath, repo)
    assert.equal(placed.project, 'storefront')
    assert.equal(placed.worktree, 'feature')
    // And so the repository and its worktree no longer read as two checkouts that need renaming.
    const main = { id: 'b', project: 'storefront', projectPath: repo, worktree: '' }
    assert.deepEqual(disambiguateProjects([placed, main]).map((t) => t.project), ['storefront', 'storefront'])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a removed worktree inside .claude/worktrees still finds its repository by its path', async () => {
  const repo = path.join(os.tmpdir(), 'bot-crossing-gone', 'app')
  const gone = path.join(repo, '.claude', 'worktrees', 'agent-1234')
  const [placed] = await placeWorktrees([{ id: 'a', project: 'agent-1234', projectPath: gone, worktree: '' }])
  assert.deepEqual([placed.project, placed.projectPath, placed.worktree], ['app', repo, 'agent-1234'])
})

test('a submodule, a plain checkout and an adapter-placed worktree are all left alone', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-sub-'))
  try {
    const sub = path.join(root, 'sub')
    const plain = path.join(root, 'plain')
    await fsp.mkdir(sub, { recursive: true })
    await fsp.mkdir(path.join(plain, '.git'), { recursive: true })
    await fsp.writeFile(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n')
    const threads = [
      { id: 'a', project: 'sub', projectPath: sub, worktree: '' },
      { id: 'b', project: 'plain', projectPath: plain, worktree: '' },
      { id: 'c', project: 'x', projectPath: sub, worktree: 'already' },
      { id: 'd', project: 'unknown', projectPath: '', worktree: '' },
    ]
    assert.deepEqual(await placeWorktrees(threads), threads)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
