import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDisplayTree,
  buildScanTree,
  isPathIncluded,
  isThreadIncluded,
  isUnderRoot,
  normalizeExclusions,
  repoPathsFromThreads,
  selectionState,
  toggleSelection,
} from '../src/game/scan-selection.js'

const REPOS = [
  '/Users/me/work/foo',
  '/Users/me/work/bar',
  '/Users/me/other/baz',
  '/Users/me/workfoo/bar',
]

test('prefix matching respects directory boundaries', () => {
  assert.equal(isUnderRoot('/Users/me/work/foo/child', '/Users/me/work/foo'), true)
  assert.equal(isUnderRoot('/Users/me/work/foo-bar', '/Users/me/work/foo'), false)
})

test('an empty exclusion list leaves every thread on the map', () => {
  assert.equal(isThreadIncluded({ projectPath: '/Users/me/work/foo' }, []), true)
})

test('normalizeExclusions deduplicates and sorts, and keeps nested entries apart', () => {
  assert.deepEqual(normalizeExclusions(['/Users/me/work', '/Users/me/work/foo', '/Users/me/work']), [
    '/Users/me/work',
    '/Users/me/work/foo',
  ])
  assert.deepEqual(normalizeExclusions(['relative/path', 42, null]), [])
  assert.deepEqual(normalizeExclusions(undefined), [])
})

test('unticking a folder takes every repository under it off the map', () => {
  const next = toggleSelection('/Users/me/work', false, REPOS, [])
  assert.deepEqual(next, ['/Users/me/work/bar', '/Users/me/work/foo'])
  assert.equal(isPathIncluded('/Users/me/workfoo/bar', next), true, 'a sibling that merely shares a prefix stays')
})

test('ticking a child again brings back only that branch', () => {
  const excluded = toggleSelection('/Users/me/work', false, REPOS, [])
  const next = toggleSelection('/Users/me/work/foo', true, REPOS, excluded)
  assert.deepEqual(next, ['/Users/me/work/bar'])
  assert.equal(isPathIncluded('/Users/me/work/foo', next), true)
})

test('selectionState reports mixed when only part of a folder is off', () => {
  assert.equal(selectionState('/Users/me/work', REPOS, ['/Users/me/work/foo']), 'mixed')
  assert.equal(selectionState('/Users/me/work', REPOS, []), 'checked')
  assert.equal(
    selectionState('/Users/me/work', REPOS, ['/Users/me/work/foo', '/Users/me/work/bar']),
    'unchecked'
  )
})

/**
 * The bug this whole model exists to avoid. A dotfiles checkout at `~` makes every other
 * project on the machine its descendant, and under any prefix-based scheme that one entry
 * speaks for all of them: unticking a folder was undone on the spot, silently.
 */
test('a repository containing other repositories does not drag them with it', () => {
  const nested = ['/Users/me', '/Users/me/work/foo', '/Users/me/other/baz']

  const offWork = toggleSelection('/Users/me/work', false, nested, [])
  assert.deepEqual(offWork, ['/Users/me/work/foo'])
  assert.equal(isPathIncluded('/Users/me', offWork), true, 'the containing repo stays on the map')
  assert.equal(isPathIncluded('/Users/me/other/baz', offWork), true)

  // And the reverse: switching off the outer repository leaves the ones inside it alone.
  const offHome = toggleSelection('/Users/me', false, ['/Users/me'], [])
  assert.deepEqual(offHome, ['/Users/me'])
  assert.equal(isPathIncluded('/Users/me/work/foo', offHome), true)
})

test('unticking the root and reticking a branch leaves the rest off', () => {
  const nested = ['/Users/me', '/Users/me/work/foo', '/Users/me/other/baz']
  let excluded = toggleSelection('/Users/me', false, nested, [])
  assert.equal(excluded.length, 3, 'the root row stands for every repository beneath it')

  excluded = toggleSelection('/Users/me/work/foo', true, nested, excluded)
  assert.deepEqual(excluded, ['/Users/me', '/Users/me/other/baz'])
  assert.equal(selectionState('/Users/me', nested, excluded), 'mixed')
})

