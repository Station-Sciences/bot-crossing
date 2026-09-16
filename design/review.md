# Colony rendering and crew review

The crew retains the original KayKit body with a new round helmet. A curved CRT sits
behind the glass with an air gap, stronger filtered scanlines, lower expressions, one
rounded white ear on each side, and a white antenna with its light centered on the tip.
The visor reflects nearby scenery through a shared, gradually refreshed cube capture.

Walking agents alternate happy eyes, smiles, silent whistling mouths, and left/right
glances. Each agent has its own timing. Arrival restores the destination status, and
blocked/error states retain priority. The walking sequence contains no wink.

## Visual review

These are screenshots of the implemented models rendered in Three.js.

- [Current head detail](agent-model-drafts/head-detail-latest.png)
- [Status expression sheet](agent-model-drafts/character-face-sheet.png)
- [Walking expression sheet](agent-model-drafts/walking-face-sheet.png)
- [Alert expression before](agent-model-drafts/expression-alert-before.png) and
  [after](agent-model-drafts/expression-alert-after.png)
- [Scenery reflection comparison](agent-model-drafts/scenery-reflections-comparison.png)
- [Ambient occlusion: crew/building comparisons and validation](ambient-occlusion/README.md)

Ambient occlusion defaults to **25%** on Balanced, High, and Ultra. Low and Potato
leave it off. **Settings → Look → Ambient occlusion** adjusts it immediately from
Off to 100%; the choice persists. At zero its extra target is released.

**Settings → View → Follow selected agent** is an optional saved preference, also
available from the crosshair button on an agent's card. Selecting an agent glides the
view toward them without changing zoom or angle. Following preserves subsequent pan
offsets, orbit, wheel zoom, and touch pinch gestures. Deselecting or disabling the
option stops tracking; selecting another agent transfers it. Reset view and flying to
a project deselect the followed agent. Return-to-isometric easing pauses while following.

Camera centering uses the space beside the visible sidebar (or above the phone sheet),
and returns to the full viewport when the UI is hidden. The world target, pan offset,
orbit angle, and zoom are preserved. Settings replaces the main sidebar in the same
slot without shifting it; covered controls are excluded from keyboard focus.

## Other corrections

- Clamp grass shader inputs to prevent NaN pixels spreading into black blocks through
  bloom while orbiting, panning, or zooming. Resize drawing buffers immediately before
  drawing and preserve adaptive resolution across focus/resize events.
- Draw notices and labels after bloom and tilt-shift so background depth cannot blur them.
- Select the whole animated agent, including hands and boots.
- Query each navigation obstacle once, clear work sites after rebuilding navigation,
  and avoid short walking paths through buildings.
- Keep buildings, loose props, and scaffold feet inside the hex deck. Delivered packages
  bounce against building surfaces and can slide off roofs rather than falling through them.
- Use fuller grass tufts and grouped foliage within the existing rendering budgets.

## Validation and local review tools

All **72 Node tests** pass, including camera follow motion/elevation, pan and zoom
anchors, orbit, touch pinch, switching targets, deselection, saved preferences,
sidebar-aware projection/raycasting, and off-center depth-of-field reconstruction.
The production build passes with the existing chunk-size
warning. Browser checks covered finite HDR output during camera movement on Archipelago
at Balanced/High/Ultra and Terra at Balanced, frozen-frame stability on three planets
across four presets, sharp notices, resizing, and AO buffer ownership. No WebGL errors
were observed in those checks.

Whole-body selection passed 9,184 posed-vertex checks. The three-minute synthetic colony
fixture found no off-deck buildings/props/scaffolds or blocked work sites; package drops
landed on roofs without detected penetration. Brief crowd corrections remain possible.
Package motion uses lightweight surface collisions, not full rigid-body stacking.

Run `npm run dev`, then open these paths on the displayed local server:

| Path | Purpose |
| --- | --- |
| `/tools/face-sheet.html` | Status expressions |
| `/tools/face-sheet.html?walking` | Walking expressions and glances |
| `/tools/model-check.html?walking&lighting=planet` | Animated model and arrival transitions |
| `/tools/occlusion-check.html` | Off/25%/100% contact shading and runtime verification |
| `/tools/reflection-check.html` | Actual scenery reflection response |
| `/tools/render-check.html` | HDR, camera movement, overlays, and resizing |
| `/tools/visual-check.html` | Navigation, deck containment, and package motion |
| `/tools/picking-check.html` | Selection across poses and zoom levels |
| `/tools/bot-showcase.html` | Three seated agents with a rotating portrait camera |

The fixtures use synthetic agents and do not read live thread data or save colony
settings. [Recording instructions](../tools/bot-showcase.md) reproduce the silent
22-second 1080×1920 showcase; local video outputs stay in the ignored `recordings/` folder.
