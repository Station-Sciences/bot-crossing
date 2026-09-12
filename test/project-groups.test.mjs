import assert from 'node:assert/strict'
import test from 'node:test'
import { hiddenCatalog, liveThreadsForColony } from '../src/game/hidden-projects.js'
import { dormantPlotKeys, migrateLegacyHiddenProjects } from '../src/game/project-groups.js'
import { allocateCells } from '../src/world/plots.js'

test('legacy hidden names migrate only when exactly one plot owns the name', () => {
  const threads = [
    { project: 'models', legacyProject: 'models', plotKey: 'nph::models' },
    { project: 'common', legacyProject: 'common', plotKey: 'nph::common-a' },
    { project: 'common', legacyProject: 'common', plotKey: 'private::common-b' },
  ]
  assert.deepEqual(
    migrateLegacyHiddenProjects(['models', 'common'], threads),
    ['nph::models', 'common'],
  )
})

test('hiding is keyed by plotKey even when display names collide', () => {
  const threads = [
    { id: 'a', project: 'common', plotKey: 'nph::common' },
    { id: 'b', project: 'common', plotKey: 'private::common' },
  ]
  assert.deepEqual(
    liveThreadsForColony(threads, new Set(), new Set(['nph::common'])).map((thread) => thread.id),
    ['b'],
  )
})

test('dormant folding uses plotKey while its catalog keeps human names', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const old = now - 4 * 24 * 60 * 60 * 1000
  const byProject = new Map([
    ['stable::quiet', [{ project: 'Readable Quiet', plotKey: 'stable::quiet', lastActivityAt: old }]],
    ['stable::live', [{ project: 'Readable Live', plotKey: 'stable::live', lastActivityAt: now }]],
  ])
  const folded = dormantPlotKeys(byProject, (thread) => now - thread.lastActivityAt > 3 * 24 * 60 * 60 * 1000)
  assert.deepEqual([...folded], ['stable::quiet'])
  assert.deepEqual(hiddenCatalog([...folded], [...byProject.values()].flat()), [
    { key: 'stable::quiet', name: 'Readable Quiet', count: 1 },
  ])
})

test('switching root A to B and back keeps settled zone cells stable', () => {
  const rootA = [
    { id: 'root-a::one', size: 8 },
    { id: 'root-a::two', size: 1 },
  ]
  const rootB = [
    { id: 'root-b::one', size: 15 },
    { id: 'root-b::two', size: 1 },
    { id: 'root-b::three', size: 1 },
  ]
  const memory = new Map()
  const remember = (layout) => {
    for (const [key, cells] of layout) memory.set(key, cells)
    return layout
  }

  const firstA = remember(allocateCells(rootA, memory))
  remember(allocateCells(rootB, memory))
  const secondA = remember(allocateCells(rootA, memory))
  assert.deepEqual(secondA, firstA)
})
