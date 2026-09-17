/**
 * The open pull requests, as data.
 *
 * This is a review harness, not a feature: it exists so a round of PRs can be walked through in
 * the running colony rather than read as diffs. Every entry says what the PR does, what was
 * actually measured on this machine, and — where the change is one the colony can turn on at
 * runtime — how to show it.
 *
 * `preview` is the part that earns this module:
 *
 *   - `planet`  — the PR adds a world. Selecting it flies there.
 *   - `flag`    — the PR changes behaviour that can be toggled live.
 *   - `none`    — the PR is server-side or structural, and there is nothing to look at. Say so
 *                 plainly rather than pretending a detail panel is a preview.
 *
 * Keep `measured` honest. A claim here that was read off a diff rather than run is worse than
 * no claim, because the whole point of the round is telling those two apart.
 */

/** Where a PR stands. Drives the colour of the dot and the grouping in the panel. */
export const VERDICT = {
  take: { label: 'Taking', tone: 'good' },
  change: { label: 'Taking, changed', tone: 'good' },
  review: { label: 'For review', tone: 'warn' },
  aside: { label: 'Set aside', tone: 'mute' },
  close: { label: 'Superseded', tone: 'mute' },
  skip: { label: 'Not taking', tone: 'bad' },
}

const pr = (n) => `https://github.com/Station-Sciences/bot-crossing/pull/${n}`

