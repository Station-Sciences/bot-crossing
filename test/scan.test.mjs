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

import { disambiguateProjects } from '../server/scan.mjs'

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
