/**
 * The bookkeeping around a battle: who may be attacked, which friend is attacking us, and that a
 * result is counted once and only once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MARCH_MS, planBattle } from '../src/game/war.js'
import {
  FUTURE_SLACK_MS, SEEN_CAP, attackBlocker, bannerPhase, clock, formatRecord, friendFighters, incomingBattle,
  recordResult, resultText,
} from '../src/game/war-page.js'

const ready = {
  secure: true, enabled: true, sharing: true, name: 'Mark', busy: false, homeFighters: 3, friendFighters: 2,
  result: { status: 'online', snapshot: { warReady: true } },
}

test('attack is on only when every condition holds', () => {
  assert.equal(attackBlocker(ready), '')
  assert.match(attackBlocker({ ...ready, secure: false }), /localhost/)
  assert.match(attackBlocker({ ...ready, enabled: false }), /war mode/)
  assert.match(attackBlocker({ ...ready, sharing: false }), /sharing/)
  assert.match(attackBlocker({ ...ready, result: { status: 'away', snapshot: { warReady: true } } }), /not here/)
  assert.match(attackBlocker({ ...ready, result: undefined }), /not here/)
  assert.match(attackBlocker({ ...ready, result: { status: 'online', snapshot: {} } }), /has not turned on/)
  assert.match(attackBlocker({ ...ready, busy: true }), /already on/)
  assert.match(attackBlocker({ ...ready, homeFighters: 0 }), /None of your bots/)
  assert.match(attackBlocker({ ...ready, friendFighters: 0 }), /None of Mark/)
})

test("a friend's fighters are the threads with nothing to say", () => {
  const now = Date.now()
  const t = (over) => ({ running: false, unread: false, hasError: false, prState: '', lastActivityAt: now - 1000, ...over })
  assert.equal(friendFighters([t(), t({ running: true }), t({ unread: true }), t({ lastActivityAt: 0 }), t({ hasError: true })], now), 2)
  assert.equal(friendFighters(undefined, now), 0)
})

const battle = (over = {}) => ({ id: 'war_a', target: 'aaaaaaaaaaaaaaaa', seed: 5, startedAt: 1_000_000, attackers: 4, defenders: 3, ...over })

test('only a battle aimed at our tag is incoming', () => {
  const now = 1_000_000 + 5000
  const friends = [
    { id: 'nb_1', name: 'Mark', battle: battle({ target: 'bbbbbbbbbbbbbbbb' }) },
    { id: 'nb_2', name: 'Sue', battle: battle() },
    { id: 'nb_3', name: 'Al', battle: null },
  ]
  assert.deepEqual(incomingBattle(friends, 'aaaaaaaaaaaaaaaa', now), { neighborId: 'nb_2', name: 'Sue', battle: friends[1].battle })
  assert.equal(incomingBattle(friends, 'cccccccccccccccc', now), null)
  assert.equal(incomingBattle(friends, null, now), null)
})

test('an incoming battle that is long over, or a minute in the future, is ignored', () => {
  const b = battle()
  const end = b.startedAt + planBattle(b).durationMs + 30000
  assert.equal(incomingBattle([{ id: 'nb_1', battle: b }], b.target, end + 1), null)
  const far = battle({ startedAt: 2_000_000 })
  assert.equal(incomingBattle([{ id: 'nb_1', battle: far }], far.target, far.startedAt - FUTURE_SLACK_MS - 1), null)
  assert.ok(incomingBattle([{ id: 'nb_1', battle: far }], far.target, far.startedAt - FUTURE_SLACK_MS + 1000))
})

test('the battle being shown keeps its place; otherwise the earliest wins', () => {
  const now = 1_000_000 + 5000
  const friends = [
    { id: 'nb_1', battle: battle({ id: 'war_late', startedAt: 1_002_000 }) },
    { id: 'nb_2', battle: battle({ id: 'war_early', startedAt: 1_000_000 }) },
  ]
  assert.equal(incomingBattle(friends, 'aaaaaaaaaaaaaaaa', now).battle.id, 'war_early')
  assert.equal(incomingBattle(friends, 'aaaaaaaaaaaaaaaa', now, 'war_late').battle.id, 'war_late')
})

test('a result is counted once, from the side we were on', () => {
  const b = battle()
  const plan = planBattle(b)
  const war = { enabled: true, battle: b, tally: { nb_1: { won: 2, lost: 1 } }, seen: ['war_old'] }
  const side = plan.winner
  const r = recordResult(war, { battle: b, side, neighborId: 'nb_1' }, plan)
  assert.equal(r.won, true)
  assert.deepEqual(r.war.tally.nb_1, { won: 3, lost: 1 })
  assert.deepEqual(r.war.seen, ['war_a', 'war_old'])
  assert.equal(r.mine, plan.score[side])
  assert.equal(recordResult(r.war, { battle: b, side, neighborId: 'nb_1' }, plan), null)

  const lost = recordResult({ seen: [] }, { battle: b, side: side === 'attack' ? 'defend' : 'attack', neighborId: 'nb_9' }, plan)
  assert.equal(lost.won, false)
  assert.deepEqual(lost.war.tally.nb_9, { won: 0, lost: 1 })
})

test('seen ids are capped, newest kept', () => {
  const b = battle()
  const seen = Array.from({ length: SEEN_CAP }, (_, i) => `war_${i}`)
  const r = recordResult({ seen }, { battle: b, side: 'attack', neighborId: 'nb_1' }, planBattle(b))
  assert.equal(r.war.seen.length, SEEN_CAP)
  assert.equal(r.war.seen[0], 'war_a')
  assert.ok(!r.war.seen.includes(`war_${SEEN_CAP - 1}`))
})

test('the words: result, record, clock, banner', () => {
  assert.equal(resultText('Mark', { won: true, mine: 7, theirs: 4 }), 'You beat Mark 7–4')
  assert.equal(resultText('Mark', { won: false, mine: 2, theirs: 5 }), 'Mark won 5–2')
  assert.equal(formatRecord({ won: 3, lost: 1 }), '3–1')
  assert.equal(formatRecord({ won: 0, lost: 0 }), '')
  assert.equal(formatRecord(undefined), '')
  assert.equal(clock(42_900), '0:42')
  assert.equal(clock(61_000), '1:01')
  const b = battle()
  const plan = planBattle(b)
  assert.equal(bannerPhase(plan, b.startedAt, b.startedAt - 10).label, 'marching')
  assert.equal(bannerPhase(plan, b.startedAt, b.startedAt + 100).label, 'marching')
  assert.equal(bannerPhase(plan, b.startedAt, b.startedAt + MARCH_MS + 12_000).label, '0:12')
  assert.equal(bannerPhase(plan, b.startedAt, b.startedAt + plan.durationMs - 100).label, 'final')
  assert.equal(bannerPhase(plan, b.startedAt, b.startedAt + plan.durationMs), null)
})
