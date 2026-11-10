# Hardware compatibility

**No physical device has been verified yet.** This page will list devices only after someone has run
Playloom on them and submitted a compatibility report. Nothing here is inferred from specifications.

## Verified devices

| Device | OS | Camera | Profile | Tracking | Players | Report | Verified by |
|---|---|---|---|---|---|---|---|
| *none yet* | | | | | | | |

## Development measurements (not hardware verification)

These numbers come from an automated run in a cloud container with no GPU and a synthetic video file in
place of a camera. They show that the pipeline works end to end; they say little about real PCs.

| Environment | Backend | Tracking | Latency | People tracked |
|---|---|---|---|---|
| Headless Chromium 153, Linux x86-64, 4 virtual cores, software rendering | MediaPipe lite, processor | 14–17 Hz | 73–84 ms | 2 |
| same | MediaPipe lite, graphics path (software-emulated) | 2 Hz | ≈ 1.7 s | 2 |
| same | Lite motion regions | 30 Hz | ≈ 10 ms | by region |

## Submitting a report

1. Build and run the playground ([building.md](../building.md)).
2. Stand two people in front of the camera and press **Run compatibility check**, then **Save report**.
3. Open an issue and attach the JSON, with the computer's make, model and age, the operating system,
   and the camera model.

## Android

Android TV boxes are a primary target but support does not exist yet (Milestone 4). Expect large
variation: USB webcam support is optional in Android and depends on each manufacturer's firmware. See
section 5 of the [architecture assessment](../architecture/assessment.md).