test('repoPathsFromThreads prefers projectPath and falls back to cwd', () => {
  assert.deepEqual(
    repoPathsFromThreads([
      { projectPath: '/Users/me/a' },
      { cwd: '/Users/me/b' },
      { projectPath: '/Users/me/a' },
    ]),
    ['/Users/me/a', '/Users/me/b']
  )
})

test('disparate roots do not hang, and still come back as a tree', () => {
  const paths = ['/Users/me/a/foo', '/Volumes/Ext/bar/baz']
  assert.deepEqual(buildScanTree(paths).roots, ['/Users', '/Volumes'])
  assert.deepEqual(buildDisplayTree(paths).map((n) => n.path), paths)
})

/**
 * One project somewhere unusual used to flatten the whole panel: with `/` as the only shared
 * ancestor there was no anchor to hang a tree on, and every project rendered as its own root.
 */
test('one project off on its own does not flatten the rest into a list', () => {
  const paths = [
    '/private/tmp/scratch',
    '/Users/me/Development/Projects/acme/site',
    '/Users/me/Development/Projects/acme/api',
  ]
  const tree = buildDisplayTree(paths)
  assert.deepEqual(tree.map((n) => n.path), [
    '/private/tmp/scratch',
    '/Users/me/Development/Projects/acme',
  ])
  const acme = tree[1]
  assert.deepEqual(acme.children.map((c) => c.label), ['api', 'site'])
})

test('buildScanTree groups repos under their parent folders', () => {
  const { nodes, roots } = buildScanTree(['/Users/me/work/foo', '/Users/me/other/baz'])
  assert.deepEqual(roots, ['/Users'])
  assert.deepEqual(nodes.get('/Users/me/work/foo').repos, ['/Users/me/work/foo'])
  assert.ok(nodes.get('/Users/me').subdirs.has('/Users/me/work'))
})

test('a single-child chain is drawn as one row carrying the deepest path', () => {
  const [root] = buildDisplayTree(['/Users/me/Development/Projects/acme/site'])
  assert.equal(root.path, '/Users/me/Development/Projects/acme/site')
  assert.equal(root.children.length, 0)
  assert.equal(root.isRepo, true)
})

test('the display tree branches where the folders actually branch', () => {
  const [root] = buildDisplayTree([
    '/Users/me/Development/Projects/acme/site',
    '/Users/me/Development/Projects/acme/api',
    '/Users/me/Development/Projects/other/tool',
  ])
  assert.equal(root.path, '/Users/me/Development/Projects')
  assert.deepEqual(root.children.map((c) => c.label), ['acme', 'other/tool'])
  assert.deepEqual(root.children[0].children.map((c) => c.label), ['api', 'site'])
  // `other` has one child, so the two names fold into a single row.
  assert.equal(root.children[1].label, 'other/tool')
  assert.equal(root.children[1].path, '/Users/me/Development/Projects/other/tool')
})

test('toggling a folded row affects exactly the repos it stands for', () => {
  const repos = [
    '/Users/me/Development/Projects/acme/site',
    '/Users/me/Development/Projects/other/tool',
  ]
  const [root] = buildDisplayTree(repos)
  const folded = root.children.find((c) => c.label === 'other/tool')
  const next = toggleSelection(folded.path, false, repos, [])
  assert.deepEqual(next, ['/Users/me/Development/Projects/other/tool'])
})

test('ticking everything back on empties the list rather than listing it', () => {
  let excluded = toggleSelection('/Users/me', false, REPOS, [])
  assert.equal(excluded.length, REPOS.length)
  excluded = toggleSelection('/Users/me', true, REPOS, excluded)
  assert.deepEqual(excluded, [])
})
