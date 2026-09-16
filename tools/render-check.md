# Rendering regression check

Run `npm run dev`, then open `/tools/render-check.html` on the displayed local URL.
Wait for the final `complete: true, passed: true` result. This uses synthetic threads;
it never fetches harness data or saves settings/colony state.

The browser check needs real WebGL2. It covers:

- Pixel-identical status badges and project labels with tilt-shift disabled versus 20%/100%
  strength and a tilted focal plane, over sky, focused geometry, and distant geometry.
  Both composer buffer parities are checked, and a separate world object must still blur.
- Consecutive frozen frames on Archipelago, Luna, and Terra at Low through Ultra.
- Pan/orbit/zoom sweeps on Archipelago at Balanced, High, and Ultra, plus Terra at Balanced.
  It reads each offscreen post-processing target as half floats and checks for NaN/Infinity.
  If one occurs, it hides scene groups in turn to isolate the first invalid scene pixel.
- Deferred canvas resize and adaptive quality changes, including whether the last rendered
  frame survives until the next draw.
- A small rendering-only benchmark at 1280×800. Timings include GPU synchronization but
  exclude simulation and the HDR readbacks. They are not the live colony's frame rate.

`npm test` also checks resize scheduling, preserving adaptive resolution on focus/window
resize, restoring the requested resolution, and sizing a newly enabled composer.

## Black-block regression in PR #53

Grass used `pow(vHeight, 1.2)`. At grazing angles, interpolation can put a root's height
slightly below zero. The resulting NaN starts in the scene render, then spreads through
the bloom pyramid and depth-of-field passes. A frozen camera may never hit the problem.

Before clamping the height, the Archipelago sweep produced an invalid RGB pixel at
camera `[13.0714, 14.8, -40.2297]`, pixel `(529, 84)` in a 640×400 buffer. Hiding grass
removed it; hiding water did not. Bloom spread those three NaN channels across its output.
The exact pixel is GPU-dependent; checking finite HDR output across camera movement is
the regression, not matching a screenshot of that coordinate.

## Overlay depth-of-field regression

The overlay pass originally ran between bloom and tilt-shift. Badges do not write depth,
so the blur sampled the depth of whatever house or sky was behind each badge. Drawing
overlays after both tilt-shift passes keeps them sharp while retaining tone mapping,
colour grading, and antialiasing. The check uses black geometry to change background depth
without changing its colour: any changed overlay pixels then reveal blur contamination.
