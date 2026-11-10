# Project status

Last updated: 2026-11-10

This document records what has been built, how it was tested, and what has **not** been verified.
Nothing is listed as working unless it was run.

## Summary

| Milestone | State |
|---|---|
| Architecture assessment and decisions | Done; D1–D4 and D7 approved. |
| 1 — Motion engine and simulator | **Software complete and tested with simulated and synthetic input. Not yet tested with a physical camera or real people.** |
| 2 — First games and shared runtime | **Software complete and tested with simulated players. Not yet played by real people with a camera.** |
| 3 — Console | **Software complete. Tested with keyboard, simulated players and synthetic video; Linux app built and run. Windows build and real-family use not verified.** |
| 4 — Android TV | Not started |
| 5 — Studio | Not started |
| 6 — Community ecosystem | Not started |

## Milestone 1 — Motion engine and simulator

### Delivered

| Deliverable | Where | Notes |
|---|---|---|
| Webcam input | `packages/core/src/camera` | `getUserMedia`, camera selection, clear error categories |
| Two-player tracking | `backends/mediapipe.ts`, `tracking/identity.ts` | MediaPipe Pose Landmarker (two poses) feeding Playloom's identity tracker |
| Stable player assignment | `tracking/identity.ts` | Position, velocity and size matching; explicit `uncertain` state; recovery after loss; never swaps silently when it can detect doubt |
| Gesture recognition | `gestures/recognizer.ts` | Jump, duck, lean, hands up, each hand raised, swipes; thresholds scale with body size; adjustable sensitivity |
| Performance monitoring | `performance/` | Tracking rate, latency, engine time; compatibility report; profile selection from measurements |
| Calibration | `engine.ts` (`calibrate`) | Numbers players by side, records size and standing height, visible progress |
| Lite mode | `backends/motion-lite.ts` | Motion regions without a neural network |
| Simulator | `packages/simulator` | Two simulated players, keyboard and mouse control, entry/exit, dropout, occlusion, crossing, shuffled order, noise |
| Recording and playback | `packages/simulator/src/recording.ts` | Keypoints only; replay is event-for-event identical |
| Debug tooling | `apps/playground` | Skeleton overlay, player cursors, rates, event log, mirror and sensitivity controls |
| Automated tests | `packages/*/test` | 66 tests |

### Acceptance criterion

> Two independently controlled player cursors respond to simultaneous motion, and the simulator
> reproduces the same input API.

| Part | Result | Evidence |
|---|---|---|
| Two independent cursors, simulator | **Met** | Automated: `two-players.test.ts` ("gives each player independent hand cursors"). Browser run: mouse placed Player 1's hand at (0.20, 0.30) and Player 2's at (0.85, 0.50) of the screen; the API reported (0.200, 0.300) and (0.850, 0.500). |
| Two independent cursors, real pose model | **Met with synthetic video only** | Headless Chromium with a video file as the camera (one photographed person composited twice, one copy moving). MediaPipe found both, Playloom numbered them 1 (left) and 2 (right) with 19 keypoints and both hands each. |
| Same input API from simulator and camera | **Met** | Both are `PoseSource` implementations feeding the same `MotionEngine`; the playground switches between them at run time, and the record/replay test shows identical events. |
| Two real people in front of a physical webcam | **Not verified** | No camera or people are available in the development environment. This needs the owner or a contributor. |

### Test evidence

