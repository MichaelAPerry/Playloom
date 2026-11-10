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
works best with two people in view. Each backend is started in turn — pose estimation on the graphics
card, pose estimation on the processor, and Lite — given 1.5 s to warm up and then measured for 4 s.

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
