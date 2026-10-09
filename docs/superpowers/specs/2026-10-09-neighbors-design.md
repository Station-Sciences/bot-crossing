# Neighbors — seeing your friends' colonies next to your own

**Status:** design approved, not yet planned
**Date:** 2026-10-09

## What this is

People on the same Wi-Fi each run Bot Crossing on their own machine. A person can turn on
**sharing**, hand out a link, and anyone who adds that link sees their colony as a **neighbor
settlement** beside their own: plots, buildings, bots doing what their threads are doing. It
costs nothing and needs nothing beyond the app that already runs on each machine — no account,
no hosted server, no third-party relay.

Friends see the *shape and status* of a colony, never its contents. No thread title, prompt,
path, branch or model leaves the machine.

## Decisions taken while designing

| Question | Answer |
| --- | --- |
| How machines reach each other | Directly, app to app, over the local network |
| Network | Same Wi-Fi / office. No tunnel, no relay |
| What a friend sees | Repo names, footprint, accent, bot state, building size. Nothing else |
| Repo names | Shared. Acceptable on a shared office network |
| Consent model | One-way share keys: one key per sharer, given to anyone; rotating it cuts everyone off |
| Where a friend appears | A separate settlement a short gap away from yours, with its own ship and sign |

## Architecture

```
  your browser ──/api/neighbors──▶ your server ──GET /share/v1/colony──▶ friend's share port (5275)
       │                               │                                        │
       └──/api/threads, /api/state─────┘                         friend's server builds a
                                                                 redacted snapshot from its scan
```

Three pieces, each with one job:

1. **The share port** (`server/share.mjs`) — a second HTTP listener that exists only while
   sharing is on and answers exactly one request.
2. **The neighbor fetcher** (`server/neighbors.mjs`) — your server polling your friends' share
   ports, validating what comes back, and keeping the last good copy of each.
3. **Neighbor plots in the one `Colony`** — a friend's zones, buildings, ship and bots live in
   the existing `Colony`, tagged with their owner and placed on the same global hex lattice as
   yours. Everything that is *about the ground* (decks, ground height, scatter, grass, island
   shapes, navigation) iterates all plots; everything that is *about your threads* (layout save,
   drag, hide, dormant fold, stats, sidebar repos) keeps iterating only your own.

The page never talks to another machine. It asks its own server, through the same local-only
guard (`isLocalRequest`, `server/api.mjs`) as everything else, so no CORS and no new attack
surface on `/api/*`.

## 1. The share port

### Turning it on

**Settings → Neighbors → Share my colony**, off by default. Turning it on:

- generates a 128-bit key in the browser (`crypto.getRandomValues`, hex-encoded),
- stores it in `data/colony.json` under `sharing`,
- shows a link to copy: `http://<lan-ip>:5275/#k=<key>`. The browser cannot discover the
  machine's LAN address, so a new local endpoint, `GET /api/sharing`, returns
  `{ lanAddress, port, listening, error, defaultName }` — the address being the first
  non-internal IPv4 from `os.networkInterfaces()`, and `defaultName` the OS username.

**Rotate key** generates a new key; the old one stops working on the next request.

A **display name** field sits beside the toggle. Defaults to the OS username; it is what
friends see on your sign.

### The listener

- Started by the server after any `PUT /api/state` that leaves `sharing.enabled` true, and on
  boot if the saved state says so. Closed when a save turns it off.
- Binds `0.0.0.0:5275` by default. `BOT_CROSSING_SHARE_HOST` and `BOT_CROSSING_SHARE_PORT`
  override.
- Started from both entry points: `server/serve.mjs` and the Vite plugin in `vite.config.js`
  (`configureServer`), so `npm run dev` shares too. One module owns the listener; both call it.
- Answers `GET /share/v1/colony` with header `Authorization: Bearer <key>`. Key compared with
  `crypto.timingSafeEqual` on equal-length buffers.
