# My Contributions — Tanishka Rajratna Randive

This fork of [Bot Crossing](https://github.com/Station-Sciences/bot-crossing) adds support for
**remote SSH Codex sessions**, an **unarchive UI**, and several **bug fixes** to the open-thread
flow on macOS.

---

## Features Added

### 1. Remote SSH Codex Thread Support (`server/harnesses/codex.mjs`)

The upstream project only reads Codex sessions from the local machine. This fork adds the ability
to **scan and open Codex threads running on a remote SSH host** (e.g. a cloud dev server).

**How it works:**

- Set the `CODEX_SSH_HOST` environment variable (e.g. `CODEX_SSH_HOST=user-node-3`) — or use the
  built-in `npm run dev:remote` script.
- The server SSHs into the remote host, runs a lightweight Python scanner over its
  `~/.codex/sessions/` directory, and merges those threads into the local colony.
- Each remote thread appears on the map just like a local one, with its title, project, branch and
  model pulled from the transcript.

**Key changes:**
- `remoteRows()` — SSHs into the host and collects session metadata via a Python one-liner.
- `remoteThreads()` — maps each row into the standard thread shape.
- `scanThreads()` — merges local and remote threads into one list.

### 2. Opening Remote Threads (`server/harnesses/codex.mjs` + `server/api.mjs`)

Upstream disabled the **Open** button for remote threads (`canOpen: false`) because there was no
way to resume a session on another host. This fork enables it by:

- Returning `canOpen: true` for remote threads.
- Building an `ssh -t <host> codex resume <id>` command when a remote thread is opened.
- Marking the command as `remote: true` so the server skips local folder validation (the cwd
  exists on the remote host, not locally).
- Fixing `present()` in `api.mjs` so that on macOS, when a thread has no `codex://` deep-link URL
  but does have a terminal command, it falls through to `runInTerminal()` instead of erroring.

### 3. Unarchive UI (`src/ui/hud.js` + `src/main.js`)

Upstream lets you archive threads (bot walks back to the ship), but there was **no way to undo
it** from the UI. This fork adds:

- An **"Archived" section** in the sidebar legend, listing all archived threads grouped by project.
- An **"Unarchive" button** on each archived thread that removes it from the archive list,
  re-places its bot on the map, and saves the colony state.
- The `unarchiveThread` action in `main.js` that handles the state mutation and triggers a re-render.

---

## Bug Fixes

### `present()` on macOS short-circuits remote threads (server/api.mjs)

**Before:** On non-Linux platforms, `present()` checked `if (!result.url)` and immediately returned
an error. Remote threads have no `codex://` URL, so the Open button always showed
*"That harness has no deep link to open on this platform"*.

**After:** The function now checks for `result.url` first (use it if present), then falls back to
`result.command` (open a terminal), and only errors if neither exists.

### `runInTerminal()` rejects remote cwds (server/api.mjs)

**Before:** `runInTerminal()` called `resolveFolder(command.cwd)` which checks whether the path
exists on the local filesystem. For an SSH command, the cwd is on the remote host, so this always
failed with *"The folder that thread ran in is not on this machine any more"*.

**After:** Commands marked `remote: true` skip local folder validation entirely and use `$HOME` as
the terminal's working directory.

---

## Files Changed

| File | What changed |
| --- | --- |
| `server/harnesses/codex.mjs` | Remote SSH scanning (`remoteRows`, `remoteThreads`), remote `openThread` with SSH, `canOpen: true` |
| `server/api.mjs` | `present()` falls through to terminal on macOS; `runInTerminal()` supports `remote: true` |
| `src/main.js` | `unarchiveThread` action, `archivedCatalog()`, passes archived list to legend |
| `src/ui/hud.js` | Archived section in sidebar, toggle, unarchive buttons |
| `package.json` | Minor dependency update |

---

## Author

**Tanishka Rajratna Randive**
[GitHub: Tanishka15](https://github.com/Tanishka15) · IIT Ropar (2023AIB1018)
