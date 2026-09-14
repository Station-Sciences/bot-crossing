import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseGitHubUrl, parseGitRepo, matchThreadPR } from '../server/lib/github.mjs'
import { statusFor } from '../src/game/colony.js'

test('parseGitHubUrl parses HTTPS, SSH, and git URLs accurately', () => {
  const https = parseGitHubUrl('https://github.com/ERP-ETIRA/erp-backend.git')
  assert.equal(https?.owner, 'ERP-ETIRA')
  assert.equal(https?.repo, 'erp-backend')

  const ssh = parseGitHubUrl('git@github.com:Station-Sciences/bot-crossing.git')
  assert.equal(ssh?.owner, 'Station-Sciences')
  assert.equal(ssh?.repo, 'bot-crossing')

  const noExt = parseGitHubUrl('https://github.com/rayasya/bot-crossing')
  assert.equal(noExt?.owner, 'rayasya')
  assert.equal(noExt?.repo, 'bot-crossing')

  assert.equal(parseGitHubUrl('https://gitlab.com/some/repo.git'), null)
  assert.equal(parseGitHubUrl(''), null)
  assert.equal(parseGitHubUrl(null), null)
})

test('matchThreadPR matches feature branch directly', () => {
  const thread = {
    gitBranch: 'feat/audio-engine',
    title: 'Add terra breeze ambient sounds',
    lastActivityAt: 1700000000000,
  }

  const prs = [
    {
      number: 42,
      title: 'feat: add terra breeze ambient sounds',
      state: 'open',
      merged: false,
      headRef: 'feat/audio-engine',
    },
    {
      number: 40,
      title: 'other pr',
      state: 'closed',
      merged: true,
      headRef: 'fix/something',
    },
  ]

  const matched = matchThreadPR(thread, prs)
  assert.ok(matched)
  assert.equal(matched.number, 42)
  assert.equal(matched.headRef, 'feat/audio-engine')
})

test('matchThreadPR matches generic master/main branch via keyword & time closeness', () => {
  const thread = {
    gitBranch: 'master',
    title: 'kenapa aku tidak bisa menggunakan params status dan mencari "Menunggu Pembagian"',
    preview: 'Active Document: app/Enums/SalesOrderStatus.php',
    lastActivityAt: 1789093676000,
  }

  const prs = [
    {
      number: 358,
      title: 'feat: add allocation permissions to SalesPermissionSeeder',
      state: 'closed',
      merged: true,
      mergedAt: 1789093717000,
      headRef: 'master',
    },
    {
      number: 200,
      title: 'fix: old database migration',
      state: 'closed',
      merged: true,
      mergedAt: 1500000000000,
      headRef: 'master',
    },
  ]

  const matched = matchThreadPR(thread, prs)
  assert.ok(matched)
  assert.equal(matched.number, 358)
  assert.equal(matched.merged, true)
})

test('matchThreadPR rejects a PR that was already merged before the thread started', () => {
  const newThread = {
    gitBranch: 'master',
    title: 'Data pelanggan berhasil diambil',
    createdAt: 1789366376000,
    lastActivityAt: 1789366635000,
  }
  const oldMergedPr = {
    number: 360,
    title: 'Add reject_notes to SalesOrder and enhance Partner model with dynamic codes',
    state: 'closed',
    merged: true,
    mergedAt: 1789360881000, // Merged ~1.5 hours earlier!
    createdAt: 1789360872000,
    headRef: 'master',
  }
  const matched = matchThreadPR(newThread, [oldMergedPr])
  assert.equal(matched, null)
})

test('colony statusFor treats prState: merged as celebrating regardless of case', () => {
  assert.equal(statusFor({ prState: 'merged' }), 'celebrating')
  assert.equal(statusFor({ prState: 'MERGED' }), 'celebrating')
  assert.equal(statusFor({ prState: 'Merged' }), 'celebrating')
  assert.equal(statusFor({ prState: 'open' }), 'idle')
})
