# Visual and movement checks

Start `npm run dev` and open `/tools/visual-check.html`. This page uses 42 synthetic
threads, three projects, Balanced graphics, and a seeded movement RNG. It does not
read the harness API or save colony/settings state.

The initial run simulates three minutes of activity. The report checks:

- Every building vertex against the actual hex deck, plus loose prop footprints and scaffold feet.
- Work sites against the completed navigation map and wall clearance.
- Stopping at the final waypoint without retaining walk velocity.
- Repeated movement with little net displacement, including a separate count after arrivals.
- Waiting crew playing a walking animation after arriving.
- Delivered parcels landing above ground on roofs and parcel centres entering building surfaces.
- CPU update timing (excluding diagnostic work and drawing), grass and foliage counts.

The links repeat this on Archipelago, Terra, and Luna. Buttons show an overview,
a close-up with four package drops, and night lighting. `/tools/render-check.html`
separately checks HDR values during camera motion, quality presets, and buffer resizing.

`/tools/picking-check.html` checks whole-body selection against animated bone positions
and sampled skinned vertices across six poses, three zoom levels, and both world-curve
settings. It also checks overlapping agents, hidden instances, and badge selection.
The final close-up accepts pointer clicks, including either boot, without reading the
harness API or saving settings. Local validation passed all 9,184 checks.

Local validation on 2026-09-16: the 42-building fixture had no off-deck geometry,
props, or scaffold feet and no blocked work sites. Archipelago and Terra delivered
packages onto roofs without detected penetration. Waiting crew stayed still after
arriving. There can still be isolated brief crowd corrections; the jitter counter
is a heuristic and is not a guarantee of zero movement artifacts in every layout.

Package motion remains lightweight surface physics, not a full rigid-body engine.
Roof raycasts account for construction height and slopes; spinning turbine blades
are excluded as supports. Packages bounce and can slide/fall off ledges, but do not
stack on other packages. No extra physics dependency or rendering pass is added.
