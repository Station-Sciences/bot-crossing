# Decisions

Things that are settled, and why. If a PR argues with one of these, the PR is not wrong — but
it needs to argue with the reason rather than work around it.

Written down because the same questions kept arriving one PR at a time, and answering them
per-PR was producing a codebase with three answers to each.

## Bot Crossing never writes to a harness

`data/colony.json` is the only file this project writes, anywhere.

It used to write one flag — `isArchived` on Claude Code's own session record. That write landed
on disk, and still looked broken: the desktop app serves from the copy of its records it loaded
at launch, so a thread you archived here stayed put in its own list until the app restarted, and
the app rewrote the record from memory the next time it touched the thread. Holding that
together took a re-assert on every scan, a `ps` sweep to guess whether the app had re-read the
file, and a *pending* state for the gap between them.

So archiving is the colony's own bookkeeping now. The bot walks back to the ship exactly
as before, and archiving in the harness's own UI still sends it home too, because the scan reads
that flag. `setArchived` is not part of the adapter interface and adding one back is a bug.

## Nothing is read from or executed inside another application's bundle

Only files under the user's own home directory.

This is not a style preference. An adapter that fell back to
`/Applications/ChatGPT.app/Contents/Resources/codex` and ran it set off a Gatekeeper malware
alert on the maintainer's machine and moved both Codex.app and ChatGPT.app to the Trash —
nothing was wrong with either, but OpenAI's macOS signing certificate had been revoked after the
Axios npm compromise, and macOS's answer to *executing* a binary under a revoked cert is to
block it and bin the app. It also cost five seconds on the first scan while macOS decided.

`claude-code.mjs` used to mention `/Claude.app/Contents/MacOS/Claude`, but that was matching a
string in `ps` output to spot a running process, never launching anything. That code is gone
now anyway; the scan starts no subprocess at all.

## Opening a thread may run a command; nothing else may

Opening is the one place a subprocess is allowed, because there is no other way to hand a
session back on a machine with no desktop app. It goes through a URL the OS resolves, or a
binary the user already has on `PATH` — never a path we guessed inside an app.

## There is one way for an adapter to say "open this"

`openThread(ref)` and `newSession(dir)` return `{ ok, url, command }`, either may be async, and
the server decides what to do with it:

- **macOS and Windows** — the URL goes to the OS opener. A scheme the harness's app registers is
  always answered there, so nothing is probed.
- **Linux** — the scheme is checked with `xdg-mime` first, because `xdg-open` on a scheme nobody
  claims exits quietly and used to reach the page as "Opened". Failing that, `command` runs in a
  terminal. Failing that, the page is told the truth.

When the page asks for a terminal instead, the URL is not consulted on any platform:
`command` runs in a terminal, or the page is told the CLI is missing.
It never falls back to the app, because the person chose a terminal.
Which terminal is `BOT_CROSSING_TERMINAL`, then `$TERMINAL`, then the desktop's own, then whatever is installed.

`command` is `{ argv, cwd }` with an absolute `argv[0]`, offered on every platform when the CLI can be found.
No harness knowledge reaches `launch()` — that seam is the reason `server/harnesses/` is swappable at all.

## `sizeBytes` is bytes

Every harness has a transcript file; not all of them report tokens, and a CLI-only session
often has no token count at all. The field is a shared log scale across the whole map, so
mixing units would make one harness's buildings taller than another's for the same work.

## Thread ids are prefixed

`claude-code:<uuid>`, `codex:<uuid>`. Two UUIDs will not collide, but the colony keys its
archive list and saved layout on this string, and it is worth being unambiguous rather than
merely lucky. `colony.json` v1 files are migrated on read — only Claude Code ever wrote a bare
id, so the rewrite is unambiguous.

## A harness that cannot read its own store says so

Optional `diagnostic()` on an adapter returns a sentence, or `''`. Without it the failure mode
is a harness that reports `detected: true`, throws inside `scanThreads` on every poll, and looks
perfectly healthy in the HUD while contributing nothing.

## Pull requests are treated as feature requests

Contributions are read closely and their intent is usually implemented directly, rather than
merged branch-by-branch. Nine adapters and fixes arriving at once produced five mutually
incompatible widenings of the same interface; taking the intent and writing one version keeps
the codebase coherent and is faster than negotiating each PR to a common shape.

That means a PR can be closed unmerged and still be the reason something shipped. Where that
happens the commit says so and the contributor is credited by name. It is a worse deal for
contributors than merging their commit, and it is written down here so nobody has to discover
it from a closed tab.

## Sound samples are not committed; every sound has a synth

`public/audio/` is gitignored apart from its README. Sample libraries — Splice, and most
stock libraries — license their sounds for use *in* a work, not for redistribution on their
own, and a public MIT repository is redistribution. So the registry in `src/audio/sounds.js`
refuses to load if any name lacks a procedural generator: the game is fully audible from a
fresh clone, and real recordings are an override by name through `manifest.json` on the
machine that owns them. Sounds under CC0 may be committed, with a line in `CREDITS.md`.

## Every hand-written shader calls `withCurve`

The world curve is patched into three's own `project_vertex`, so built-in materials bend
without knowing about it and pick their uniforms up from the material prototype's
`onBeforeCompile`. A material that installs its *own* `onBeforeCompile` replaces that, and
has to call `withCurve(shader)` itself — otherwise its uniforms are zero, it stays flat, and
it floats above the ground that bent away under it. Same for a custom depth material, or its
shadow stays flat while it does not.
