# Harness adapters

A **harness** is whatever runs the agent threads you want to see as astronauts — Claude Code,
Codex CLI, OpenCode, and so on. Bot Crossing does not care which one you use: it asks every
harness present on the machine for its threads and draws whatever comes back.

Adding one is meant to be **one new file in this directory**, plus one line in `index.mjs`.
Nothing in `server/scan.mjs`, `server/api.mjs`, or anywhere under `src/` should need to change.
If you find yourself editing those to land a harness, that is a bug in this seam — please say so
in the PR, because the next person will hit it too.

## The shape of it

```js
// server/harnesses/my-harness.mjs
export default {
  id: 'my-harness',              // stable, kebab-case, used as a key — never change it later
  name: 'My Harness',            // what a human sees in the UI
  detect,                        // () => Promise<boolean>
  scanThreads,                   // () => Promise<Thread[]>
  openThread,                    // (ref) => { ok, url } | { ok: false, error }
  newSession,                    // (dir) => { ok, url } | { ok: false, error }
  setArchived,                   // (ref, archived) => Promise<{ ok, error? }>
  appStartedAt,                  // optional: () => Promise<number>
}
```

Then, in `index.mjs`:

```js
import myHarness from './my-harness.mjs'
export const HARNESSES = [claudeCode, myHarness]
```

### `detect()`

Is this harness on this machine at all? Usually just "does its data directory exist". Cheap —
it runs on every scan, so that installing a harness while the colony is open is noticed on the
next poll. Returning `false` means the harness is skipped entirely, and no astronaut for it
ever appears.

### `scanThreads()`

The real work: return one `Thread` per session the harness knows about.

Throwing is survivable — the scanner logs it and carries on with the other harnesses, so one
broken adapter costs you its own threads and nothing else. Prefer that over returning junk.

### `openThread(ref)` / `newSession(dir)`

Return `{ ok: true, url }` and the server hands that URL to the OS opener — or
`{ ok: true, command: [bin, ...args] }` and the server runs that instead, detached. The
second exists for a harness whose URL scheme opens the app but not the place: Cursor's
`cursor://file/<dir>` brings the app up and then opens nothing, while `cursor <dir>` on its
command line opens the folder as a workspace. `openThread` gets the `ref` from the thread it
belongs to; `newSession` gets an absolute directory that the server has already checked
still exists.

If your harness has no deep link, return `{ ok: false, error: '…' }` and say why — the UI
shows the message rather than pretending the click worked.

### `setArchived(ref, archived)`

Flip whatever "archived" means in that harness's own records, so the thread lands in *its*
archived list rather than only disappearing here. If the harness has no such concept, return
`{ ok: false, error: '…' }`: the colony still records the archive on its own side, and the
astronaut still walks back to the ship.

Be conservative about what you write. The Claude Code adapter touches exactly one key, writes
through a temp file and renames over the original, and re-reads the record first to check it
is the session it thinks it is. Someone's real work is in these files.

### `appStartedAt()` — optional

Epoch milliseconds of when the harness's long-lived app last launched, or `0`.

This exists for one specific problem: an app that loads its session records at startup and
rewrites them from memory will silently stomp an archive flag set from outside. The colony
re-asserts the flag every scan, and uses this timestamp to tell "already picked up" from
"still waiting on disk" — which is what drives the *pending* look on an astronaut walking to
the ship. A CLI-only harness has no such app; omit the method.

## The `Thread` your adapter returns

Only `id` is truly required, but the colony gets duller the more you leave out — `project` is
what earns a repo its own zone, and `lastActivityAt` is what sorts the whole map.

