# Sound samples

Everything the colony can play has a procedural fallback in `src/audio/synth.js`, so this
folder can stay empty. Real recordings sound better, and they slot in by name:

1. Drop `.wav` / `.mp3` / `.ogg` files in here.
2. Write a `manifest.json` next to them:

```json
{
  "sounds": {
    "surf":       { "file": "audio/surf.wav",  "gain": 0.9, "loop": true },
    "gull":       { "file": "audio/gull.wav",  "gain": 1.0, "loop": false },
    "work-hammer":{ "file": "audio/hammer.wav","gain": 0.8, "loop": true, "trim": [0.1, 3.9] }
  }
}
```

The names are the ones in `src/audio/sounds.js`. A name that is not in the manifest, or whose
file fails to load, falls back to its synth. Beds (`loop: true`) should loop cleanly; `trim`
cuts a `[start, end]` window in seconds.

This folder is gitignored apart from this file, because sample libraries — Splice included —
license their sounds for use *in* a work, not for redistribution on their own. Sounds under
CC0 are fine to commit; add them to `CREDITS.md` if you do.
