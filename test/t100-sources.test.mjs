import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getWorld, getLayout, getEvents, invalidateCache } from '../server/t100/sources.mjs'
import { resolveConfig } from '../server/t100/config.mjs'

// Force the fixture path: point every source at a directory that does not exist,
// so the loader must fall back to the bundled snapshot and mark it as such.
const fixtureEnv = {
  T100_MODELS_REPO: '/nonexistent/models',
  T100_PYTHON: '/nonexistent/python3',
  T100_LAYOUT: '/nonexistent/instances.json',
  T100_OVERLAY: '/nonexistent/overlay.json',
  T100_WEEKLY: '/nonexistent/weekly.jsonl',
  T100_EVIDENCE_DIR: '/nonexistent/evidence',
  NPH_ROOT: '/nonexistent',
}

test('resolveConfig: honours env overrides', () => {
  const cfg = resolveConfig(fixtureEnv)
  assert.equal(cfg.modelsRepo, '/nonexistent/models')
  assert.equal(cfg.layout, '/nonexistent/instances.json')
})

test('getWorld: falls back to the bundled snapshot when no live source exists', async () => {
  invalidateCache()
  const w = await getWorld({ force: true, env: fixtureEnv })
  assert.equal(w.schemaVersion, 't100.world/v1')
  assert.ok(w.units.length >= 46)
  assert.equal(w.rungs.length, 28)
  // Provenance must be honest that this is a fixture, not live silicon truth.
  assert.equal(w.provenance.layout.source, 'fixture')
  assert.equal(w.provenance.manifest.source, 'fixture')
  // The chip stays honestly illustrative.
  assert.match(w.placement.accuracy, /illustrative/i)
})

test('getWorld: caches within the TTL and rebuilds on force', async () => {
  invalidateCache()
  const a = await getWorld({ force: true, env: fixtureEnv })
  const b = await getWorld({ env: fixtureEnv })
  assert.equal(a.generatedAt, b.generatedAt, 'served from cache within TTL')
})

test('getLayout: returns the floorplan instances', async () => {
  const layout = await getLayout({ env: fixtureEnv })
  assert.ok(Array.isArray(layout.instances))
  assert.ok(layout.instances.length > 600)
})

test('getEvents: parses the illustrative replay streams', async () => {
  const synthetic = await getEvents('synthetic')
  const golden = await getEvents('golden')
  assert.ok(synthetic.length > 0)
  assert.ok(golden.length > 0)
  await assert.rejects(() => getEvents('nope'))
})