All commands were run on 2026-11-10 on Linux x86-64, Node 22.23.

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm test` | 66 of 66 passed (6 files) |
| `pnpm build` | Passed; 52 kB app + 154 kB MediaPipe loader (before compression), plus WASM and model |
| Playground, simulator, production build, headless Chromium 153 | Two players joined; mouse, jump and hands-up worked; 30 Hz tracking, 60 fps rendering; no console errors |
| Playground, simulator, dev server | Same; no console errors under the Content-Security-Policy |
| Playground, camera modes, synthetic two-person video | See table below; no requests to any other host |
| CI, web-demo and desktop workflows | **Written but not yet run** — it runs on pull requests and pushes to `main`, and neither has happened |

Measurements from the synthetic-video run (cloud container, 4 virtual cores, no GPU — not representative
of real PCs):

| Backend | Tracking | Latency | Players | Render |
|---|---|---|---|---|
| MediaPipe lite, processor | 14–17 Hz | 73–84 ms | 2 | ≈ 15 fps |
| MediaPipe lite, graphics path (software-emulated here) | 2 Hz | ≈ 1.7 s | 2 | — |
| Lite motion regions | 30 Hz | ≈ 10 ms | 1 (only one copy moved) | 60 fps |

The compatibility check measured all three and recommended **Standard** on the processor backend.

### Known limitations

1. **No real-world validation.** Tracking quality, gesture thresholds and identity behaviour with real
   people, clothing, lighting and rooms are untested. The thresholds are reasoned first values.
2. **Pose estimation runs on the main thread.** With the processor backend, rendering dropped to about
   15 fps in the test above. It needs to move to a worker.
3. **Same-size players who swap places out of view** and return on each other's side are numbered by
   side. No skeleton-only tracker can detect this.
4. **Size-based identification** needs sizes that differ by 30 % or more and assumes players stay at a
   similar distance from the camera.
5. **Lite mode is basic.** Hand cursors appear only while something moves, there is no jump, duck or
   lean, and a moving background (a pet, a television) counts as movement. It was tested with synthetic
   images and one synthetic video.
6. **MoveNet backend not built.** Decision D3 calls for it as a benchmarked alternative; only MediaPipe
   and Lite exist.
7. **MediaPipe is pinned to an old release** (0.10.34) to avoid usage reporting — decision D7.
8. **Latency is estimated** from frame-callback timing, not measured end to end with a camera.
9. **No interpolation between tracking updates.** At low tracking rates, cursors move in visible steps.
10. **The playground is a developer tool**, not the child-friendly Console, and has no automated
    browser tests.
11. **Firefox and Safari are untested.**

### Owner actions requested

- Try the playground with two people and a webcam, run the compatibility check, and share the report —
  this is the missing part of the Milestone 1 acceptance test. No install is needed once the web demo
  is published: merge to `main`, set **Settings → Pages → Source** to **GitHub Actions**, and open the
  address the "Publish web demo" workflow reports (see the README).
- Run the **Desktop release** workflow (Actions tab) once the branch is on `main`, and try the Windows
  installer — the Windows build has never been produced.
- Enable *Private vulnerability reporting* in the repository's security settings, which
  [SECURITY.md](../SECURITY.md) refers to.

## Milestone 2 — First playable games and shared runtime

### Delivered

| Deliverable | Where | Notes |
|---|---|---|
| Game API | `packages/core` motion API + `packages/runtime` | Games receive input only through the motion API |
| Scene/object data format | `packages/sdk/src/format.ts`, [game-format.md](game-format.md) | Version 1: scenes, sprites, text, timers, templates, variables, requirements |
| Validation of untrusted games | `packages/sdk/src/validate.ts` | Closed vocabulary, reference checks, limits; unknown properties are errors |
| Visual-rule runtime | `packages/runtime/src/runtime.ts` | 8 triggers, 4 condition types, 15 actions; deterministic; no code execution |
| Rendering and sound | `render-canvas.ts`, `audio.ts` | Canvas 2D; eight synthesised sounds original to Playloom |
| Two original games | `games/mole-mayhem`, `games/slice-party` | **Both are plain data files** — no game-specific code exists anywhere |
| Independent scoring | runtime | Per-player scores; `$player` attributes each touch to whoever made it |
| Competitive and cooperative | runtime | Mole Mayhem: highest score wins. Slice Party: shared team goal. |
| Lifecycle | runtime | Start, user pause/resume, restart, end with result; automatic pause when a player is missing or identity is in doubt |
| Playing games | `apps/playground` | Choose a bundled game or open a game file; results and pause prompts |

### Acceptance criterion

> Two playable games use the shared API, and at least one has its behavior represented through
> portable, serializable rules rather than hard-coded game-specific logic.

**Met, with simulated players.** Both games are JSON documents interpreted by the same runtime. Full
rounds were played by simulated players through the real tracking pipeline in automated tests, and both
games were played in a browser with a mouse-driven simulated player (scores of 100 and 70 reached, no
console errors). **Not verified:** play by two real people with a camera — whether the games are fun,
fair and physically comfortable is unknown.

### Test evidence (2026-11-10)

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm test` | 96 of 96 passed (9 files): 14 validator tests, 16 runtime and playthrough tests, 66 from Milestone 1 |
| `pnpm build` | Passed |
| Browser run of both games, production build, headless Chromium | Scoring, effects, HUD and file loading worked; a malformed game file was rejected with a readable message |

### Product choices made here that the owner may want to change

- **Slice Party is cooperative** (team goal of 300 in 60 seconds) so that both modes are exercised. The
  brief did not specify. Changing it to competitive is an edit to one rule in its JSON file.
- Game art was generated with ChatGPT from the prompts in `docs/art-prompts.md` and supplied by the owner.
- Round length (60 s), scores and timings are first guesses, untested with players.

### Known limitations

1. Image assets are supported for bundled games (sprites and scene backgrounds, with shapes as the
   fallback), and the bundled games now have AI-generated artwork (one picture, the lime, is still missing — see
   [art-prompts.md](art-prompts.md)). No imported audio,
   sprite animation or `.playloom` package container yet; a game opened from a file gets shapes only.
