# Shared colonies over the intranet — design

Approved 2026-09-09. Visiting model: **merged map** — a neighbour's repos appear as their own
district on your map, read-only.

## What it is

Two Bot Crossing installs on one LAN can share their colonies. Sharing is off by default. When
Chantal turns it on, her machine answers a read-only guest API; when Dimitri adds her as a
neighbour, her repos rise as a named district ("Chantal") beside his own, her astronauts walking
and building from her live status data. Nothing on her machine can be opened, archived or
started from his map — not as a permission, but because the routes do not exist on the socket
he talks to.

## Components

### 1. Guest listener — `server/guest.mjs`

A second HTTP server, opened only while sharing is on, bound to `0.0.0.0:5275`
(`BOT_CROSSING_GUEST_PORT` overrides). It serves exactly:

- `GET /guest/info` → `{ app: 'bot-crossing', name, version, instanceId }`
- `GET /guest/threads` → the same scan the owner sees, minus anything actionable: `ref` is
  stripped, `canOpen` forced false. Transcript paths and pids never leave the adapter anyway.

No static files, no other routes — action endpoints are absent by construction, which is the
whole security story. The owner's own UI stays on `127.0.0.1:5274`, unreachable from the LAN.

### 2. Discovery — `server/discovery.mjs`

UDP on port 5276 (`BOT_CROSSING_DISCOVERY_PORT`).

- **Announce** (only while sharing): broadcast `{ v: 1, app: 'bot-crossing', name, guestPort,
  instanceId }` every 15 s, and once immediately on enable.
- **Listen** (always): collect announcements into a peers list `{ name, host, guestPort,
  lastSeen }`, expiring after 60 s. Own announcements are recognised by `instanceId` (random
  per boot) and dropped.

Broadcast does not cross subnets; that is what manual adding is for.

### 3. Neighbours — `server/neighbors.mjs`

Configured neighbours live in `colony.json` under `network.neighbors: [{ name, host, port }]`,
alongside `network.share: boolean` and `network.colonyName: string`. The page manages them
through the existing `PUT /api/state` flow; the server watches that write and starts/stops the
guest listener and announcer to match.

Each poll of `/api/threads` triggers a background refresh per neighbour — `GET
http://host:port/guest/threads` with a 2 s abort — and merges the **cached** last-good answer,
so a slow or dead neighbour never delays the owner's own map. Guest threads are tagged:

- `id` → `guest:<host>:<id>` (can never collide with a local id)
- `colony: <name>`, `canOpen: false`, no `ref`

The merged payload also carries `colonies: [{ name, host, online }]` so the page can dim an
offline district instead of dropping it.

New read endpoint: `GET /api/neighbors` → `{ configured: [...with online flags],
discovered: [...from UDP, minus already-configured] }`.

### 4. Map — merged districts

Each neighbour gets a **landing beacon**: an anchor cell at a bearing derived from the colony
name, placed beyond the owner's own zones. A guest repo's zone seeds from that beacon the way
local zones seed from the ship, so a neighbour's repos cluster into a recognisable district
rather than interleaving. A name banner floats over the district; guest plots carry the
neighbour's accent. Offline: the district stays (layout is remembered in `colony.json` like any
zone) and dims with an offline badge.

### 5. Read-only in the UI

Guest threads and plots show their info on click, but open / archive / new-conversation actions
are absent for them (`canOpen` false, no `ref`, and the zone deck's "new conversation" is
hidden for guest districts). The server refuses actions on `guest:`-prefixed ids regardless.

### 6. Settings

In the S-panel, a Network section: colony name (default: OS username), share toggle (default
off), configured neighbours with online dots and remove, discovered neighbours with an add
button, manual host:port entry.

## Testing

- Unit: guest listener allowlist (action routes 404 on the guest socket; `ref` stripped),
  neighbour merge tagging (prefix, `canOpen`, collision safety), discovery parse/expiry.
- End-to-end on one machine: a second instance with its own `BOT_CROSSING_DATA` dir and ports
  plays Chantal; verify her district renders, actions are refused, and unplugging her (killing
  the instance) dims the district.

## Out of scope (deliberately)

- Fetching a neighbour's own zone layout (`/guest/state`): the merged map lays guest zones out
  itself, so the endpoint is not built.
- Transitive sharing (seeing Chantal's neighbours), auth/allowlists beyond the LAN boundary,
  TLS: the trust model is "same intranet, opt-in, read-only socket".
- macOS/Linux parity concerns: everything here is plain Node networking, platform-neutral.

## Practical notes

- Both machines need this build; sharing must be switched on by its owner.
- Windows Firewall will ask once, per machine, to allow node inbound on private networks
  (guest port 5275/TCP and discovery 5276/UDP).