| Field | Type | What it means |
| --- | --- | --- |
| `id` | string | **Unique across every harness.** A UUID is fine; otherwise prefix it, e.g. `my-harness:1234` |
| `title` | string | Thread title. `'Untitled thread'` if the harness has none |
| `preview` | string | First prompt, trimmed — shown on the thread card |
| `project` | string | Repo/folder **name**. This is what claims a hex zone |
| `projectPath` | string | Absolute path to the repo root |
| `worktree` | string | Worktree name, or `''` |
| `cwd` | string | Where the thread is actually working |
| `gitBranch` | string | Branch name, or `''` |
| `model` / `effort` | string | Shown on the thread card |
| `createdAt` | number | Epoch ms |
| `lastActivityAt` | number | Epoch ms. Sorts the colony and drives the "asleep for 3 days" behaviour |
| `lastFocusedAt` | number | Epoch ms, `0` if unknowable |
| `running` | boolean | Working **right now** — the astronaut hammers away |
| `unread` | boolean | Moved on since you last looked — the astronaut stops and holds a `?` |
| `hasError` | boolean | Errored — the astronaut slumps, red eyes |
| `starred` / `routine` / `prState` | | Optional extras; `prState: 'merged'` triggers the confetti |
| `archived` | boolean | Archived in the harness's own records |
| `sizeBytes` | number | Transcript size. **This is how finished a building looks**, on a log scale |
| `source` | string | Free-form, for your own bookkeeping (the Claude adapter uses `desktop` / `cli`) |
| `canOpen` / `canArchive` | boolean | Whether this thread supports those actions. The UI greys the buttons out |
| `ref` | object | **Opaque.** Whatever *you* need to find this thread again |

### About `ref`

`ref` is the whole reason the browser does not know what a session id looks like. Your adapter
puts whatever it needs in there, the page hands it straight back on open and archive, and
nothing between the two ever inspects it.

Keep it small and keep it serialisable — it makes a round trip through JSON on every action.
Do not put a file handle, a class instance, or a secret in it.

## Ground rules

- **Read-only by default.** The one exception in the whole project is the archive flag. A
  harness's transcripts are somebody's actual work; the colony is a viewer, not an editor.
- **Never block the scan.** It runs on a poll. Cache anything expensive against file mtime —
  see `transcriptMeta` in `claude-code.mjs`, which is what keeps a 12MB transcript from being
  reparsed every few seconds.
- **Read heads, not whole files.** `readHead` in `../lib/fsutil.mjs` pulls the first chunk and
  drops a trailing partial line, so `JSON.parse` never sees half a record.
- **Expect malformed data.** A session being written *right now* is a normal thing to trip
  over. Skip that record and move on; do not throw the pass away.
- **Never widen `id` collisions.** The colony keys its archive list and saved layout on `id`.
  Two harnesses handing back the same id would merge two unrelated threads into one astronaut.

## Starting points

Verified on a real machine:

- **Claude Code** — desktop records in
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`
  (`%APPDATA%\Claude\claude-code-sessions\…` on Windows); CLI transcripts in
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; live processes in
  `~/.claude/sessions/*.json`. Implemented in `claude-code.mjs`.
- **Codex CLI** — transcripts in `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`,
  with records shaped `{ timestamp, type, payload }`, and what looks like an index at
  `~/.codex/session_index.jsonl`. Not implemented yet.

For anything else, the fastest way in is usually to start a throwaway session in that harness
and watch which files change:

```bash
find ~ -maxdepth 4 -newermt '-2 minutes' -type f 2>/dev/null | grep -iv Library/Caches
```

## Checking your work

There is no test suite to run yet. What the Claude Code adapter was verified against, and what
a new one should clear too:

1. `node --check server/harnesses/my-harness.mjs`
2. With the app running, `GET /api/harnesses` lists every registered harness and whether
   `detect()` found it. If yours is missing or `detected: false`, stop here — nothing else
   will work until it shows up:

   ```bash
   curl -s localhost:5274/api/harnesses
   ```
3. Scan straight from node and look at the result — the number should match what the harness
   itself reports, and no field should be `undefined`:

   ```bash
   node -e 'import("./server/scan.mjs").then(async m => {
     const t = (await m.scanThreads()).filter(x => x.harness === "my-harness")
     console.log(t.length, "threads"); console.dir(t[0], { depth: 4 })
   })'
   ```
4. `npm run dev`, then confirm the astronauts appear on the right plots, the thread card fills
   in, and Open does what you expect.
5. Archive one thread and check it shows as archived **in the harness's own UI**, not just here.
