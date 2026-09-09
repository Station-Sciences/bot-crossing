# Installing Bot Crossing (shared-colonies build)

One installer does everything on a Windows PC — for a brand-new machine **and** for
updating one that already has Bot Crossing. It needs no admin rights for the app itself.

> **Already have a clone you work in?** Do not run this installer — it installs a *second*
> copy under `%LOCALAPPDATA%\BotCrossing` with its own autostart, and both would fight over
> port 5274. Just `git pull` in the clone you already have; the installer is for a machine
> with nothing on it yet.

## The easy way

1. Copy this whole `install` folder to the PC (a USB stick or a network share is fine).
2. Double-click **`Install Bot Crossing.cmd`**.
3. Wait — it fetches Node if needed, downloads and builds the app, and sets it to open
   when you log in. When it finishes, the colony opens by itself.

That's the whole thing for a colleague. Their own name (their Windows username) becomes
their colony name; **sharing starts off**, so nothing leaves their machine until they turn
it on in **Settings (S) → Shared colonies**.

## Turning on sharing, and visiting each other

- **To let others visit you:** open Settings → Shared colonies → *Share on the network*.
- **To visit someone:** in that same panel, either pick a colony under *Found on your
  network*, or type their PC's name/IP and port `5275`. Their colony appears as its own
  district on your map — **read-only**: you see their astronauts, you can't touch their threads.

The first time you turn sharing on, Windows may pop up a firewall prompt for `node` — allow
it on **Private** networks. (Running the installer as administrator adds that rule for you.)

## Options (for the person setting it up)

Run from a PowerShell window instead of double-clicking to pass options:

```powershell
powershell -ExecutionPolicy Bypass -File install-bot-crossing.ps1 -Share -Monitor 2
```

| Option | What it does |
|---|---|
| `-Share` | Turn sharing on right away (default: off). |
| `-Monitor <n>` | Open the colony on monitor *n*, counted left to right (default: primary). |
| `-InstallDir <path>` | Where to install (default: `%LOCALAPPDATA%\BotCrossing`). |
| `-Branch <name>` | Which branch to build (default: `shared-colonies`). |
| `-NoAutostart` | Install without the log-in autostart entry. |
| `-NoLaunch` | Don't open the colony when the install finishes. |

## Updating later

Run the installer again — it pulls the newest code, rebuilds, and keeps your colony,
your settings and your neighbour list. (For Chantal, or anyone who had the older Bot
Crossing: just run this installer once; it gives a clean managed install with the shared
build. The old copy can be deleted.)

## What it sets up

- A portable **Node 22** under the install folder, only if the PC has nothing new enough
  — your system stays untouched.
- The app under `…\BotCrossing\bot-crossing`, built and ready.
- A **login autostart** entry (per-user) that opens the colony fullscreen in its own window.
- Firewall rules for the guest port (**TCP 5275**) and discovery (**UDP 5276**) — added
  automatically when the installer runs as admin, printed for you to paste if not.

## Removing it

- Delete `bot-crossing.vbs` from your Startup folder
  (`Win+R` → `shell:startup`).
- Delete the install folder (`%LOCALAPPDATA%\BotCrossing`).
- If you added them: remove the two "Bot Crossing" firewall rules.
