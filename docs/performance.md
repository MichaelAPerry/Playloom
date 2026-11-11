# Performance profiles and the compatibility check

Playloom chooses how to track players from **measurements taken on the device**, never from the
hardware's name or age.

## Profiles

| Profile | Tracking | What games get |
|---|---|---|
| **Lite** | No neural network. Movement inside each player's half of the picture. | Two players by side, coarse hand cursors, swipes, activity level. No skeleton, jump, duck or lean. |
| **Standard** | Two-person pose estimation at 12 Hz or more. | Full skeletons, precise hands, all gestures. |
| **Enhanced** | Pose estimation at 24 Hz or more with at most 120 ms latency. | As Standard, with tighter response. |

The thresholds are constants in `packages/core/src/performance/profile.ts`. They are first estimates of
what feels responsive and are expected to be tuned against play-testing; they are not yet validated
with players.

## Running the check

In the playground, press **Run compatibility check**. It needs a camera, takes about 20 seconds, and
works best with two people in view. Each backend is started in turn — MediaPipe pose estimation on the
graphics card, MediaPipe on the processor, MoveNet MultiPose (processor, WebAssembly) and Lite — given 1.5 s to warm up and then measured for 4 s.

The report contains:

| Field | Meaning |
|---|---|
| `camera` | Whether a camera opened, how many exist, its name and resolution |
| `backends[].trackingHz` | Pose results per second actually delivered |
| `backends[].latencyMs` | Mean time from frame capture to the motion API |
| `backends[].processingMs` | Mean time Playloom's own engine spent per frame |
| `backends[].playersSeen` | Most players tracked at once during the measurement |
| `backends[].error` | Why a backend could not start, if it could not |
| `renderFps` | Screen refresh rate achieved while tracking |
| `renderP95Ms`, `renderWorstMs`, `renderLongFrames` | Frame pacing while tracking: 95 % of screen frames arrived within this many milliseconds, the longest gap, and how many frames were later than 33 ms. Average fps hides stutter; these do not |
| `memoryMb` | JavaScript heap, where the browser exposes it |
| `recommendation` | Chosen profile and backend, supported players, capabilities, and the reasons |

**Save report** writes the JSON to a file. Please contribute reports — see
[hardware/compatibility.md](hardware/compatibility.md).

## Reading the numbers

- `latencyMs` covers capture to API. Add roughly one screen frame, plus the camera's own exposure and
  USB delay, for what a player feels.
- Pose estimation runs in a worker, so a slow model lowers the tracking rate but should not lower
  `renderFps`. (Under the development server it falls back to the main thread.)
- The graphics-card path can be *slower* than the processor path on machines without a real GPU driver
  (software rendering). That is why both are measured.
- MoveNet MultiPose finds everyone in one pass, so its cost barely grows with the number of people,
  whereas MediaPipe's grows per person. It runs single-threaded in WebAssembly and has no fingertip
  points (hands are derived from the wrists). In the development container (4 cores, no GPU) it ran at
  8–10 Hz with two people against 13–15 Hz for MediaPipe on the processor, so it is not automatically the
  faster choice; the check decides per device. Details and method: decision D9 in
  [architecture/decisions.md](architecture/decisions.md).


## If it runs badly

Press **F3** (or turn on **Show performance details** in the Console's Settings, or the checkbox in the
playground). A small box appears in the top right corner and updates twice a second. **Copy details**
puts the same information on the clipboard as plain text so it can be pasted into a message. The choice
is remembered. In plain words, from top to bottom:

| Line | What it means | Worrying when |
|---|---|---|
| Tracking | Which tracking is running: backend, `GPU` or `CPU` for the model, and whether it runs in a `worker` (good: it cannot freeze the screen) or on the `main` page thread | `main` |
| Camera | The picture size the camera really delivers and how many new pictures it delivers per second, counting every one, not only those that were analysed | Fewer than 20 pictures per second: the camera itself is slow (dim room makes many webcams drop to 7-15). Tracking cannot be faster than the camera |
| Analysed at | The size of the copy given to the model. Playloom reduces the camera picture to 320 px wide for the model, whatever the camera sends | - |
| Tracking updates | How many times per second the players' positions are updated | Under 12 |
| Model time | How long the pose model needs per picture: typical and worst | Typical above 60 ms: the model is the limit |
| Camera to API | Time from the camera taking a picture to Playloom knowing the positions | Above 150 ms |
| Camera to screen | Time from the camera taking a picture until the result is first drawn. Cursors are drawn slightly ahead of this (see "Display-rate motion" in the motion API) | Above 150 ms |
| Screen | Frames per second drawn, the time 95 % of frames stayed under, the worst frame, and how many frames were late (over 33 ms) | 95 % above 33 ms or many late frames: this is what looks like stutter |
| People seen | People the camera tracker sees, bystanders included | - |
| Graphics | The graphics adapter the browser reports, and `(SOFTWARE)` when the browser draws with the processor | `SOFTWARE`, or an integrated chip on a computer that also has a graphics card |
| Canvas | Size of the game picture and how large it is shown, and the screen's pixel ratio | - |
| Browser | Short browser and system name (the copied text has the full string) | - |

Below the numbers the panel lists **findings** in words when it can tell what is wrong: a slow camera, a slow
model, software graphics, or uneven drawing. On a computer with both an integrated chip and a graphics
card, the Windows graphics settings may have the browser on the integrated chip; the `Graphics` line shows
which one it is using.

