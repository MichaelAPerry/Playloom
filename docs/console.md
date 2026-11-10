# Playloom Console

The Console is what a family sees: a full-screen library of games, player setup, and settings. It is the
same web application whether it runs in a browser tab, in the Windows/Linux desktop app, or — later —
on an Android TV box.

## Using it

| Screen | What it does |
|---|---|
| **Home** | Game tiles, plus *Player setup*, *Add a game* and *Settings*. Chips at the top light up in orange and blue when Player 1 and Player 2 are in view. |
| **Player setup** | Shows the camera like a mirror with two big slots: Player 1 (left half, orange) and Player 2 (right half, blue). There is no timer. Each person stands in their half and raises a hand to join ("Player 1 is in!"); when both are in, press Start — or both raise both hands. *Player 1 is ready* / *Player 2 is ready* buttons confirm whoever is detected in a half from the keyboard or remote, and *Start with one player* is offered once one person has joined (games wait for the second player). Runs automatically before the first game of a session. |
| **Playing** | The game fills the screen. It pauses by itself if a player walks away or if it loses track of who is who, and says what to do. |
| **Settings** (for grown-ups) | Tracking mode, camera, mirror, gesture sensitivity, the device check, sound, full screen, and installed games. |

### Controls

Everything works without a mouse.

| | Keyboard / TV remote | Gamepad |
|---|---|---|
| Move | Arrow keys | D-pad or left stick |
| Choose | Enter | A |
| Back, or pause during a game | Esc or Backspace | B (Start also pauses) |
| Full screen (desktop app) | F11 | |

### Tracking modes

*Automatic* uses the result of **Check this device**. Before any check has been run it does a quick trial the first time: full body tracking on the graphics card is timed for about 4 seconds (after 1.5 s warm-up); if below 15 updates a second the processor is timed the same way; the faster is kept, and Lite is used if the best is below 8. The home screen says "Finding the best tracking…" and games cannot be started until it finishes. The result is stored on the device and used from then on; changing the camera or *Re-test tracking speed* in Settings clears it. Settings shows the live tracking rate next to *Now using*. A camera problem is reported as such
rather than hidden by a fallback.

*Practice* needs no camera: two pretend players are driven from the keyboard and mouse, using the
[simulator's keys](simulator.md). It is how to try a game on a computer without a webcam.

### Adding games

*Add a game* opens a `.playloom` file. Playloom checks it completely before anything is stored (see
[game-packages.md](game-packages.md)), shows who made it, its licence and size, and asks before
installing. Installed games are kept on the device, can be removed in Settings, and any game — bundled
ones included — can be saved back out as a `.playloom` file to share.

Before starting a game the device cannot fully support (for example one that needs jumps while Lite
tracking is in use), the Console warns and offers to choose another.

## Running it

- **In a browser:** the published web demo, or `pnpm dev` from source. Chrome or Edge.
- **Windows and Linux app:** built by the *Desktop release* workflow; see
  [`platforms/desktop/README.md`](../platforms/desktop/README.md).

Settings and installed games are stored on the device, separately for the browser and the desktop app.

## What the desktop app enforces

The desktop shell (`platforms/desktop/main.cjs`) gives the page no access to the computer beyond the
camera: no Node.js, no preload script, no new windows, no navigation away. Every network request is
refused at the session level, which is also how third-party telemetry is blocked (decision D7). These
were verified by running the application and attempting each from inside the page; see
[status.md](status.md).

## Not there yet

- No parental lock on Settings; it is only labelled "for grown-ups".
- Menus are not motion-controlled — a keyboard, remote, gamepad or mouse is needed between games.
- The desktop app is not code-signed, so Windows will show a SmartScreen warning on first run.
- No automatic updates (by design it never goes online); a new version is a new download.
