/**
 * Families: a thread that started others is their manager while both are on the map.
 *
 * What is worth pinning is where a link stops counting. A manager with nobody left on the map
 * is drawn as one; a child with no manager on the map is listed under nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFamilies, crewSummary, familyRing, isManager } from '../src/game/families.js'
import { withErrands } from '../src/game/errands.js'

const t = (id, spawnedBy, createdAt = 0) => ({ id, spawnedBy, createdAt })

test('crew are listed under their manager, oldest first', () => {
  const f = buildFamilies([t('boss'), t('b', 'boss', 20), t('a', 'boss', 10), t('loner')])
  assert.deepEqual(f.crewOf.get('boss'), ['a', 'b'])
  assert.equal(f.managerOf.get('a'), 'boss')
  assert.equal(isManager(f, 'boss'), true)
  assert.equal(isManager(f, 'loner'), false)
  assert.equal(f.managerOf.has('loner'), false)
})

test('a link to a thread that is not on the map does not count', () => {
  const f = buildFamilies([t('orphan', 'archived-boss')])
  assert.equal(f.managerOf.has('orphan'), false, 'its manager went home; it is an ordinary thread again')
  assert.equal(f.crewOf.size, 0)
})

test('a thread naming itself is not its own manager', () => {
  const f = buildFamilies([t('x', 'x')])
  assert.equal(isManager(f, 'x'), false)
})

test('the family ring starts at the manager, from whichever member you are on', () => {
  const f = buildFamilies([t('boss'), t('a', 'boss', 1), t('b', 'boss', 2)])
  assert.deepEqual(familyRing(f, 'boss'), ['boss', 'a', 'b'])
  assert.deepEqual(familyRing(f, 'b'), ['boss', 'a', 'b'])
  assert.deepEqual(familyRing(f, 'nobody'), [])
})

test('a middle manager walks the family it belongs to', () => {
  const f = buildFamilies([t('top'), t('mid', 'top', 1), t('leaf', 'mid', 2)])
  assert.deepEqual(familyRing(f, 'mid'), ['top', 'mid'])
  assert.deepEqual(familyRing(f, 'leaf'), ['mid', 'leaf'])
})

test('a loop in the records ends without hanging', () => {
  const f = buildFamilies([t('a', 'b'), t('b', 'a')])
  assert.equal(familyRing(f, 'a').length, 2)
})

test('the crew summary sorts children into working, needing you, and stopped', () => {
  const f = buildFamilies([t('boss'), t('a', 'boss'), t('b', 'boss'), t('c', 'boss'), t('d', 'boss')])
  const status = { a: 'working', b: 'approval', c: 'idle', d: 'waiting' }
  assert.deepEqual(crewSummary(f, 'boss', (id) => status[id]), { total: 4, working: 1, needsYou: 2, done: 1 })
})

test('an errand does not inherit its parent’s manager', () => {
  const [, errand] = withErrands([{ id: 'p', spawnedBy: 'boss', subagents: [{ id: 's', task: 'look' }] }])
  assert.equal(errand.spawnedBy, undefined, 'or it would be listed as the manager’s crew')
})