## Measured changes (display-rate motion, retuned filter, cheaper capture)

All numbers below were measured by me in a **GPU-less cloud container** (headless Chromium 153, software
rendering, no physical webcam), not on real hardware. The camera was a looped video file of two people
(`--use-file-for-fake-video-capture`), one moving. Pose estimation ran on the processor delegate in the
worker. "x4" means the page's main thread was slowed four times with the DevTools protocol
(`Emulation.setCPUThrottlingRate`); **this throttles the main thread only, not the worker**, so it is a
rough stand-in for a weak machine, not a measurement of one. Mole Mayhem was running, 10 s per run,
frame times from a `requestAnimationFrame` loop inside the page. The GPU delegate was not compared: it is
software-emulated here and about 2.5 Hz, so real-GPU behaviour is **unverified**. The graphics card of
the owner's PC (an RTX 3070 and an integrated chip) was not available either; the F3 panel exists to find
out what it does.

| Measurement | Before | After |
|---|---|---|
| Cursor updates per screen frame (640x480 camera, x1): share of frames in which the hand cursor did not move | 76-78 % | 0 % |
| Typical cursor step when it moved (px on a 1280 wide canvas) | 9-11 px | 2.3 px (x1), 3.4 px (x4) |
| Work done in each `requestAnimationFrame` callback, x4, 640x480 camera | mean 16.6 ms | mean 1.0 ms |
| Same, camera delivering 1920x1080 and refusing a smaller mode | mean 26.6 ms | mean 1.0 ms |
| Main-thread time to hand one camera picture to the worker, x4, 640x480 | 5.0 ms (`createImageBitmap(video)`) | 2.1 ms (draw into small canvas, includes the backdrop copy) |
| Same at 1920x1080 | 28.0 ms | 7.8 ms |
| Frames later than 33 ms in 10 s, x4, 640x480 camera, three runs each | 36, 36, 25 | 24, 11, 18 |
| Longest main-thread stalls ("long tasks"), same runs | 99, 99, 0 ms in total | 0, 0, 0 ms |
| Frame time median / 95th percentile, x4, 1080p camera that refuses a smaller mode, three runs each | 50 / 83 ms in all runs; 115-124 late frames; 5.8-6.0 s in long tasks | 33 / 50-67 ms; 75-89 late frames; 0.7-1.5 s in long tasks |
| Time from camera capture to the motion API (`latencyMs`), x1 | 64-80 ms | 56-64 ms |
| Time from camera capture to first appearing on screen, x1 | not measured (no such counter) | 62-77 ms; cursors are then drawn up to 80 ms further along the hand's motion |
| Hand follows a 0.7 Hz swing (simulated 15 Hz tracking, unit test): delay of the smoothed signal | about 80 ms | about 26 ms |
| Time to cover 90 % of a step (15 Hz) | 267 ms | 133 ms |
| Jitter of a still hand (noise 0.004 screen heights, 15 Hz) | 1.89 (x 0.001) | 1.93 |

Runs on this container vary from run to run (the baseline at x4 gave a median frame time of 33 ms in two
runs and 17 ms in others), which is why the table gives ranges for the noisy items. The clearest
differences are the stepping of the cursors, the per-frame drawing cost and the 1080p case.

What changed, and why each was a cause:

1. **Cursors moved in steps.** Player states changed only when a pose result arrived (10-20 Hz) while the
   screen redraws at 60 Hz, so 3 out of 4 drawn frames showed the same cursor position. The engine now
   interpolates and extends motion at display rate (`MotionEngine.advance`).
2. **Cursors lagged.** The One Euro filter's speed coefficient (`beta` 0.4) was meant for pixel
   coordinates; with positions in screen heights it hardly opened the filter for moving hands. Retuned to
   `minCutoff` 1, `beta` 8, `dCutoff` 2 (numbers above, from `packages/core/test/display-motion.test.ts`).
   Display prediction (at most 80 ms ahead) then covers most of the remaining capture delay.
3. **Whole-screen stutter.** Each frame drew the full camera video behind the game (`drawImage(video)`),
   and each analysis copied the camera picture with `createImageBitmap(video)`. Reading a video frame is
   expensive, and the cost grows with the camera's resolution: webcams that deliver 720p or 1080p
   regardless of the 640x480 request made it much worse. Now one small copy (320 px wide) is made per
   analysis, used both for the model and as the backdrop. If the camera delivers more than 960 px, Playloom
   asks it again for 640x480 (`applyConstraints`).
4. **Not causes** (measured): the game runtime and canvas drawing took 1.0 ms per frame including text
   outlines at x4 once the video draw was gone; `engine.process` took 0.1-0.9 ms; with the simulator as
   input and the same game, frames were smooth at x4 before any change (median 16.7 ms, none late).
   Choosing 320 px, 480 px or the full 640 px for the model changed neither tracking rate (15 Hz), model time
   (48-49 ms), the number of people found (2), their confidence (0.99) nor the mean hand positions, so the
   smaller size costs no detection quality on this test video (one video only; unverified with other
   people, clothing and lighting).

Settings: in the playground, "Camera picture behind the game" (light, default / full / off), "Picture
size analysed" (320 / 480 / camera size) and "Display-rate cursor motion" are remembered in local storage.
