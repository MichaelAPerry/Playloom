# Project status

Last updated: 2026-11-10

This document records what has been built, how it was tested, and what has **not** been verified.
Nothing is listed as working unless it was run.

## Summary

| Milestone | State |
|---|---|
| Architecture assessment and decisions | Done; D1–D4 approved. **D7 (MediaPipe telemetry) needs an owner decision.** |
| 1 — Motion engine and simulator | **Software complete and tested with simulated and synthetic input. Not yet tested with a physical camera or real people.** |
| 2 — First games and shared runtime | Not started |
| 3 — Console | Not started |
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
| CI workflow | **Written but not yet run** — it runs on pull requests and pushes to `main`, and neither has happened |

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

- Decide **D7** ([decisions.md](architecture/decisions.md)).
- Try the playground with two people and a webcam, run the compatibility check, and share the report —
  this is the missing part of the Milestone 1 acceptance test.
- Enable *Private vulnerability reporting* in the repository's security settings, which
  [SECURITY.md](../SECURITY.md) refers to.

## Next

Finishing Milestone 1:

1. Move pose estimation into a worker.
2. MoveNet MultiPose backend, and include it in the compatibility check.
3. Interpolate player state to the display rate.
4. Automated browser tests for the playground, including a camera test with a synthetic video.
5. Tune thresholds from recordings of real play, once recordings exist.

Milestone 2 (after owner review of Milestone 1): game format JSON Schema and validator in
`packages/sdk`; scene, object and rules runtime in `packages/runtime`; the first two games, at least one
defined entirely by rules.
