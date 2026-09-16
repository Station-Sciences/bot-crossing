# Contributing

Thanks for looking. Please read the next section before you spend time on anything.

## What you can expect from me

I want to be straight about this rather than let you find out from an unanswered PR.

**This is published as-is, and I cannot promise to maintain it.** I built it for myself and
put it out because it seemed worth sharing. I do not have the time to offer real support, and
I would rather say so up front than imply a level of attention I cannot deliver.

Concretely:

- **Issues** — I read them. I may not act on them, and I may not reply.
- **Pull requests** — genuinely welcome, and please read the next section on how they get
  used, because it is not the usual thing.
- **Response times** — no promises. Days, weeks, or never, depending on what else is going on.
- **Feature requests** — probably not, unless they happen to be something I want too.

## How pull requests actually get used

**A PR here is read as a feature request with a working reference implementation.** That is a
good thing to send and the most useful kind of issue you can open. It is also, usually, not the
branch that gets merged.

What happens instead: I batch the open PRs, test them on my own machine, and land the intent of
them together in one branch. Your name goes on the commit. Then your PR gets closed with a link
to where it shipped.

Three reasons it works this way rather than merge-by-merge:

- **PRs circling the same seam disagree with each other.** Five separate PRs once widened the
  same "open a thread" interface five incompatible ways. Merged in arrival order that leaves the
  codebase with five answers to one question; picking one shape and applying it consistently
  leaves it with one.
- **I have to test it on my machine before it goes in**, and often that turns up something the
  branch could not have known about — a path that is wrong on a real install, a scan cost that
  only shows at volume.
- **Batching is faster than negotiating each branch to a common shape.** It keeps the project
  moving instead of leaving good work sitting in a queue going stale.

**So: your PR may well be closed unmerged and still be the reason something shipped.** That is a
worse deal for you than having your commit merged, and it is written down here so nobody has to
work it out from a closed tab. If that is not what you want from contributing, that is entirely
fair — say so in the PR and I will tell you plainly whether I am likely to merge it as-is.

**What makes a PR most useful under this model:** a small, focused change; a clear description of
the problem it fixes; and what you verified and on what machine. The last one matters more than
the diff. I cannot test Windows, and I cannot test Linux, and I cannot test a harness I do not
have installed — so a PR that says "ran it against 40 real Codex sessions on Fedora, here is what
happened" is worth more to me than a clean patch I have to take on faith.

**And there is a review agent.** I use one for the first pass and read its summary before
deciding anything. You deserve to know how your work is being evaluated. A human — me — makes
the call.

**Forking is a first-class option here, not a consolation prize.** It is MIT. If you want to
take this somewhere I am not going, or you need it maintained on a schedule I cannot offer,
fork it and go — you do not need my permission or my blessing, and I would rather see a
healthy fork than a PR of yours going stale in my queue. If you build something good on top
of it, I would love to hear about it, but you owe me nothing.

If that arrangement does not work for you, no hard feelings — that is exactly why it is
written down here.

## What is most worth contributing

**Harness adapters, by a wide margin.** Bot Crossing reads Claude Code and Codex. The whole
point of the seam in `server/harnesses/` is that adding OpenCode, Antigravity, Amp, Cursor or
anything else should be one new file and one line in a registry.

Everything you need is in **[`server/harnesses/README.md`](server/harnesses/README.md)** — the
interface, the thread shape, the ground rules, and how to find where a given harness keeps its
sessions on disk.

The decisions that are already settled — and why — are in **[DECISIONS.md](DECISIONS.md)**.
Worth a skim before you start; it will save you writing something I have to say no to.

Two hard rules, and I will not bend on either — both are there because breaking them has
already cost somebody's machine something:

- **Nothing is ever written to a harness.** Not a transcript, not a session record, not one
  flag. `data/colony.json` is the only file this project writes.
- **Nothing is ever read from or executed inside another application's bundle.** Only files
  under the user's own home directory. Opening a thread goes through a URL the OS resolves, or
  a command the user already has on `PATH`.

Beyond those, if the interface does not fit your harness, that is a bug in the seam and not in
your work — say so in the PR and change what you need to. I would much rather widen the
interface than have you contort an adapter around it.

Also useful:

- **Bug fixes**, especially anything where the colony misrepresents what a thread is actually
  doing. That is the one thing the project has to get right.
- **Performance**, if you can measure it. See the Performance section of the README for the kind
  of numbers the existing work is held to.

## Working on it

```bash
npm install && npm run dev
```

That is the whole loop — the API runs inside the Vite dev server, so there is no second process.
You need a real harness installed with real threads for anything interesting to appear.

`npm run assets` re-packs the source art into the `.glb` files. It is a no-op on a fresh clone,
because the built files are checked in and the raw packs are not. You only need it if you are
changing the art pipeline, and the README explains where to re-download the packs.

`npm test` runs the suite — the colony file's merge and migration, and the harness contract
against fixtures. It is not exhaustive and there is no linter. New tests are welcome but not
demanded; keeping the existing ones green is.

## What makes a PR easy to say yes to

- **One thing at a time.** A harness adapter, or a bug fix, or a refactor — not all three.
- **Say what you verified and how.** The suite does not cover much, so your description is
  still most of the evidence. "Ran it against 40 real Codex sessions, screenshots attached" is worth more than a
  clean diff.
- **Match the surrounding code.** No semicolons, single quotes, 2-space indent, 110ish columns.
  Comments in this codebase explain *why* — particularly why an obvious approach was rejected.
  That style is deliberate; please keep it where you touch things.
- **Do not add dependencies casually.** The runtime has two, and I would like it to stay small.
- **Do not widen what gets written to disk.** See the two hard rules above. That restraint is
  the feature.

## Licensing

By contributing you agree your work is under the MIT licence, same as the rest. There is no CLA.

The bundled art is **CC0** and not covered by that MIT licence — see
[`public/assets/CREDITS.md`](public/assets/CREDITS.md). If you add art, it needs to be CC0 or
similarly unencumbered, and it needs its provenance recorded there. Please do not add anything
under a licence that restricts redistribution; a paid texture pack got caught on the way to this
release, and I would rather not repeat that.

## Security

If you find something that reads files it should not, writes where it should not, or lets a web
page you merely visited drive the local server, please open an issue rather than a public PR
with a working exploit. See "Keeping it local" in the README for the boundaries as they stand.
