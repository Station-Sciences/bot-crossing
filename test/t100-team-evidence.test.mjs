import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { JOIN_SCHEMA, loadTeamEvidence, normalizeJoin } from '../server/t100/team-evidence.mjs'

test('work join rejects bare numbers and reports one item mapped to multiple targets', () => {
  const join = normalizeJoin({
    github: [
      { repo: 'neurophos/models', number: 42, targets: ['t100.eic.bar0.vpu'] },
      { repo: 'neurophos/models', number: 42, targets: ['gate_tests'] },
      { number: 9, targets: ['t100.eic.bar0.dfe'] },
    ],
    jira: [{ key: 'T100-7', targets: ['t100.eic.bar0.dfe'] }],
  })
  assert.equal(join.schemaVersion, JOIN_SCHEMA)
  assert.equal(join.github.length, 2)
  assert.equal(join.jira.length, 1)
  assert.deepEqual(join.conflicts[0].targets, ['t100.eic.bar0.vpu', 'gate_tests'])
})

test('disabled team adapters make no network requests', async () => {
  let calls = 0
  const team = await loadTeamEvidence(
    {
      joinFile: '',
      github: { enabled: false, api: 'https://api.github.test', token: '' },
      jira: { enabled: false, url: '', email: '', token: '' },
    },
    { fetchImpl: async () => { calls += 1 } },
  )
  assert.equal(calls, 0)
  assert.deepEqual(team.items, [])
  assert.equal(team.provenance.github.enabled, false)
})

test('enabled adapters fetch only explicitly joined ids and normalize safe metadata', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 't100-team-'))
  try {
    const joinFile = path.join(dir, 'work-join.json')
    await fsp.writeFile(
      joinFile,
      JSON.stringify({
        github: [{ repo: 'neurophos/models', number: 42, targets: ['t100.eic.bar0.vpu'] }],
        jira: [{ key: 'T100-7', targets: ['t100.eic.bar0.dfe'] }],
      }),
    )
    const urls = []
    const fetchImpl = async (url, options) => {
      urls.push({ url, options })
      if (url.includes('api.github.test')) {
        return new Response(JSON.stringify({
          title: 'VPU reset',
          state: 'open',
          user: { login: 'greg' },
          updated_at: '2026-09-12T10:00:00Z',
          html_url: 'https://github.test/neurophos/models/pull/42',
          pull_request: {},
        }), { status: 200, headers: { etag: '"g1"' } })
      }
      return new Response(JSON.stringify({
        fields: {
          summary: 'DFE bring-up',
          status: { name: 'In Progress' },
          assignee: { displayName: 'Khalil' },
          issuetype: { name: 'Story' },
          updated: '2026-09-12T11:00:00Z',
        },
      }), { status: 200, headers: { etag: '"j1"' } })
    }
    const team = await loadTeamEvidence(
      {
        joinFile,
        github: { enabled: true, api: 'https://api.github.test', token: 'secret' },
        jira: { enabled: true, url: 'https://jira.test', email: 'me@test', token: 'secret' },
      },
      { fetchImpl },
    )
    assert.equal(urls.length, 2)
    assert.ok(urls.every((call) => call.options.method === 'GET'))
    assert.equal(team.items[0].id, 'neurophos/models#42')
    assert.equal(team.items[1].id, 'T100-7')
    assert.ok(!JSON.stringify(team).includes('secret'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