- Every other method or path: 404. Missing or wrong key: 401. No route on this listener can
  reach the local API — it is a separate `http.Server` with its own handler, not the API
  middleware with a different guard.
- Rate limit: 30 requests per minute per remote address, then 429. In-memory, no persistence.
- Port in use (`EADDRINUSE`): sharing stays enabled in the file but the server reports
  `{ listening: false, error }` through `GET /api/sharing`, and Settings shows it.

### What it returns

```json
{
  "v": 1,
  "name": "Mark",
  "generatedAt": 1791234567000,
  "projects": [
    { "name": "bot-crossing", "cells": [[0,0],[1,0]] }
  ],
  "threads": [
    {
      "id": "n:3f9a…",
      "project": "bot-crossing",
      "harness": "claude-code",
      "harnessName": "Claude Code",
      "running": true,
      "unread": false,
      "hasError": false,
      "prState": "",
      "lastActivityAt": 1791234540000,
      "createdAt": 1791230000000,
      "sizeBucket": 7,
      "isErrand": false
    }
  ]
}
```

Rules:

- **Allowlist, not denylist.** `toShared(thread)` builds a new object from named fields. Any
  field added to `Thread` later is private until someone adds it here. This goes into
  `DECISIONS.md`.
- `id` is `n:` + first 16 hex of `sha256(key + ':' + thread.id)`. Stable for as long as the
  key is, unlinkable to the real id, and changes on rotate.
- `lastActivityAt` and `createdAt` are floored to the minute.
- `sizeBucket` is `floor(log2(sizeBytes))`, clamped 0–40. The receiver turns it back into
  `2 ** sizeBucket` bytes so the existing log-scale building progress works unchanged.
- Subagent errands are included as their own entries (`isErrand: true`) after `withErrands`
  expansion, so a friend's busy thread shows its errands as yours would.
- Excluded: archived threads, threads in `hiddenProjects`, and — if the sharer has *Hide
  dormant repos* on — repos with nothing active in three days. A friend sees what you see.
- `projects[].cells` is the sharer's own saved layout (`plots`), so their settlement looks the
  same on every friend's screen as it does on theirs.
- Never included: `title`, `preview`, `projectPath`, `cwd`, `worktree`, `gitBranch`, `model`,
  `ref`, real `id`, transcript path, anything from `settings`.

## 2. Adding a friend, and the fetch

### Storage

`data/colony.json` gains two top-level fields, read and written through the existing
`readState` / `writeState` and the browser's whole-file PUT, keeping the one-writer rule:

```json
"sharing":   { "enabled": false, "key": "", "name": "" },
"neighbors": [ { "id": "nb_1", "url": "http://192.168.1.42:5275", "key": "…", "slot": 0, "addedAt": 0 } ]
```

`mergeState` (`src/game/merge-state.js`) learns both: `sharing` is last-writer-wins as a
unit; `neighbors` merges by `id` like the other keyed collections.

### Adding

**Settings → Neighbors → Add neighbor** takes a pasted share link, splits it into `url` and
`key` (from `#k=`), assigns the lowest free `slot` 0–5, and saves. Six is the cap; the button
disables at six. Each row shows the friend's name (from their snapshot), a status dot,
*last seen …*, and **Remove**.

### The fetch

- New endpoint `GET /api/neighbors` on the local API. For each saved neighbor, in parallel,
  the server calls `GET <url>/share/v1/colony` with a 2-second timeout.
- The page calls it from the existing `poll()` (`src/main.js`, every 15 s), alongside
  `fetchThreads()`, not on a separate clock.
- The server keeps the last good snapshot per neighbor in memory, keyed by neighbor `id`, and
  returns for each: `{ id, status, lastSeenAt, snapshot }`, where `status` is one of
  `online`, `away`, `bad-key`, `needs-update`, `unreachable` (never reached this session).
- Snapshots are not persisted. After a restart a friend who is off shows as `unreachable`
  with no settlement until they are reached once — their *slot* is kept, so they return to
  the same place.

### Validating what comes back