export const CATALOGUE = [
  // ── landed on this branch ───────────────────────────────────────────────────
  {
    n: 22,
    author: 'Andres Clavijo',
    title: 'An erased archive, and a dropped ?',
    verdict: 'change',
    summary:
      'A save that slipped out before the colony file was read PUT an empty archive list over the ' +
      'real one. Taken as a refusal in api.js rather than the flag in main.js the branch used, so ' +
      'it guards every caller. Its other half — sorting the roster clamp by urgency — is already ' +
      'on main.',
    measured: 'Reproduced by reading: main has no guard, and the server allows a zero base as a first write.',
    preview: { kind: 'none', why: 'A refusal to write. Nothing to see; there is a test instead.' },
  },
  {
    n: 52,
    author: 'Rodrigo Costa',
    title: 'Threads deleted in the desktop app read as archived',
    verdict: 'take',
    summary:
      'The desktop app records a deletion rather than removing the session, so a deleted thread ' +
      'kept walking around. It now arrives archived.',
    measured: '353 archived against main’s 350 on this machine’s real store — three threads deleted weeks ago.',
    preview: { kind: 'none', why: 'Adapter-level. Visible only as three fewer astronauts.' },
  },
  {
    n: 40,
    author: 'Sarah Schultze',
    title: 'One Windows checkout arriving as two projects',
    verdict: 'take',
    summary:
      'Codex hands a path back with the extended-length prefix, \\\\?\\C:\\…, which the drive-letter ' +
      'fold never reached — so one folder counted as two and renamed both plots.',
    measured: 'Read, not run: no Windows machine here. A genuine third case, not a repeat of f3ed478.',
    preview: { kind: 'none', why: 'Windows-only path handling. Cannot be shown from a Mac.' },
  },
  {
    n: 54,
    author: 'Jared Kwakyi',
    title: 'The desktop app’s other name on macOS',
    verdict: 'take',
    summary:
      'The app ships as either Claude or Claude-3p, and an upgrade leaves the old directory behind ' +
      'empty. Picks whichever actually holds session records.',
    measured: 'This machine has only the classic name, so nothing changes here yet. It is the upgrade this is for.',
    preview: { kind: 'none', why: 'A directory choice made once at import.' },
  },
  {
    n: 26,
    author: 'eco-null',
    title: 'OpenCode harness adapter',
    verdict: 'take',
    summary: 'One module, one line in the registry. Six of the contributor’s own fixture tests came with it.',
    measured: 'Not installed here: detect() false in 1ms, empty scan, no throw. Its tests pass.',
    preview: { kind: 'none', why: 'No OpenCode on this machine — there would be no astronauts to show.' },
  },
  {
    n: 28,
    author: 'dev491999',
    title: 'Antigravity CLI harness adapter',
    verdict: 'take',
    summary: 'Preferred over #44, which bundles Antigravity with Cline, Roo Code and a GitHub layer across 37 files.',
    measured: 'Not installed here: detect() false in 1ms, empty scan, no throw. Its three tests pass.',
    preview: { kind: 'none', why: 'No Antigravity on this machine.' },
  },
  {
    n: 7,
    author: 'jkir4n',
    title: 'Hermes harness adapter',
    verdict: 'change',
    summary:
      'Taken with its setArchived removed — it ran UPDATE against the agent’s own database, which is ' +
      'the one thing an adapter may not do. canArchive went with it.',
    measured: 'Unparked: it reads three real sessions here in 2ms cold, ids prefixed per pilot. It used to throw.',
    preview: { kind: 'none', why: 'Three real Hermes threads are in the colony now — look for the Hermes zone.' },
  },

  // ── wired for review ────────────────────────────────────────────────────────
  {
    n: 34,
    author: 'Simon Kohnstamm',
    title: 'A selected astronaut stands still',
    verdict: 'review',
    summary:
      'Freezes whoever you picked so the camera and sidebar do not chase them. Main answers the same ' +
      'complaint the other way, with opt-in camera follow — so this is a default, not a rival. Wired ' +
      'as a setting rather than always-on, which is the open question.',
    measured: 'Main has follow at camera.js; it has no freeze. The two are complementary.',
    preview: { kind: 'flag', key: 'reviewFreezeSelected', hint: 'Pick an astronaut, then toggle' },
  },
  {
    n: 48,
    author: 'Wendel Bezerra',
    title: 'Reef world',
    verdict: 'review',
    summary:
      'An underwater world: caustics on the seabed, sand ripples combed by a current, coral grown from ' +
      'primitives, marine snow. Split out from the rest of #48 — the automations harness and the ' +
      'Windows terminal are separate questions.',
    measured: '~2,100 lines across reef.js, fish.js, planet.js, plots.js and sky.js.',
    preview: { kind: 'planet', id: 'reef' },
  },
  {
    n: 37,
    author: 'Sherman Powell',
    title: 'A Fiji beach planet',
    verdict: 'review',
    summary:
      'The reusable half of #37. Its other two parts are a repo rename and a Business Tasks adapter ' +
      'that reads a hand-edited file from the contributor’s own CEO workflow — that one is personal ' +
      'infrastructure, not a feature.',
    measured: 'Read, not run.',
    preview: { kind: 'planet', id: 'fiji' },
  },
  {
    n: 32,
    author: 'Simon Kohnstamm',
    title: 'A desert world: twin suns, dunes',
    verdict: 'review',
    summary:
      'Predates main’s Dune and mostly arrives at the same place. The twin suns are the part Dune ' +
      'does not have.',
    measured: 'Read, not run. Four conflicts against main.',
    // Deliberately main's Dune rather than the branch's: the question for this PR is whether it
    // adds anything to the world that already shipped, so the honest preview is the one to
    // compare against. Says so on the card rather than passing it off as the PR's own work.
    preview: { kind: 'planet', id: 'desert', hint: 'This is main’s Dune, for comparison — not the PR’s build.' },
  },

  // ── set aside, by your call ─────────────────────────────────────────────────
  {
    n: 49,
    author: 'Aria Vesta',
    title: 'Open threads in a terminal, by choice',
    verdict: 'review',
    summary:
      'The recommended shape for the open-a-thread seam, with #23’s front-the-existing-window folded in. ' +
      'Terminal becomes a choice rather than a fallback.',
    measured: '46/46 tests pass on the branch.',
    preview: { kind: 'none', why: 'Server-side. Shows up as what the Open button does, not as pixels.' },
  },
  {
    n: 23,
    author: 'Dimitri',
    title: 'Front the attached terminal window',
    verdict: 'review',
    summary: 'Folds into #49 rather than landing on its own.',
    measured: 'Zero conflicts against main.',
    preview: { kind: 'none', why: 'Server-side.' },
  },
  {
    n: 33,
    author: 'Simon Kohnstamm',
    title: 'Drag a zone to new ground',
    verdict: 'review',
    summary: 'A genuinely new interaction — not in #53, not superseded by anything.',
    measured: 'Read, not run. One conflict, in plots.js.',
    preview: { kind: 'none', why: 'Not yet integrated on this branch.' },
  },
  {
    n: 45,
    author: 'Zach Austin',
    title: 'An MCP factory building with glowing call pipes',
    verdict: 'review',
    summary: 'A new building type for threads that own an MCP server.',
    measured: 'Read, not run. Two conflicts.',
    preview: { kind: 'none', why: 'Not yet integrated on this branch.' },
  },
  {
    n: 24,
    author: 'meyraa',
    title: 'A thread’s live subagents on the map',
    verdict: 'review',
    summary: 'Draws the subagents a Claude Code thread has spawned.',
    measured: 'Read, not run. Four conflicts.',
    preview: { kind: 'none', why: 'Not yet integrated on this branch.' },
  },
  {
    n: 35,
    author: 'Simon Kohnstamm',
    title: 'An alien crew',
    verdict: 'review',
    summary: 'A second crew look. #53 rewrote the crew model underneath it.',
    measured: 'Read, not run. Two conflicts, in astronauts.js and faces.js.',
    preview: { kind: 'none', why: 'Not yet integrated on this branch.' },
  },
  {
    n: 36,
    author: 'Simon Kohnstamm',
    title: 'A desert building kit, per-planet skylines',
    verdict: 'review',
    summary: 'The largest of the QuiltSimon set and the most conflicted.',
    measured: 'Read, not run. Nine conflicts.',
    preview: { kind: 'none', why: 'Not yet integrated on this branch.' },
  },
  {
    n: 25,
    author: 'Dimitri',
    title: 'Shared colonies over the LAN',
    verdict: 'aside',
    summary:
      'Visit a teammate’s colony read-only. Set aside by your call. Worth noting: it is the only PR ' +
      'that touches merge-state.js, and it got it right — extends with `network`, local wins whole, ' +
      'and says why.',
    measured: 'Read, not run.',
    preview: { kind: 'none', why: 'Set aside.' },
  },
  {
    n: 41,
    author: 'dsackr',
    title: 'Plugin and extension hooks',
    verdict: 'aside',
    summary: 'A new seam. Set aside by your call — this is a roadmap decision, not a review.',
    measured: 'Zero conflicts, 469 added lines.',
    preview: { kind: 'none', why: 'Set aside.' },
  },
  {
    n: 27,
    author: 'eco-null',
    title: 'Kilo Code harness adapter',
    verdict: 'aside',
    summary: 'Good adapter, but its own test asserts a Windows path is absolute, so it fails here.',
    measured: 'Fails its own test at harness.test.mjs:384 — C:/… is not absolute on POSIX.',
    preview: { kind: 'none', why: 'Set aside until the contributor fixes the test.' },
  },

  // ── not taking ──────────────────────────────────────────────────────────────
  {
    n: 50,
    author: 'Rodrigo Costa',
    title: 'Read Claude Code’s own session status',
    verdict: 'skip',
    summary: 'Skipped: no observable effect here.',
    measured: 'Identical on all 431 threads, every tracked field. Needs the contributor to say what differed.',
    preview: { kind: 'none', why: 'Nothing changed to show.' },
  },
  {
    n: 20,
    author: 'AI-Manny',
    title: 'Server-owned archives + CLI open mode',
    verdict: 'skip',
    summary:
      'The shell approach is out: it builds an osascript `do script` by joining quoted parts, and uses ' +
      'cmd /c start on Windows. Server-owned archives also reverse a settled decision.',
    measured: 'Branches from before the test suite existed — its tree has no test/ directory at all.',
    preview: { kind: 'none', why: 'Not taken.' },
  },
  {
    n: 44,
    author: 'rayasya',
    title: 'Google Antigravity adapter (+ Cline, Roo, GitHub)',
    verdict: 'skip',
    summary: 'Four features in one PR. #28 covers Antigravity in one focused module.',
    measured: 'Uses spawn(cmd.exe, [/c, start, …]) — the named pattern.',
    preview: { kind: 'none', why: 'Not taken.' },
  },
  {
    n: 30,
    author: 'kartik-ramachandran',
    title: 'Codex harness adapter',
    verdict: 'close',
    summary: 'Main’s codex.mjs reads two stores and is richer.',
    measured: 'Branches from before the test suite. Conflicts against main.',
    preview: { kind: 'none', why: 'Already shipped.' },
  },
  {
    n: 31,
    author: 'Simon Kohnstamm',
    title: 'Spawn the crew by status',
    verdict: 'close',
    summary:
      'Both halves are on main. Its cap − leaving arithmetic is the approach #53 tried and rejected, ' +
      'with the reason written into the comment: the subtraction feeds on itself and empties the colony ' +
      'onto the ramp within three polls.',
    measured: 'Old main’s _sendHome left status alone — that was the bug. Main’s sets it.',
    preview: { kind: 'none', why: 'Already fixed.' },
  },
  {
    n: 38,
    author: 'lNastaran',
    title: 'The colony on a phone',
    verdict: 'close',
    summary: '#53 ships a phone layout: bottom sheet, top rail, docked card, Low preset by default.',
    measured: 'Read, not run.',
    preview: { kind: 'none', why: 'Already shipped.' },
  },
]

export const byNumber = (n) => CATALOGUE.find((e) => e.n === n) || null
export const linkFor = (entry) => pr(entry.n)

/** Panel order: what is being taken first, then what needs looking at, then the rest. */
const RANK = { change: 0, take: 0, review: 1, aside: 2, close: 3, skip: 3 }
export const ORDERED = [...CATALOGUE].sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || a.n - b.n)