2. No published JSON Schema file; the TypeScript validator is the single source of truth. (A schema
   validator library that generates code at run time would be blocked by Playloom's own security
   policy, so the validator is hand-written.)
3. Movement is constant velocity plus gravity; there is no bouncing or friction.
4. Sound has only been exercised through a recording stub in tests; it has not been listened to.
5. Lite mode can play both games in principle (they need only hands), but this has not been tried.

## Milestone 3 — Playloom Console

### Delivered

| Deliverable | Where | Notes |
|---|---|---|
| Fullscreen launcher | `apps/console` | Large-type library of game tiles; live Player 1 / Player 2 indicators |
| Game selection, launch and exit | `apps/console/src/main.ts` | Pause menu, results, play again, back to library |
| Two-player setup | Console *Player setup* | Mirror view with each player outlined in their colour; runs before the first game of a session |
| Settings | Console *Settings* | Tracking mode, camera, mirror, sensitivity, sound, full screen |
| Hardware benchmark | *Check this device* | Offered on first run; result in plain words; saved and used by Automatic mode; report can be saved |
| Local game installation, import and export | `packages/sdk/src/package.ts`, Console | `.playloom` packages, fully checked before storing; permission prompt; remove; save a copy |
| Controller and remote navigation | `apps/console/src/nav.ts` | Arrow keys / remote, Enter, Back; gamepad D-pad, stick, A, B, Start |
| Hardware warnings | Console | Warns before a game the active tracking cannot support |
| Offline operation | Console page policy, desktop shell | No network requests; verified below |
| Desktop releases | `platforms/desktop`, `.github/workflows/desktop.yml` | Electron shell; Windows installer + portable exe and Linux AppImage built by workflow |
| Practice mode | Console | Play with the keyboard when there is no camera |

### Acceptance criterion

> A family can launch the application, calibrate two players, choose a game, and play without
> accessing a command line.

**Met in testing with a synthetic camera; not yet tried by a family.** In the browser build with a video
file standing in for the camera, the whole path ran with no command line involved: the Console opened,
offered the device check, a game was chosen, player setup recognised and numbered both people, and the
game started. Getting the application without a command line depends on the two workflows (web demo and
desktop release), which have been written but have not run yet.

### Test evidence (2026-11-10)

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm test`, `pnpm build` | Passed; 107 of 107 tests (10 files), including 10 package tests |
| Console, no camera, keyboard only (headless Chromium) | "No camera was found" shown; *Practise without a camera* started two simulated players; arrow keys and Enter launched a game; Esc paused; menu worked; no console errors; no requests to other hosts |
| Installing a game | A `.playloom` file showed the permission prompt, installed, and was still there after reloading; a non-package file was refused with a message |
| Console with synthetic two-person camera | Welcome prompt → game chosen → player setup calibrated both players (Player 1 left at x≈0.25, Player 2 right at x≈0.74) → game playing |
| Desktop app from source (Electron 45, Linux, virtual display) | Window loaded; camera granted; full body tracking started; page had no Node.js access |
| Desktop app, hostile page behaviour | `fetch` to another site: refused. Paths outside the app folder (`../main.cjs`, encoded variants): 404 / 403. `window.open`: denied |
| Linux package | `npm run dist` produced `Playloom-0.1.0.AppImage` (141 MB); the packaged program was run and passed the same checks |
| Windows package | **Not built or run** — it can only be built on Windows; the workflow does this |
| Gamepad | **Not tested** — no gamepad is available here; the code path is exercised only by reading |

A real defect was found and fixed this way: the first version of the desktop shell blocked its own page
from loading, because the request filter also caught the shell's internal file reads.

### Known limitations

1. Not tried by real families; the wording, sizes and flow are untested with children.
2. Windows build, installer behaviour and gamepads are unverified.
3. The desktop app is unsigned (Windows SmartScreen will warn) and uses the default Electron icon.
4. No parental lock on Settings.
5. Menus need a keyboard, remote, gamepad or mouse; they are not motion-controlled.
6. Pose estimation still runs on the main thread (Milestone 1 limitation 2).
7. Installed games are stored per browser profile; clearing site data removes them.
8. The Console has no automated browser tests in the repository; the checks above were scripted by hand.

## Next

Before Milestone 4, three things carried over that affect how the games feel:

1. Move pose estimation into a worker.
2. MoveNet MultiPose backend (decision D3), measured by the device check.
3. Automated browser tests for the Console and playground in CI.

Milestone 4 — Android TV: Kotlin shell hosting the Console in a WebView, camera compatibility probe
(WebView → Camera2 external → user-space UVC), remote navigation, APK build in CI. No Android hardware
is available in the development environment, so hardware acceptance will have to be reported as
unverified until someone runs it on a device.
