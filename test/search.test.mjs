import test from 'node:test'
import assert from 'node:assert/strict'
import { searchThreads } from '../src/game/search.js'

const threads = [
  { id: 'a', title: 'Fix the login bug' },
  { id: 'b', title: 'Login page redesign', worktree: 'feature-auth' },
  { id: 'c', title: '' },
  { id: 'd', title: 'Refactor logging' },
]

test('an empty query lists everything in the order given', () => {
  assert.deepEqual(searchThreads(threads, '  ').map((t) => t.id), ['a', 'b', 'c', 'd'])
})

test('every word must match, in any order, ignoring case', () => {
  assert.deepEqual(searchThreads(threads, 'BUG login').map((t) => t.id), ['a'])
  assert.deepEqual(searchThreads(threads, 'zzz'), [])
})

test('a title starting with the query beats one merely containing it', () => {
  assert.deepEqual(searchThreads(threads, 'login').map((t) => t.id), ['b', 'a'])
})

test('the worktree and the untitled placeholder are searchable', () => {
  assert.deepEqual(searchThreads(threads, 'auth').map((t) => t.id), ['b'])
  assert.deepEqual(searchThreads(threads, 'untitled').map((t) => t.id), ['c'])
})
