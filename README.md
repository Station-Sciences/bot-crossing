# Bot Crossing — your agent threads, as a colony

**[botcrossing.com](https://botcrossing.com)**

Every coding-agent thread on this machine is a little astronaut. They walk out of the ship, claim
a plot for their repo, and build something. When one needs you it stops and holds a `?` over
its head; click it and the thread opens back in whichever harness it came from.

It reads the harness's own files, on your own machine. Nothing is uploaded, there is no
account, and **it never writes to a harness at all** — `data/colony.json`, where the map lives,
is the only file it writes anywhere.

> **Status:** published as-is. I built this for myself and cannot promise to maintain it —
> issues and PRs are welcome but may go unanswered, and forking is an entirely reasonable
> thing to do. [CONTRIBUTING.md](CONTRIBUTING.md) sets out what to expect.

## Run it

```bash
npm install && npm run dev
```

Needs Node 22.13 or newer. `npm test` runs the suite.

`npm run dev` is the whole thing: the API lives inside the Vite dev server, so there is no
second process. For a built version, `npm start` (build + serve) or `npm run serve` if
`dist/` already exists. Binds to `127.0.0.1` by default, and answers only its own page — see
[Keeping it local](#keeping-it-local).

**macOS, Linux and Windows.** Opening a thread, revealing a folder and starting a new session
all go through a `harness://` deep link handed to the OS opener — `open(1)` on macOS,
`xdg-open` on Linux, ShellExecute on Windows. The scanning half was portable already. On Linux,
where a desktop app often is not installed, the scheme is checked first and a terminal running
the harness's own CLI opens instead when nothing answers it.

## Which harnesses work

A **harness** is whatever actually runs your threads. Bot Crossing reads each one's local
session files through a small adapter, so support is per-harness and mostly a matter of
somebody writing that adapter.

| Harness | Status |
| --- | --- |
| **[Claude Code](https://claude.com/claude-code)** (Anthropic) | ✅ **Supported** — desktop app and CLI, including worktrees and live-process detection |
| **[Codex](https://developers.openai.com/codex/cli)** (OpenAI) | ✅ **Supported** — desktop, VS Code and CLI sessions, opened through `codex://` |
| [OpenCode](https://opencode.ai) | ⬜ Not yet |
| [Antigravity CLI](https://antigravity.google) (Google) | ⬜ Not yet — the successor to Gemini CLI, which Google stopped serving individual accounts on 18 June 2026 |
| **[Cursor](https://cursor.com)** (Anysphere) | ✅ **Supported** — agent transcripts; the composer/sidebar threads are not read yet |
| [Amp](https://ampcode.com) (Sourcegraph) | ⬜ Not yet |
| [Aider](https://aider.chat) | ⬜ Not yet |
| [Goose](https://block.github.io/goose/) (Block) | ⬜ Not yet |
| [Qwen Code](https://github.com/QwenLM/qwen-code) (Alibaba) | ⬜ Not yet |
| [Amazon Q Developer CLI](https://aws.amazon.com/q/developer/) | ⬜ Not yet |

Every harness that is installed shows up at once — the colony is the union of all of them, and
an astronaut carries the name of the harness it belongs to.

### Adding one

One new file in `server/harnesses/`, one line in its `index.mjs`, and nothing else. The
interface is small and written down in full, along with the thread shape, the ground rules,
and how to find where a given harness keeps its sessions:

**→ [`server/harnesses/README.md`](server/harnesses/README.md)**

If you add one, a PR is very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) first, which is
honest about how much support I can offer. If landing it means editing the scanner or anything
under `src/`, please mention that: it means the seam needs widening, and I would rather fix that
than have you work around it.

## What you are looking at

| In the colony | In your threads |
| --- | --- |
| One hex zone | One repo. Bigger repos claim more tiles — one per seven threads, grown as a contiguous blob from the middle outward. A zone stays where it is: see below |
| One astronaut + one building | One session |
| How finished a building looks | How large its transcript is, on a log scale |
| Scaffolding | Somebody is at that site right now |
| Walking out of the ship | A thread that just appeared |
| Walking back into the ship | You archived it |

### A zone stays where it is

The map is only useful if you can learn it, so the layout is *sticky*. The previous
arrangement is an input to the next one: a repo that still needs the same number of tiles
keeps exactly the tiles it had, one that grew keeps them and claims neighbours, and one that
shrank gives back whatever it claimed most recently — so growing and shrinking again returns
a zone to precisely the shape it started in. Only a repo that has never been placed is
placed at all, and it takes the innermost tiles still free.

A zone's origin is its **root** tile rather than the centre of the tiles it happens to hold,
so gaining one does not drag its buildings, its crew and its name sideways; the new tile
simply appears alongside. And the arrangement is written to `data/colony.json`, so the map
you have learned survives a reload — including for a repo whose last thread you archived,
which comes back to the same ground when you start a new one.

The version before this was a pure function of the thread counts: one session appearing
anywhere changed the sort order, the order decided the tiles, and the whole colony re-laid
itself out. A zone you were watching could jump to the far side of the map because a
*different* repo gained a thread.

### The deck has to clear the ground

Inside the colony the terrain is gentle but not flat — it runs from about -0.3 to +0.24 on
the Moon, and half again as far on Mars. A deck's top face has to sit above the roughest
ground any plot can be dealt, or the ground comes through it: the slab reads as sunken, props
standing on it are buried to the waist, and every surface where the two meet tears. So the
slab is 0.45 tall, and everything on a plot — buildings, kerbs, clutter, boots — is measured
from that one number rather than from a height of its own.

Ground scatter has to miss the plots, and the order it happens in is the whole problem: the
world is built before the first roster arrives, so at that moment there are no plots to miss.
Boulders and trees would end up under decks laid on top of them afterwards, poking through in
fragments. The scatter is therefore rebuilt whenever a zone's footprint changes — cheap,
because it no longer drags the terrain mesh along with it.

Astronaut behaviour is a **strict precedence** rather than a set of independent flags, so a
thread can only ever be doing one thing. First match wins:

| Signal | What the astronaut does | Badge |
| --- | --- | --- |
| Errored | Slumps, red eyes, fault light stutters | `!` |
| Running now | Hammers away at its building, sparks fly | `⚒` |
| PR merged | Jumps, confetti, heart eyes | `✓` |
| Unread | **Stops and waits on you** | `?` |
| Nothing for 3 days | Sits down and sleeps, `z` bubbles | — |
| Anything else | Potters around its plot | — |

Only the states that want something from you get a badge. With most of a real thread list
sitting quiet, a symbol over every astronaut buries the one `?` that actually matters.

Zone names follow the same rule: a plot shows its name only while somebody there is working,
waiting or stuck. Everything else is nameless until you point at it. The plate itself is just
text over a soft halo with a small accent dot — no panel, no outline.

## Getting about

Astronauts route rather than drift. Buildings and the landing pad are rasterised into a
navigation grid whenever the roster changes, and the crew walks it with A*, string-pulled
afterwards so they take the corners they actually need instead of a visible staircase.

Two guarantees, deliberately independent:

- **Routing** finds a way *around* a building, including threading the gaps between a ring of
  them. Blocking radii are the building's bounding radius trimmed a little plus the
  astronaut's own width — the trim is what keeps those gaps walkable.
- **Collision** is applied to every step whether or not a path is being followed. Routing can
  fail — a site walled in between polls, a path budget that has not caught up — and walking
  through a wall must not be what happens when it does. Blocked head-on, an astronaut slides
  along the obstacle instead of stopping dead.

Measured over the live colony: 288 path legs, **0 crossing a building**, and **0 penetrations
across 78,000 agent-frames**. A typical path costs 6 µs (most are a clear straight shot and
skip the search); the worst frame when a poll invalidates every route at once is 0.6 ms.

They also push each other apart, so a busy plot is a crowd rather than a pile. That spacing
is measured against the widest thing an astronaut wears — the helmet, at 0.95 units — because
holding a crowd at less than that is a crowd standing *inside* itself, which is what the first
version did at 0.72. Arrival is derived from the same number and is deliberately larger: an
astronaut that had to get closer than its neighbours would let it could never finish arriving,
and would shoulder at the crowd for as long as its thread existed.

Standing spots are placed clear of the building's own blocked radius rather than at a fixed
distance from it, and checked against the navigation grid — a spot inside a wall is a spot the
crew can never reach, and the astronaut sent to it walks at that wall forever. Measured over
the live colony: **68 of 68 astronauts settled, nobody closer than 1.14 units, no standing spot
left inside an obstacle.** As a last resort an astronaut that has been blocked for six seconds
adopts the ground it got to instead of pushing on.

## Clicking one

All of the chrome is one panel on the right — the name, the counts, and every repo. There
is no top bar and no strip along the bottom: a colony is a place, and a place reads better
without a frame around it.

An astronaut, a zone's deck, the name plate over it, or a repo in that list — all four drill
into the same repo. Picking somebody is also picking the zone they are standing on.

**The repo**, at the top, whether or not anybody is selected:

- **New conversation** (`C`) starts a fresh thread in that folder. It is the same
  `claude://code/new?folder=…` deep link Finder's "New Claude Code Session Here" quick
  action uses, so the desktop app opens an empty session with the repo as its workspace —
  nothing is resumed and nothing is written.
- **Finder** (Explorer on Windows) opens the folder, **Copy path** copies it.
- Underneath, everything running in that repo, whoever wants something first. Clicking one
  flies to its astronaut and selects it.

**The thread**, when an astronaut is selected, in a card parked **beside that astronaut**
rather than in the panel: its face, title, worktree, branch, model, last activity, and how
far along its building is. The answer to "what is this one doing" belongs next to the thing
you clicked, so the card follows its astronaut around the screen — preferring its right,
flipping to its left rather than sliding under the sidebar, and never leaving the window.
It is moved with a transform rather than with `left`/`top`, the one geometric change a
browser makes without touching layout, so following a walking astronaut costs nothing.

- **Open** hands the thread back to whichever harness owns it and its app comes forward. On a
  Linux box with no desktop app to answer the deep link, a terminal opens with the CLI resuming
  the session instead.
- **Viewed** (`V`), on a thread that is asking for you, puts its hand down. The harness only
  counts a thread as read once it has been focused in its own app, so one you answered in a
  terminal waves for good. This records when you looked, and the thread starts asking again the
  moment it does something newer.
- **Archive** retires the thread *here*: the astronaut walks back up the ramp and boards the
  ship. Nothing is written to the harness — see [Keeping it local](#keeping-it-local). A thread
  you archive in the harness's own app goes home on the next poll too, because the scan reads
  that flag.
- **Hide** takes a whole repo off the map without touching a single thread. It comes back from
  the list at the foot of the sidebar, onto the same ground it left.

**Quiet repos fold away** by default: a repo where every thread has been silent for three days
comes off the map, which on a machine with a few harnesses and a lot of checkouts is most of
them. The sidebar keeps a count and a way back, and a repo returns to its own ground the moment
a thread in it wakes up. *Hide dormant repos* in settings turns it off.

Only one button in the panel is ever the accent colour: whichever action is the immediate
one. `Esc` steps outward a notch at a time — the thread first, then its zone.

Opening uses `claude://claude.ai/epitaxy/<local_…>`, which *navigates* the desktop app to a
thread it already has. `claude://resume` is the fallback for threads that only exist as a CLI
transcript: it *imports* the transcript, which creates a second untitled session and rewrites
the `.jsonl`, so it is only ever used when there is nothing to navigate to.

Archiving carries a deliberate one-writer discipline: the browser owns
`data/colony.json` and PUTs it whole, `/api/archive` only touches Claude Code's records. If
both wrote it, a save from a page holding older state would silently drop every archive made
since that page loaded. Claude Code also rewrites its session records from memory and can
stomp the flag, so the colony re-asserts it on every scan — an archive that gets stomped comes
back within one poll.

Nothing is ever written to your Claude Code data except that one `isArchived` field. The
folder buttons only ever hand a path to `open`.

The deep links above are the **Claude Code adapter's** business, not the colony's — another
harness plugs its own in, and a harness with no deep link simply greys the button out. See
[`server/harnesses/README.md`](server/harnesses/README.md).

Plots are keyed by the folder's *name*, which is all the colony needs to draw one, so the path
is read back off the threads standing there. Where a name is ambiguous — `~/workspaces/1/foo`
and `~/workspaces/2/foo`, which is what you get keeping parallel copies instead of worktrees —
it grows leftward until it is not, and you get `1/foo` and `2/foo` on separate ground. Only
names that actually collide change, because the name is also the key your saved layout is
stored under and disambiguating everything would move every plot on the map. A repo that has
moved or gone since the last scan fails at the server rather than handing `open` a dead path.

Name plates are hit-tested in screen space rather than raycast: they are billboarded in the
vertex shader, so a raycast would test the quad where it was authored rather than where it
ended up. That test deliberately ignores whether the plate is currently faded in — pointing
at where a quiet project's name *would* be is exactly what makes it appear.

## Getting around

Navigation is Google Earth's, including both of the things that make Earth feel like Earth:

| | |
| --- | --- |
| **Drag** | Grabs the ground. The point under your cursor stays pinned there for the whole drag |
| **Right-drag** (or ⌃ / ⇧ / middle-drag) | Tilt and rotate. Up tilts toward the horizon |
| **Scroll** | Zooms **at the cursor**, not at the screen centre |
| **Two fingers** | Pinch to zoom, drag to pan — both anchored between your fingers |
| **Arrows**, **+** / **−** | Move and zoom from the keyboard |
| **Orbit mode** (rail button, or `O`) | Earth's auto-rotate: a slow sweep around whatever is centred, about two minutes a revolution. It drives the heading only, so you can keep dragging, tilting and zooming while it runs |

Both anchors are exact, not approximate: a 200px drag holds its grabbed point to 0.00 world
units, and dollying 62→37 holds the cursor's point to 0.01.

Optionally, letting go can ease the *angle* back to the nearest clean isometric heading after
a couple of seconds. Your position and zoom are never touched — going home on its own would
fight you; tidying the angle after you stop does not. It is off by default, because a camera
that moves when you did not ask it to is startling the first time you meet it. Turn it on
under **View → Return to isometric**.

## Keys

| Key | Does |
| --- | --- |
| `H` / `⌘\` | **Hide every panel.** The colony still reads: status lives above the astronauts' heads |
| `S` | Settings |
| `N` | Fly to the next astronaut waiting on you |
| `Enter` / `A` | Open / archive the selected thread |
| `V` | Mark the selected thread viewed, so it stops asking |
| `C` | New conversation in the open zone's folder |
| `O` | Orbit mode |
| `Tab` | Next planet |
| `L` | Next time of day |
| `P` | Screenshot |
| `0` | Reset the view |
| `Esc` | Deselect, and close the zone sidebar |
| `?` | Help |

## Planets and light

Three worlds — **Luna**, **Mars**, **Terra** — and a full day/night cycle you can scrub, let
run, or set to **Live**, which follows this machine's own clock so the colony's light matches
the light out of your window. A planet is a bag of colours and two switches; terrain, scatter, sky and lighting all
read from the same preset, so a fourth world is a data change rather than a code change.

### The sky is the HDRI

Rather than shipping an HDR environment map, the sky shader **is** the environment map. A
second copy of the sky dome — sharing the same uniforms, so it is always the sky you are
actually standing under — is rendered into a prefiltered radiance map with `PMREMGenerator`
and bound as `scene.environment`. That is what gives metal something to reflect and
dielectrics a directional ambient, and it is why the colony changes *character* through the
day rather than just changing brightness: at dusk on Mars the panels pick up the sky, on the
Moon they stay hard and neutral.

It regenerates only when the sky has actually moved, and never more than a few times a second.
Measured cost: **0.16 ms/frame**. Off on Potato and Low; the intensity is a slider.

Materials are properly PBR underneath it. Roughness and metalness are looked up per atlas
cell, so a single merged building geometry holds painted panel, brushed metal and
photovoltaic glass and each behaves correctly — the ten building recipes never had to learn
about PBR.

### The sun is not overhead

The solar arc is tilted, so noon puts the sun 54° above the horizon and off to one side rather
than at the zenith. That is load-bearing rather than decorative: a sun directly overhead puts
`N·L` at zero on every vertical wall in the colony, and they go black with only ambient to
catch. The old procedural buildings were curved enough to hide it; a kit of flat-walled
modules is not.

### HDR and bloom

Eye colours, lamps, windows, crop rows and plot kerbs are all authored above 1.0 so the bloom
pass picks them out. The threshold is deliberately high (0.92) — only those things clear it,
so lit surfaces stay crisp instead of going hazy.

## Where the art comes from

The colony is built out of CC0 asset packs — three by **[Kay Lousberg](https://kaylousberg.com)**,
one by **[Kenney](https://kenney.nl)** and one by **[Quaternius](https://quaternius.com)** —
plus the project's own shaders on top of them.

| Pack | Used for | Licence |
| --- | --- | --- |
| [KayKit : Space Base Bits](https://kaylousberg.itch.io/space-base-bits) | Every building on most worlds, the landing pads, rovers, and the crates and drums stacked around each plot | CC0 |
| [KayKit : Character Animations](https://kaylousberg.itch.io/kaykit-character-animations) | The crew's body and all fifteen animation clips they play | CC0 |
| [KayKit : Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) | Terra's trees, bushes and grass, and the boulders on every world | CC0 |
| [Kenney : Space Kit](https://kenney.nl/assets/space-kit) (v1.0) | Karak's hangars, dishes, machines, the rocket, and the parked speeders | CC0 |
| [Quaternius : Ultimate Space Kit](https://quaternius.com/packs/ultimatespacekit.html) | Karak's dome, houses and masts (fetched via the [poly.pizza mirror](https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX)) | CC0 |

CC0 asks for nothing, but crediting the artists costs nothing either. If you rebuild the
assets, the packs go in `assets-src/` (see below).

Two things about Space Base Bits make the whole approach work. It is **modular** — a habitat is
a base module with a roof module on it, a workshop is the garage variant with a rover parked
outside — which is why ten building recipes fit on one screen. And all forty-four models share
**one 1024px gradient atlas**, so a nine-part greenhouse still merges to a single geometry and a
single draw call, exactly as the procedural generators it replaced did.

That atlas is an 8×4 grid of swatches, which turns out to be a useful thing to have. A *cell
index* is a stable name for a material, so the building shader can:

- **repaint one swatch into the repo's accent.** Kay's gold trim band is cell 11; the fragment
  stage swaps its hue while keeping the swatch's own light-to-dark gradient, so every plot's
  buildings wear that plot's colour with no extra material and no extra draw.
- **light that same swatch after dark**, which is what makes the window strips come on at night.
- **give one flat texture real PBR.** Roughness and metalness are looked up per cell, so the
  grey structural swatch behaves like painted metal and the photovoltaic swatch like glass.

The Forest pack does double duty. Its boulders are painted neutral grey, which means a
per-instance tint takes exactly the same rock to lunar dust or Martian rust without touching
the atlas — so one scatter recipe dresses a meadow and a crater field. Only sixteen of its 105
models are packed: variety comes from per-instance scale and rotation, and packing every size
and colour variant would be five times the file for no more to look at.

Karak builds in its own kit, and that one is *made* to fit the convention rather than born in
it. Kenney's models ship as flat per-material colours and Quaternius' UV into a pixel-palette
PNG — so `tools/build-desert-kit.mjs` classifies every triangle of both into six desert
swatches (plaster, clay, shade, metal, terracotta trim, glass), paints a gradient atlas of its
own in the same 8×4 grid, and rewrites the UVs to match. Out the far end they behave exactly
like a KayKit pack: one material, one draw call per building, a trim cell that takes the
accent and lights up at night.

### The surfaces are drawn, not shipped

The plot decks and their kerbs can't be textures from a pack, because they have to take each
repo's accent colour and a painted texture cannot. `world/surfaces.js` draws them to a canvas
at boot instead — a plated metal floor of bolted panels, and a kerb broken into dashes that
reads as runway edge lighting rather than a glowing bar. Both are authored neutral grey so the
material's colour multiplies through cleanly, and both come with a **normal map derived from
their own height field** by Sobel. That relief is doing most of the work: on a surface this
large and this flat, a flat albedo pattern under one directional light reads as wallpaper,
where a seam that catches a shadow along one edge and a highlight along the other reads as
metal.

Both surfaces needed their UVs rebuilt, and both for the same underlying reason: a generated
primitive's unwrap is made for the primitive, not for what you draw on it.

A hex tile is a six-sided cylinder, and a cylinder's cap UVs are a *disc* — which turns a tiling
plate pattern into a medallion, one per tile. The deck's **top** is therefore reprojected from
world XZ, so the seams run straight across a whole plot and seven cells read as one apron. Its
**rim** keeps the cylinder's own side unwrap, which is the one thing that works: a fixed
horizontal axis like `x + z` is *constant* along two of every six sides, leaving those faces
with no UV gradient, a degenerate tangent and — since three builds the normal-mapped shading
frame out of that — solid black; and arc length from `atan2` fixes the gradient but adds a seam
where the wrap crushes a dozen repeats into one panel. The generated unwrap has neither problem,
because it duplicates the vertices at the seam.

A kerb bar is a box, and a box hands all six faces the same 0..1 square, so the dash strip was
stretched down the sides and across the ends as well — which on a bar 14cm tall squashed the
dark gaps between dashes into what read as a solid black edge, worst where six of them gather at
a plot corner. Only the upper face points at the strip now; the rest point at a patch of flat
colour on the same texture.

### Rebuilding them

`npm run assets` packs the raw packs into the glbs the app loads. The built files are
checked in and the raw packs are not, so this is a no-op unless you have fetched them:

```bash
mkdir -p assets-src && cd assets-src
# download the FREE tier of the KayKit packs from the links above, then unzip in place
mkdir -p downloads   # the desert kit's two packs go here:
#   downloads/kenney_space-kit/       — Kenney's Space Kit zip, unzipped in place
#   downloads/quaternius-selected/    — the Quaternius models Karak uses, one .glb each
```

`npm run assets` runs `tools/build-assets.mjs`, which drives `build-kit.mjs` once per KayKit
pack — merging a directory of single-model `.gltf` files into one document with one material
and one texture — then `build-desert-kit.mjs` (the classify-and-repaint pass described
above) and `build-crew.mjs`. That last one keeps the fifteen clips the colony actually plays out of
KayKit's 161 and — the part that matters — **retargets every animation channel onto the
mannequin's own bones**. Merging glTF documents brings each animation file's private copy of the
rig along with it, so without that step the finished file has five skeletons named `hips` and
the clips drive the four nobody is looking at. It loads without a single warning and renders the
entire crew frozen in its bind pose.

## Animating the crew

The bodies are hand-animated clips, and hand-animated clips are not instanceable: three skins a
`SkinnedMesh` from a `Skeleton` object, one per character, which for three hundred threads means
three hundred draw calls and three hundred skeletons stepped on the CPU every frame.

So the animation is **baked once, at load, into a bone-matrix texture**. Every clip is sampled at
30 fps and each frame's twenty-one skinning matrices are written into a float texture — 84×723
texels for the whole set. One `InstancedMesh` then carries the entire crew, and each astronaut
reads its own row of that texture from a single per-instance float: the frame it is on. Skinning
happens in the vertex shader, upstream of three's own instancing, so the skinned vertex still
goes through `instanceMatrix` and the crew stays one draw whether there are six of them or six
hundred.

Everything the crew *wears* stays procedural and stays the colony's own: helmet, visor,
screen-face, backpack, antenna and lamp. Those are pinned to bones the cheap way — the bake also
writes the head and chest world transforms into a small array on the CPU, so placing a helmet is
one matrix read rather than a skeleton evaluation, and a helmet can never be a frame out of step
with the head under it.

Behaviour maps onto clips directly, and locomotion wins over status — an idler pottering across
its plot walks rather than hammering while it slides:

| Behaviour | Clip |
| --- | --- |
| Running now | `Hammering` |
| Waiting on you | `Waving` |
| Errored | `Hit_A` |
| PR merged | `Cheering` |
| Nothing for three days | `Sit_Floor_Down` → `Sit_Floor_Idle`, and then it holds still |
| Anything else | `Idle_A`, or `Walking_A` / `Running_A` while moving |

The clip is chosen from the distance an astronaut **actually covered** last frame, not from
the velocity it meant to have. The two come apart the moment something is in the way:
collision refuses the step while velocity stays high, and an agent driven off intent alone
walks on the spot against a wall. The measure rises instantly and falls over a tenth of a
second — so setting off is caught on the frame it happens and nothing ever slides in a
standing pose, while a stride still gets to finish instead of freezing mid-step.

Movement is shaped to match. A wander leg is walked at a decisive pace and stops dead on
arrival rather than easing down through the speeds no standing clip can carry, and a leg that
runs into the side of a building is abandoned at the first refused step. Measured across a
live colony over a minute: **0.4% of agent-frames** disagree with what the body is doing, none
of them by more than 0.12 m/s.

Stride playback follows actual ground speed, so short steps cannot moonwalk. An *idler*
potters around its plot; a *sleeper* does not — it sits where it sat, and the only thing that
can move it is being pushed out of someone it is overlapping, which converges and stops. The
alternative is a cross-legged astronaut sliding across the deck, standing up to walk two
metres, and sitting down again every few seconds.

Clips that do not loop are baked a millisecond short of their own duration. Sampled at exactly
`duration` the mixer's default loop mode wraps to the start, so the frame a sit-down or a spawn
*holds* would be the pose it began from — and the astronaut snaps upright on the last frame of
sitting down.

The crew also stands on the ground rather than on `y = 0`. A plot's tiles are a raised slab
and the terrain between plots rolls half a metre either way, so a fixed height buries them for
a good part of the colony. `Colony.groundAt()` answers with the deck height when a point is
over an allocated hex cell — an exact axial lookup, not a nearest-centre radius test — and the
terrain field otherwise. It is sampled only when an astronaut has actually moved, and eased
into, so walking up onto a deck reads as a step rather than a teleport.

## Performance

Five presets from **Potato** to **Ultra**, and every knob underneath them is individually
adjustable. A dot next to a setting means you have moved it away from its preset.

The knobs that actually matter, and why:

- **Render scale** is the biggest lever there is. The drawing buffer is sized directly rather
  than through `setPixelRatio`, which cannot usefully go below 1 on a retina panel. It is a
  share of *your display's own resolution*, so 100% is native on a retina panel and native on
  a 1× one. Reading it as CSS pixels — which is what it used to do — quietly rendered every
  retina machine at half resolution, and the first place that shows is the small stuff that
  holds a constant size on screen: the badge glyphs and the zone name plates, which magnify
  hardest exactly when you lean in to read them.
- **Adaptive quality** watches the frame time and quietly scales *under* whatever you chose,
  one step per second — a governor that reacts per frame makes the resolution visibly breathe.
  Its floor is relative too: half of what your display can show, not half a CSS pixel.
- **HDR + bloom** off doesn't just skip the pass, it disposes the composer's float render
  targets. Turning it off on a weak machine gives the memory back.
- **Shadows** track the camera rather than covering the whole colony, which is worth roughly a
  doubling of effective resolution.

What keeps it cheap at rest:

- The crew's animated bodies are a single instanced, GPU-skinned draw, and each worn part —
  helmet, visor, face, pack, antenna, lamp — is one `InstancedMesh` across the whole crew. The
  sixty-fifth astronaut costs a matrix write and one float, not a draw call. Per-agent suit
  colour, eye colour and facial expression ride along as instanced attributes.
  Measured on a live colony: **66 astronauts and 66 buildings in 105 draw calls**.
- Each building merges into a single geometry, and construction progress is a shader offset
  rather than a rebuild, so a building rises out of the ground without touching a vertex
  buffer. It sinks the structure and discards what falls below the deck rather than slicing
  the top off, so a half-built one is a *whole* building partly buried — cutting instead
  guts a kit of closed shells, and a two-thirds-finished biodome becomes an empty ring.
- Terrain is displaced and vertex-coloured once at build time; the GPU only ever sees static
  geometry.
- Particles live in flat typed arrays and are swap-removed on death — no allocation during play.

### Things that hold their size on screen

Badges and name plates are deliberately near-constant on screen, which inverts the usual
texture problem: they are *minified* when you pull the camera out and *magnified* when you
lean in, and the close end is the one that hurts. Both are sized for the closest you can
get — the badge atlas gives each glyph a 128×256 cell, a plate is drawn at 4× — so at the
tightest zoom on a retina panel there is still about one texel per device pixel, and mipmaps
plus anisotropy carry the far end where a plate is sixty pixels tall and would otherwise
crawl. Everything in both is drawn from paths, so the only cost of more texels is memory.

## The faces

Each visor is a little rounded screen — the patch is a rectangle in UV space, so its rounded
silhouette is cut in the fragment shader with a rounded-box SDF, which gives soft corners a
rectangular patch can never have and lets the white helmet show through where the screen ends. All sixteen expressions are drawn once into a single 4×4
canvas atlas as a white-on-black **mask** — never as finished artwork — and the colour arrives
per-astronaut at draw time, so one 512px texture gives every agent its own eye colour without
a second byte of memory. The shader reads the mask out of the red channel, blends between the
dark screen and that astronaut's glow, and adds scanlines and a vignette so it reads as a
screen rather than a decal.

They blink on their own clocks, so a crowd never blinks in unison.

## A note on which side gets drawn

The ship is procedural, and its bowls, engine bells and airlock collars are **open shells**.
Two things bite there: single-sided rendering lets you look straight through them, and a
one-sided bowl cannot shadow-map — from the sun its concave interior is a back face at exactly
its own depth, so it self-shadows to solid black whichever cull mode the depth pass uses. So
the ship draws double-sided with a `BackSide` shadow side.

The buildings want the exact opposite, and for the exact opposite reason. The model kit's
pieces are **closed solids**, so there is nothing to see through — and being closed is why they
must not be drawn double-sided. They are modelled as stacked boxes, which leaves a floor and
the ceiling underneath it sharing a plane all over the kit: a landing pad and the lander
standing on it put 38 up-facing and 17 down-facing triangles at one height, and a habitat has
two such planes, a lab four. Drawn double-sided, both halves of every one of those pairs
rasterise at identical depth and the winner is settled by floating-point noise — which is a
whole colony of surfaces flickering as the camera moves. Back-face culling throws the downward
half away before it can fight, so buildings render `FrontSide`.

Worth knowing if you add a kit: the tell is that *every* clash is an up/down pair. Not one is
up/up, which is what makes culling a complete fix rather than a partial one.

## Turning things

Turbine rotors spin in the **vertex shader**, not as child meshes, so a turbine is still one
merged geometry and one draw call. Each spinning vertex carries the hub it turns about and how
fast, which is what lets one building hold several of them, and one uniform write a frame turns
every rotor in the colony. The tower is taken from the kit *solo* — without the sub-node the
pack names separately — precisely so the rotor can be put back on as a part that moves.

Two things to watch if you add another: `BufferGeometry.scale()` transforms position and normal
and nothing else, so an attribute that holds a *position* has to be scaled by hand or the blades
orbit a hub left behind at the unscaled height. And the shadow pass needs the same rotation, or
the blade's shadow lags the blade.

## Keeping it local

The server reads your agent transcripts and can ask the OS to open things, which makes it a
more interesting target than a localhost toy usually is. Three things hold it in:

- **It binds `127.0.0.1`.** Nothing outside the machine can reach it, unless you deliberately
  change that — see below.
- **It checks `Host`.** Binding to loopback is not on its own enough. An attacker who points
  a domain they control at `127.0.0.1` — DNS rebinding — reaches the server *as a same-origin
  page* and can then read every reply. Those requests still arrive carrying
  `Host: their-domain`, and are refused.
- **It checks `Origin`.** A cross-site `fetch` with a `text/plain` body is not preflighted, so
  without this any page you happened to have open could POST here — spawning sessions, opening
  Finder windows, or overwriting the colony layout — even while unable to read the response.
  Requests from anywhere but this server's own page are refused.

The practical cost: a bare `curl` POST is refused too, since browsers always send `Origin` on
POST and its absence means the caller is not the page. Add `-H 'Origin: http://localhost:5274'`
if you are scripting against the API.

### Serving it to your network

`BOT_CROSSING_HOST` changes what `npm run serve` binds to, so you can watch the colony from a
tablet on the sofa:

```bash
BOT_CROSSING_HOST=0.0.0.0 npm start
```

**Understand what that hands out before you do it.** The two checks above stop a *web page* from
driving the server; they are not access control, and they do nothing about another device asking
directly. Anyone who can reach the port gets every thread title, every opening prompt, every
working directory and branch — a fairly complete picture of what you have been working on — plus
the ability to open threads, reveal folders and start sessions on your machine. There is no
password, because there was never meant to be anything to guard.

Fine on a network you own. Not something to leave running on café wifi, and worth remembering
that a machine on a VPN or a mesh network is reachable by everything else on it too.

What it touches on disk, in full:

| | |
| --- | --- |
| Reads | Your harness's own session records and transcripts |
| Writes | `data/colony.json`, and **one** `isArchived` field per archived thread |
| Sends | Nothing. No network calls, no telemetry, no account |

`data/colony.json` holds the names and paths of the repos you work in, so it is gitignored —
worth knowing before you copy one into an issue.

## Layout

```
server/
  harnesses/   one adapter per agent harness — README.md is the contract
    index.mjs    the registry: add your harness to the list here
    claude-code.mjs
  lib/         filesystem helpers the adapters share
  scan.mjs     harness-agnostic: asks every detected harness, merges, sorts
  api.mjs      /api/threads, /api/harnesses, /api/state, /api/open, /api/archive,
               /api/new-session, /api/reveal
  serve.mjs    static server for the built app
src/
  core/        settings, renderer + post chain, the Google Earth camera
  world/       planets, terrain, sky, hex plots, the model kit, buildings, the ship
  agents/      the crew rig and its bake, instanced astronauts, faces, badges, particles
  game/        threads → colony, and the API client
  ui/          the HUD
tools/         asset packers — raw packs in, the three glbs the app loads out
public/assets/ spacebase.glb, crew.glb, forest.glb
```

Everything that knows what a *particular* harness's files look like lives in
`server/harnesses/`. Everything else — the scanner, the API, the whole of `src/` — is written
against the thread shape and never against a harness.

Colony state lives in `data/colony.json` — where each zone sits and what you archived.
Deleting it only loses the archive list and the map's arrangement; the threads themselves are
untouched, and the colony lays itself out again from scratch.

## Building your own

Bot Crossing is one shape this idea can take. `.claude/skills/agent-session-world/` is a skill for
building the others — fish in a reef, animals in a forest, villagers, ants, boats in a harbour.
Whatever inhabits it, the structure underneath is the same: a layout that stays put so you can
learn the map, one draw call for the whole crowd, a single source of truth for what a thread is
doing, and a camera with weight.

It is written to take somebody's idea and fill in the frame around it, rather than to reproduce
this particular colony. Four reference files carry the detail, and stand on their own whether or
not you build anything like this:

- [making it feel alive](.claude/skills/agent-session-world/references/making-it-feel-alive.md) —
  ambience and interaction, written to translate into any metaphor
- [rendering traps](.claude/skills/agent-session-world/references/rendering-traps.md) — the
  graphics problems in roughly the order you meet them
- [harness adapters](.claude/skills/agent-session-world/references/harness-adapters.md) — reading a
  coding agent's sessions without disturbing them
- [asset pipeline](.claude/skills/agent-session-world/references/asset-pipeline.md) — decent art
  without an artist

## Who made this

Built by **[Jarren Rocks](https://jarren.rocks)**, mostly as a side effect of building
**[Emra](https://emra.app)** — which is where most of the threads in the screenshots come from,
and why a tool for keeping track of a lot of them at once existed in the first place.

## Licence

[MIT](LICENSE) © Jarren Rocks. Do what you like with it — including forking it, which
[CONTRIBUTING.md](CONTRIBUTING.md) explains is a first-class option rather than a last resort.

The art is not mine. Three CC0 packs by **[Kay Lousberg](https://kaylousberg.com)** — [Space
Base Bits](https://kaylousberg.itch.io/space-base-bits), [Character
Animations](https://kaylousberg.itch.io/kaykit-character-animations) and [Forest Nature
Pack](https://kaylousberg.itch.io/kaykit-forest) — are built into the `.glb` files in
`public/assets/` and are covered by [CC0](https://creativecommons.org/publicdomain/zero/1.0/),
not by the MIT licence above. CC0 asks for nothing; crediting Kay costs nothing either.

The status badges above each astronaut's head are
[Material Design Icons](https://pictogrammers.com/library/mdi/), bundled via `@mdi/js` and
licensed [Apache-2.0](https://github.com/Templarian/MaterialDesign/blob/master/LICENSE).

Everything else you see — the shaders, the terrain, the sky, the ship, the crew's helmets and
faces, the plot decks and their kerbs — is drawn by this project and is MIT along with the code.

Not affiliated with Anthropic, OpenAI, Google, or any of the other harness vendors listed above.
