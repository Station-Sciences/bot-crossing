# Harness adapters

A **harness** is whatever actually runs the agent threads — Claude Code, Codex CLI, OpenCode,
and so on. Each stores its sessions differently, and none of it is a documented API. Isolating
that per-harness knowledge behind one interface is what keeps the rest of the project from
caring which agent you use.

## The interface

An adapter is one module exporting an object. Nothing outside it should know what a session id
looks like for that harness.

```js
export default {
  id: 'claude-code',            // stable slug
  name: 'Claude Code',          // for display

  /** Is this harness present on this machine at all? */
  async detect(),

  /** → Thread[] in the common shape below. */
  async scanThreads(),

  /** Hand a thread back to its harness. → { ok, url } | { ok: false, error } */
  openThread(ref),

  /** Start a fresh thread rooted at a folder. → { ok, url } */
  newSession(dir),

  /** Flip archive state on the harness's own records. → { ok } */
  async setArchived(ref, archived),

  /** When the harness's GUI last launched, for archive reconciliation. → epoch ms, or 0 */
  async appStartedAt(),
}
```

Optional methods may simply be absent — a CLI-only harness with no archive concept omits
`setArchived`, and the UI hides the control rather than offering something that will fail.

## The thread shape

Everything downstream reads only these fields. Keep harness-specific ids inside `ref`.

| Field | Meaning |
| --- | --- |
| `id` | Unique and **stable across scans** — it keys persisted state, so never derive it from something that changes |
| `title`, `preview` | Human labels |
| `project`, `projectPath`, `worktree`, `cwd` | Where the work is happening |
| `gitBranch`, `model`, `effort` | Metadata, may be empty |
| `createdAt`, `lastActivityAt`, `lastFocusedAt` | Epoch ms |
| `running`, `unread`, `hasError`, `archived` | Derived state — see below |
| `starred`, `routine`, `prState` | Optional signals |
| `sizeBytes`, `hasTranscript` | How much work this thread represents |
| `canOpen`, `canArchive` | What this adapter can actually do for this thread |
| `ref` | Opaque adapter-private blob, handed straight back on open/archive |

Derive `running` and `unread` **inside the adapter**, not centrally. Those rules are
harness-specific: what counts as "active" depends on how that agent manages processes, and a
harness with no focus history cannot answer "unread" at all — in which case the honest answer is
`false`, not a guess.

## Rules that matter

**Read freely, write almost nothing.** Set the one flag you need and nothing else. Write it back
through a temp file and rename so a crash cannot truncate a real session record. Verify the
record is what you think it is before writing — check that its own id matches — because you are
editing somebody's actual work.

**Expect your writes to be overwritten.** Agents commonly hold session records in memory and
rewrite them wholesale, silently clearing a flag set from outside. Keep your own list of intent
and re-assert on every scan, so a stomped change comes back within one poll.

**Pattern-check every id before it reaches a shell, a path join, or a URL.** Ids arrive from a
page, which got them from a scan that may be minutes stale. Validate the shape, and hand
arguments to the opener as an argument list, never as a shell string.

**A live process is not the same as an active session.** Harnesses pre-warm idle sessions, so
process liveness alone will report threads untouched for days as busy. Require recent activity
too. Probe every recorded pid before believing it — registries keep files for processes that
exited.

**Let the process speak before you guess from the transcript.** Where a harness records what each
live process is doing — Claude Code's registry carries a `status` of `busy`, `waiting`, `idle` or
`shell` — read that first. The transcript alone cannot tell a turn that ended from one parked on
a background agent or a long tool call: both leave a final assistant message at the tail, and
reading the tail alone marks a working thread as waiting on you. Keep the transcript read for
records that predate the field, and for `idle`, where only the transcript knows whether an answer
is sitting there for you.

**Merge duplicates.** Resuming a thread often writes a second record pointing at the same
transcript. Merge them, keep the richer one as canonical, and retain both ids so an archive
covers the ghost as well.

**Fail on a stale path rather than acting on it.** A folder recorded minutes ago may have moved.
Re-check it exists and is a directory before doing anything with it.

## Reading transcripts cheaply

Transcripts get large. Read a bounded chunk from the head rather than loading the file, and drop
a trailing partial line so a parser never sees half a record. Cache the parsed result against the
file's mtime — this is usually the difference between a scan that takes milliseconds and one that
takes seconds.

Expect malformed lines in a file being written to right now. Skip them silently; do not fail the
scan.

## Where harnesses keep things

Do not trust this list — verify on the machine, since layouts change between versions. The
method that holds up: find the directory, read one file, let the shape tell you what it is.

- **Claude Code** — GUI session records under the app's application-support directory, one JSON
  per thread; CLI transcripts as JSONL under a per-project directory in `~/.claude/projects`;
  a live-process registry in `~/.claude/sessions`, one record per process with its `status`.
  Threads may exist in either store or both.
- **Codex CLI** — rollout files under `~/.codex/sessions`.
- **OpenCode** — session storage under the platform data directory for `opencode`.
- **Others** — Antigravity CLI, Amp, Aider, Goose, Cursor CLI, Qwen Code all keep local state;
  none of them in the same shape.

When adding an adapter, expect the first genuinely different harness not to fit the interface
perfectly. That is a bug in the seam, not in your adapter — widen the interface rather than
contorting around it. An interface that has only ever been implemented once is a hypothesis.

## Opening a thread again

Prefer whatever deep link *navigates* the harness to a thread it already has. Some harnesses
also offer a "resume from transcript" entry point, which typically *imports* the transcript —
creating a duplicate session and rewriting the file. Treat that as a last resort for threads the
app has never seen, and say so in a comment, because the difference is invisible until it has
already made a mess of somebody's history.
