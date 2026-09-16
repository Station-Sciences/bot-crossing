# Ambient occlusion review

Use **Settings → Look → Ambient occlusion** in the running colony. The slider ranges from Off to 100%; Balanced, High and Ultra start at 25%, while Low and Potato keep it off. Existing saved Low/Potato settings retain that choice. The value updates immediately and persists with the other settings.

The effect adds subtle shading in creases and at contact points, particularly the suit panels, wrists, feet, building bases and roof trim. It uses the scene's existing depth, including the bots' actual animation and world curvature. It runs before bloom and tilt-shift, with readable badges and labels drawn afterward.

Implementation: a fixed 16-sample depth kernel, normals reconstructed from nearby depth on the same surface, a small Gaussian soften, and a single-channel 8-bit target. Two fullscreen draws, no extra geometry pass and no temporal noise/history. The pass multiplies into the existing scene buffer without swapping its depth attachment. At zero, both draws are skipped and its target is freed; if all other effects are off, the composer is freed as well.

## Comparisons

- [Crew: Off vs 25%](crew-off-vs-25.png)
- [Building: Off vs 25%](building-off-vs-25.png)
- [Interactive review](http://127.0.0.1:5275/tools/occlusion-check.html) has an independent slider and Off/25%/100% buttons. It does not change saved colony settings.

## Validation

All 63 Node tests pass, including buffer ownership, releasing resources at zero, AO-only postprocessing, renderer state restoration, preset migration and render-only setting changes. Vite production build passes with the existing bundle-size warning.

The [browser report](validation.json) verifies visible shading, identical frozen frames across buffer swaps, exact restoration at zero, unchanged flat ground/sky, finite HDR values during camera movement and resize, and operation alongside depth of field. AO-only mode also enables and releases the composer correctly. No WebGL errors were observed. The small-scene timings are noisy and should not be treated as a hardware-wide performance estimate.

The full colony rendering check also completed successfully: three planets across four quality presets, camera movement on Archipelago at Balanced/High/Ultra and Terra at Balanced, unchanged readable overlays, and adaptive resizing.

This is screen-space contact shading: it accents visible creases rather than replacing the scene's directional shadows or material lighting.
