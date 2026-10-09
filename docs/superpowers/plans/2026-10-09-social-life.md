# Bot social life — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Idle bots chat, gather in groups, argue, comfort a heartbroken friend and play together — some at random, some set off by real thread events — without ever disguising what a thread is doing.

**Architecture:** A pure social planner (`src/game/social.js`) turns the idle roster, recent events and the clock into scenes, each a per-participant timeline of goal / facing / action / emote / expression. A social director in the colony feeds it events, applies the current step through a generalised order layer in the bot renderer, draws emote bubbles through a new instanced layer, and drives a code-built ball for play.

**Tech Stack:** three.js, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-social-life-design.md`

## Global Constraints

- Only `idle` bots take part; never `sleeping`, `working`, `waiting`, `blocked`, `celebrating`. A participant whose status changes leaves that frame; a scene that loses a participant it needs ends.
- War orders outrank social orders; a bot under war orders is never cast in a scene.
- No social emotion uses a status badge, red eyes, or the `error` face. Anger uses a new `grumpy` face.
- Nothing is written to `colony.json` or the share snapshot.
- Limits: at most `floor(idle / 6)` scenes and never more than 8 at once; scenes last 6–15 s; each bot rests 30–60 s between scenes; participants come from the same zone or within ~15 units; friends' bots socialise within their own settlement.
- Ambient weights: chat 45%, group chat 20%, play 20%, argument 10%, heartbreak 5% (seeded random, so tests are deterministic).
- Setting `socialLife`, default `true`, toggle under View.
- **Commits: the user is the sole author. Do NOT add any `Co-Authored-By` trailer or any Claude attribution to commit messages.**
- Baseline: `npm test` 299 tests, 287 pass, 2 fail (pre-existing Windows-only: "a running subagent is reported with the brief…", "asked for a terminal on Windows…"), 10 skipped. Only those two may fail. `npx vite build` must succeed.
- Style: no semicolons, single quotes, 2-space indent, comments explain why; keep line endings; no markdown fences in source.

---

### Task 1: The social planner (pure)

**Files:** Create `src/game/social.js`, `test/social.test.mjs`.

**Requirements:**
- `planSocial({ now, bots, events, active, rand })` → `{ start: Scene[], end: sceneId[] }` (or a stateful `SocialPlanner` class with a pure `tick(input)` — implementer's choice, but every rule must be node-testable with a seeded `rand`).
  - `bots`: `[{ id, status, pos: {x,z}, zone, owner /* 'home' | neighbor id */, atWar: boolean, restUntil }]`.
  - `events`: `[{ kind: 'archived', zone, owner } | { kind: 'finished', id } | { kind: 'warResult', owner, won: boolean }]`.
- `Scene = { id, kind: 'chat'|'group'|'argue'|'heartbreak'|'play', cast: [ids], startedAt, durationMs, steps(t) → per-cast { goal, face, action, emote, expression } }`. Actions are from a fixed vocabulary the bot layer understands: `walk`, `talk`, `wave`, `stomp`, `sit`, `stand`, `cheer`, `jump`, `run`, `kick`. Emotes: `chat`, `angry`, `heartbreak`, `sad`, `love`, `ball`, `music`, or null. Expressions: `happy`, `wink`, `grumpy`, `sad`, `love`, `cheer`, or null.
- Enforce every Global Constraint on eligibility, limits, cooldowns, proximity, ambient weights, war precedence, and event triggers (heartbreak + nearest comforter; finished → play with a repo-mate; war result → losers argue, winners play, for 60 s).
- `stillValid(scene, bots)` → false when a participant the scene needs is no longer eligible.
- Tests: one per rule above, plus determinism with a seeded `rand`.

Commit: `Plan idle bots' social scenes`.

### Task 2: Bubbles, a grumpy face, and a ball

**Files:** Create `src/agents/emotes.js` (+ `test/emotes.test.mjs` for any pure layout helper); modify `src/agents/faces.js` (new `grumpy` expression drawn as a mask like the others); add `createBall()` to `src/world/arsenal.js` (+ test).

**Requirements:**
- `Emotes` — one instanced billboard mesh sharing a single atlas drawn from paths (match how `src/agents/indicators.js` draws and billboards status badges, including bending with `withCurve` if it uses a custom shader). Icons: speech bubble (chat), anger mark (angry), broken heart (heartbreak), teardrop (sad), heart (love), ball (ball), note (music). Smaller than status badges, offset to the side of the head, a gentle pop-in/out. API: `update(agents, elapsed, emoteFor(agent))`.
- `grumpy` face: furrowed brows / flat mouth, clearly not the `error` X face.
- `createBall()` — a small code-built ball (≈0.35 diameter) in the toy style.

Commit: `Emote bubbles, a grumpy face and a ball`.

### Task 3: Bots that act out scenes

**Files:** Modify `src/agents/astronauts.js`, `src/agents/war-orders.js` (or a new `src/agents/orders.js` that both use).

**Requirements:**
- Generalise the order layer: social orders (`setSceneOrders(id, step | null)`) alongside war orders. War orders take precedence; a bot with war orders ignores scene orders. Social orders are accepted only for `idle` bots in `at-site`/`walking` states (stricter than war: no `sleeping`), re-checked every frame exactly like war orders.
- Implement each action with existing clips and pose tweaks (walk/run; `talk` = an idle variant with a small gesture; `wave`; `stomp` = a short indignant hop or arm-down tweak — not the `Hit_A` stagger, which reads as being hit; `sit` / `stand` via the existing sit clips; `cheer`; `jump`; `kick` = a quick leg/forward-lean using the run or jump clip). Facing a point; expression override from the step; the per-agent emote id exposed for the Emotes layer.
- Never alter behaviour for bots without orders.

Commit: `Bots that act out social scenes`.

### Task 4: The social director

**Files:** Create `src/game/social-director.js` (pure helpers node-tested in `test/social-director.test.mjs`); modify `src/game/colony.js`, `src/core/settings.js` (`socialLife: true`), `src/ui/hud.js` (View toggle *Bot social life* with a one-line hint), `src/main.js` (feed war results).

**Requirements:**
- Each frame (or a few times a second) build the planner input from `colony.astronauts.agents`, zones (plot of each bot), owner, war state; collect events: archived threads (home: threads leaving `colony.threads` that were archived or disappeared; friends: threads disappearing from a neighbour's set), `working`→`idle` transitions, and war results (from main.js's result handling).
- Apply each live scene's current step via `setSceneOrders`; clear orders when a scene ends or a participant drops; feed emotes to the Emotes layer; spawn/move/dispose a ball for `play` (kicked between players on arcs that bounce, using `colony.groundAt`).
- Honour `socialLife` off: clear everything and do nothing.
- Never write threads, buildings, plots or saved state.

Verification: `npm test`, `npx vite build`, and a browser check on your OWN dev server with a throwaway data dir, driven with Playwright: watch ambient scenes occur; force each scene kind from the console (expose a small dev hook) and screenshot chat, group, argue, heartbreak+comfort and play; make a participant busy mid-scene and see it leave.

Commit: `A social director for idle bots`.

### Task 5: Docs

README: a short **Social life** subsection (what the scenes are, what sets them off, that only idle bots take part and nothing is shared, the View toggle). Commit: `Document bot social life`.
