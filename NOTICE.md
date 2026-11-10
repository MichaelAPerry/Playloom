# Third-party notices

Playloom uses the following third-party components. Each remains under its own license.

| Component | Use | License |
|---|---|---|
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 0.10.34 | Pose estimation runtime (JavaScript and WebAssembly) | Apache-2.0 |
| MediaPipe Pose Landmarker models (`pose_landmarker_lite`, `pose_landmarker_full`) | Pose estimation models, downloaded by `pnpm fetch-models` | Apache-2.0 |

Build and test tools (not distributed with Playloom): TypeScript (Apache-2.0), Vite (MIT), Vitest (MIT).

The One Euro filter in `packages/core/src/tracking/one-euro.ts` is an independent implementation of the
algorithm published by Géry Casiez, Nicolas Roussel and Daniel Vogel (CHI 2012).
