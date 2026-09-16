# Portrait bot recording

Open `/tools/bot-showcase.html` on the local Vite server. It stages three actual game agents in the seated animation: sleeping, attentive, and happy, with occasional blinking/winking. The camera makes a slow front-facing arc with a gentle push in. The production visor material and shared scenery capture provide the glass reflections.

To record again, start `node tools/capture-showcase.mjs`, then click **Record video**. The temporary encoder accepts frames only from `http://127.0.0.1:5275` on a loopback socket and exits after encoding the complete clip. It requires `ffmpeg` on PATH. The preview does not load live threads or persist settings.

Output: `recordings/bot-faces-orbit-9x16.mp4` — 1080 × 1920, H.264/yuv420p, 30 fps, 660 frames, 22 seconds, silent. Each frame is sampled at an explicit timestamp, captured losslessly from the game canvas, then encoded. Capture speed does not change the output frame rate. Recording artifacts are ignored by Git.

Validated the 660-frame capture with zero WebGL errors, decoded the entire MP4 without errors, and inspected six frames distributed across the camera move. `recordings/bot-faces-orbit-capture.json` contains the capture report; `recordings/bot-faces-orbit-contact-sheet.jpg` is the visual check.