`validateSnapshot(json)` in `server/neighbors.mjs` is the only way a snapshot enters the
system. It:

- requires `v === 1` (else `needs-update`),
- caps `projects` at 200 and `threads` at 500,
- caps every string at 120 characters and strips control characters,
- accepts `prState` only from the known set, coerces booleans and numbers, drops unknown fields,
- drops `cells` that are not integer pairs, caps cells per project at 64.

Anything that fails structurally is treated as the friend being `away` with their previous
snapshot kept.

## 3. Settlements in the world

### Placement

- Six fixed **directions**, one per hex side, indexed by `slot`. A friend's direction never
  changes while they are added.
- Their cells are their own layout translated by an axial offset along that direction. The
  distance is chosen so there are at least **two empty rings** between your footprint's
  outermost cell and theirs, and between neighbors.
- `placeNeighbors(homeCells, neighbors, previousOffsets)` in `src/world/neighbor-layout.js` is a
  pure function and *sticky* like `allocateCells`: an offset is kept while it still leaves the
  gap, and only pushed further out along the same direction when either side has grown into it.
  Offsets are recomputed on each roster, not saved.
- On **Shoreline** (the coast world) only the three landward directions are used; slots map
  onto them in order, and a fourth or later friend on that world is drawn on the landward side
  further out.
- On **Archipelago** and **Aerie** the neighbor's cells are added to the island footprint, so
  each friend gets their own island or floating rock.

### Neighbor plots in the one `Colony`

*Amended while planning.* The first version of this spec extracted a `Settlement` class out of
`Colony`. Reading the code showed that everything which has to work for a neighbor — decked
cells, `groundAt`, scatter and grass clearing, the island footprints, the navigation obstacles
— already iterates plots on one global hex lattice. So a neighbor's plots go into the existing
`Colony`, tagged with their owner, and the home code path is left as it is. Same result on
screen, far less risk to your own colony.

- `Colony` gains `neighborPlots` (Map, keyed `nb:<neighborId>/<repo>`), `neighborShips` (Map
  neighbor id → `{ ship, label }`) and `neighborThreads` (Map thread id → thread). Home `plots`,
  `plotOrder`, `plotCells` and `threads` stay home-only.
- A `worldPlots` list (home plots then neighbor plots) replaces `plotOrder` wherever the
  question is about the ground: `_footprintCells`, `_buildScatter`, `_buildGrass`,
  `_plotFootprint`, `deckedCells`, `_rebuildNavigation`, `_updateLabels`, `_updatePlots`,
  `plotAt`, `pickLabel`.
- Each neighbor `Plot` carries `neighbor: { id, name }`; home plots carry nothing. Hit tests
  return either, and the caller checks.
- Neighbor cells are their own layout plus the placement offset; their ship stands on their
  `SHIP_CELL` plus the same offset, facing their own zones (`Ship` gains a `facing` argument).
- `Navigation` takes its half-width as a constructor argument and gains `resize(half)`; the
  colony sizes it to cover every world plot.
- Terrain flattening (`COLONY_RADIUS` in `src/world/planet.js`) gains a list of extra flat
  discs, one per neighbor, through `setSettlementSites(sites)`. Craters skip them, the far-field
  darkening is measured from the nearest one, and the ground and water planes grow to cover
  the furthest one.
- `WORLD_LIMIT` (`src/core/camera.js`) becomes `rig.setWorldLimit(r)`, set from the furthest
  world plot. `resetView` still goes to your colony.

Hold-to-drag, archive, hide, open and new-session only ever act on home plots and home threads.

### Bots

- One `Astronauts` instance still draws every bot, so all bots stay one draw call.
- Each neighbor roster entry carries `neighbor` and `doors` (its own ship's `shipDoor` /
  `shipAirlock`). Wherever the bot code reads `world.shipDoor` or `world.shipAirlock`, it asks
  the agent's own `doors` first. Ground height and navigation are shared, since the lattice is.
