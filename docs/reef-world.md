# The reef

A second world for the colony, built with `.claude/skills/agent-session-world`. Same
structure as the Moon — territories on the hex lattice, one structure per thread, an arrival
point, the six states — in a different costume. Pick it with Tab or from the planet picker
in Settings; switching is live and keeps every zone on the cells it already had.

## The concept, as agreed

| Question | Answer |
| --- | --- |
| What lives here | Reef fish, one per thread. Species and colour are hashed from the thread id, so a thread is the same fish every time. |
| The setting | Shallow, sunlit seabed. Rippled sand, caustics, marine snow, light shafts, thick blue-green haze. Night is deep navy with bioluminescence. |
| A project's home | A shelf of reef rock on the hex lattice, washed in the repo's colour, with a glowing coral crust round its edge and anemones where the lamp posts were. |
| Working | Nose down at the sand by its coral, kicking up sediment. The sediment cloud is the prop you can read from across the map. |

## The mapping

| Thread state | Fish |
| --- | --- |
| Errored (`blocked`) | Lists onto its side near the bottom, colour drained, red pulse |
| Working | Nose down at the sand, tail up, sediment |
| Finished well (`celebrating`) | Loops the loop, flashes at the top, glitter |
| Waiting on you | Rises toward the surface, turns to face the camera, a column of bubbles visible through everything, `?` badge |
| Untouched for days (`sleeping`) | Rests on the sand, colour dulled, an occasional bubble |
| Anything else | Mills about its shelf at cruising height |

Arrival and departure are the wreck: new threads swim out of the hatch, archived ones swim
back in. The hatch lamp brightens while it is in use, like the lander's ramp.

A thread's structure is a coral colony seeded from its id (`createCoral` in
`src/world/reef.js`): boulder, staghorn, table or sea fan, in the repo's accent, with the
tips glowing after dark. It rises out of the sand with the same sink-and-discard shader the
buildings use, so a half-grown coral is a whole coral partly buried.

## Where things live

- `src/world/reef.js` — corals (scatter kinds and per-thread colonies), the wreck, light
  shafts, and the three shared shader ideas: caustics, sway, bioluminescence.
- `src/agents/fish.js` — the school. One instanced draw for every fish (the swim is a sine
  wave in the vertex shader, two floats per instance) and one for the bubble columns. Same
  interface as `Astronauts`, so the colony does not know which it has.
- `src/world/planet.js` — the `reef` preset (`underwater: true`, `scatter: 'coral'`), sand
  ripples in the height field, caustics on the terrain.
- `src/world/sky.js` — the underwater dome: bright surface overhead, haze at the horizon, a
  wobbling sun, no stars.
- `src/world/plots.js` — `style: 'reef'` on `Plot`.
- `src/game/colony.js` — `_buildInhabitants` / `_switchBiome`: picks fish or crew, wreck or
  lander, coral or building, and replays the roster when the world changes under it.

## Numbers from the headless check

Balanced preset, 24 threads, 9 repos, software rasteriser:

| | Moon | Reef |
| --- | --- | --- |
| Draw calls | 172 | 169 |
| Triangles | 647k | 285k |
