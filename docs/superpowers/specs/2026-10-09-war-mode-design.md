# War mode — idle bots fight a friend's idle bots

**Status:** approach approved (A: same rules on both screens, shared starting numbers); details
decided by the implementer at the user's request to build quickly — see "Decisions".
**Date:** 2026-10-09
**Builds on:** `2026-10-09-neighbors-design.md` (neighbors must be landed).

## What this is

With war mode on, you can pick a neighbour and attack. Your idle bots pick up swords and guns,
a tank or helicopter or two rolls out, they march across the gap and fight the neighbour's idle
bots, who defend. Knocked-out bots flop over; the side with more standing when the fight ends
wins; the winners cheer; everyone walks home. A win/loss tally per friend is kept.

Both screens show the same battle: the same winner, the same score, the same pacing.

## The rules that cannot bend

- **Only idle and sleeping bots fight.** A bot that is working, waiting on you, blocked or
  celebrating is never conscripted. A fighter whose thread wakes up mid-battle drops its weapon
  and goes straight back to its job. War mode never hides real activity.
- **Nothing about a thread changes.** No archive, no hide, no building damage. A battle is a
  show on top of the colony.
- **The share port stays read-only.** An attack is announced *in the attacker's own snapshot*;
  the defender learns of it by reading that snapshot, which it already polls every 5 s.
- **Consent.** War mode is off by default. You can only attack a friend whose snapshot says war
  mode is on (`warReady`).

## How both screens agree (approach A)

1. Attacker presses **Attack** on a neighbour. The page writes `state.war.battle`:
   `{ id, target, seed, startedAt, attackers, defenders, targetNeighborId }`.
   - `target` = first 16 hex of `sha256('war:' + battleId + ':' + defenderShareKey)`. Only the
     defender's machine (which knows its own key) recognises itself, hashing its key once per
     announced battle id; friends who do not hold the defender's link cannot tell who is being
     attacked. Salting with the battle id makes the tag new every battle, so a friend who does
     hold that link cannot hash it once and spot every later attack on that person.
   - `attackers` / `defenders` = how many idle bots each side has at that moment, from the
     attacker's view, each capped at 30. Both must be ≥ 1.
   - `targetNeighborId` is local only and never shared.
2. The attacker's server includes `warReady` and `battle` (without `targetNeighborId`) in its
   snapshot while the battle is live (until 30 s after it ends). The defender, on adopting the
   battle, saves `war.busyUntil` (that battle's end + 30 s); its snapshot publishes the bare
   boolean `warBusy` until then, so a third friend sees it as busy without learning who attacked.
3. Every screen involved runs the same pure `planBattle({ seed, attackers, defenders })`, which
   returns the knockout timeline, the vehicles, the winner and the score. Each screen plays that
   timeline with the bots it can see. Exact bot-for-bot choreography may differ between screens;
   winner, score and timing do not.
4. The defender's screen shows the battle only if the defender has added the attacker as a
   neighbour (otherwise it cannot read the attacker's snapshot). The attacker's screen shows it
   either way.

## The battle

- **Phases:** march 8 s → fight up to 60 s (ends early when a side is wiped out) → cheer 6 s.
- **Sides:** the attacker's fighters march from their colony to a battle point just outside the
  defender's colony, on the line between the two; defenders form up between that point and
  their own zones.
- **Arsenal**, all built in code from simple shapes in the colony's toy style:
  - odd-numbered fighters carry a **sword** (swing = the existing hammering clip),
  - even-numbered fighters carry a **gun** (an aiming pose made with the bake-time pose
    tweaks, muzzle flashes and tracers from the particle system),
  - **tanks**: one per 8 fighters on a side, max 3 — drive up and fire shells,
  - **helicopters**: one per 12 fighters on a side, max 3 — circle overhead and fire.
- **Knockouts** follow the plan's timeline: the bot plays its hit clip, tumbles over and stays
  down until the cheer ends, then walks home.
- **Result:** more fighters standing wins; a tie goes to the defender. Score = knockouts each
  side inflicted.
- **Tally:** each screen records the result once per battle id in `state.war.tally[neighborId]`
  (`{ won, lost }`) and shows it on the neighbour's ship sign (`Mark · 3–1`) and Settings row.

## UI

- **Settings → Neighbors → War mode** toggle (off by default). Published as `warReady`.
- **Attack** button on each neighbour row in the sidebar. Enabled only when: war mode is on,
  the friend is online and war-ready, both sides have an idle bot, no battle involving you is
  live, and the friend's snapshot shows neither a live `battle` of theirs nor `warBusy`.
- **Battle banner** at the top while a battle is live: `You ⚔ Mark · 3 : 1 · 0:42` (attacker
  first), or `Mark attacks! …` on the defender's screen.
- A toast with the result when it ends.

## Data

- `colony.json` gains `war: { enabled, battle, tally, seen, busyUntil }` — `seen` is the last 50
  battle ids already tallied; `busyUntil` (ms, 0 at peace) is when the battle we are defending
  stops lingering. Merged whole across tabs.
- Snapshot gains optional `warReady: boolean`, `warBusy: boolean` (`now < busyUntil`) and
  `battle: { id, target, seed, startedAt, attackers, defenders } | null`. Version stays `v: 1`: the
  fields are additive and an older validator drops them.
- `validateSnapshot` checks them strictly: `warReady` and `warBusy` only as a real `true`; id
  `/^war_[0-9a-z_]{1,40}$/`, target 16 hex, seed an integer in 0..2³²−1, `startedAt` finite,
  fighter counts integers 1..30; anything else → no battle.

## Decisions (made for speed; each is cheap to change)

- Fighters capped at 30 a side so a busy colony does not field 200 bots.
- Swords and guns alternate by index rather than being chosen — predictable and fair.
- Knockout rate per 1 s tick for a side = `0.6 × enemyPower / (ownPower + enemyPower)`, where
  power = fighters standing + 3 per tank + 2 per helicopter.
- One live battle per person at a time, attacking or defending.
- An incoming battle is read off a friend's snapshot, so the defender does not take it on trust:
  the battle on screen keeps the numbers it was first seen with (the same id with a new seed,
  start or head count is ignored); an id already in `seen` is not shown again; a friend's battle
  that starts before their last one on us ended is ignored (kept in memory), so a finished battle
  re-announced under fresh ids is one loss, not one per poll; and a battle with a friend who has
  been removed is called off without a tally entry or a toast.
- Clocks: `startedAt` is the attacker's clock; LAN machines are NTP-synced to within a second,
  which is good enough for a 60 s show.

## Out of scope

- Live, frame-by-frame sync between screens.
- Battles between more than two colonies at once.
- Anything that changes a thread, a building or a zone.