- **Budget:** neighbor bots share the existing cap (`maxAgents`). Ranking puts every home bot
  ahead of every neighbor bot, so friends never push your own bots off the map.
- The "started waiting on you" chime plays only for home bots.

### Interaction

- A neighbor's bot opens a **read-only card**: friend name and repo as the title, state in
  words ("Working", "Waiting on Mark", "Dormant"), harness name, "4m ago". No Open, Viewed or
  Archive, no progress bar. Not draggable.
- Clicking a neighbor's zone shows a hint line (`Mark · bot-crossing · 3 bots`) rather than
  opening the repo sidebar, which is all about actions on your own folders.
- A sign over each neighbor's ship shows their name, and `Mark · away` when they are not
  `online`. The minutes live in the Settings row, not on the sign.
- Sidebar gains a **Neighbors** section listing each friend with their status dot; clicking one
  flies the camera to their settlement.
- `N` (next waiting bot) and `0` (reset view) only consider home.

## 4. Failure handling

| Situation | What happens |
| --- | --- |
| Friend's machine asleep / off Wi-Fi | Settlement stays, goes quiet: bots sit, sign reads *Mark · away*; Settings row says *last seen N min ago* |
| Unreachable for 7 days while the server stays up | Settlement folds away like a dormant repo; slot kept; returns when reached. (After a restart nothing is held, so an unreachable friend has no settlement until reached — see §2) |
| Key rotated / wrong | 401 → row shows *link no longer valid*; last snapshot shown as away |
| Snapshot malformed or oversized | Rejected by `validateSnapshot`; treated as away |
| Friend on a newer/older share version | Row shows *needs update* |
| Port 5275 taken | Settings shows *couldn't open port 5275*; `BOT_CROSSING_SHARE_PORT` changes it |
| Windows Firewall blocking inbound | Settings hint while sharing is on: *if friends can't see you, allow Node through Windows Firewall on private networks* |

## 5. Testing

All on the existing `node:test` suite (`npm test`) and `test/support/with-server.mjs`.

- **Redaction** (`test/share.test.mjs`): a fully populated thread set in, assert no output
  value contains any `title`, `preview`, `projectPath`, `cwd`, `gitBranch`, `model`, `ref` or
  real `id` from the input. Assert hidden, archived and dormant-when-folded repos are absent.
- **Share listener**: 401 without/with wrong key; 404 for every other path and method; `/api/*`
  unreachable on the share port; listener closed after sharing is turned off; rotate
  invalidates the old key.
- **Neighbor fetch** (`test/neighbors.test.mjs`): against a fake share server — timeout keeps
  last snapshot and reports `away`; 401 → `bad-key`; `v: 2` → `needs-update`; oversized and
  malformed snapshots rejected; unknown fields dropped.
- **Placement** (`test/neighbor-layout.test.mjs`): no overlap with home or between neighbors;
  direction fixed per slot; offset unchanged until a footprint grows into the gap, then moved
  outward along the same direction only; coast world uses landward directions only.
- **Home colony unchanged**: the existing suites (`colony-motion`, `plot-move`, `picking`,
  `occlusion`, `state`) pass unchanged — the home colony must behave identically.
- **Redaction tests live in** `test/share-snapshot.test.mjs`, and the listener's in
  `test/share.test.mjs`.
- **State**: `sharing` and `neighbors` round-trip through `readState`/`writeState` and merge
  correctly in `mergeState` on a 409.
- **End to end**: two instances on different `PORT`s and `BOT_CROSSING_SHARE_PORT`s with
  separate `BOT_CROSSING_DATA` directories, each sharing and each holding the other as a
  neighbor. In a browser, each shows the other's settlement, and clicking a neighbor bot shows
  the read-only card with no action buttons.

## Out of scope

- Reaching friends outside the local network (tunnels, Tailscale). The share URL is just a URL,
  so this works later without a design change.
- Automatic discovery on the LAN.
- Per-friend keys or per-repo sharing choices.
- Any interaction with a friend's threads beyond looking.
- Persisting friends' snapshots across restarts.
