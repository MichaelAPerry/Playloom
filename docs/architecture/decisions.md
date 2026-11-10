# Architecture decisions

Decisions made by the project owner. The reasoning and the alternatives considered are in
[assessment.md](assessment.md).

| # | Decision | Status | Date |
|---|---|---|---|
| D1 | **Web stack.** Engine, runtime, Console and Studio are TypeScript running in a Chromium-class webview, with thin native shells per platform. | Approved | 2026-11-10 |
| D2 | **Electron** is the desktop shell for Windows and Linux. | Approved | 2026-11-10 |
| D3 | **Pluggable tracking backends** behind one interface: MediaPipe Pose Landmarker first, MoveNet MultiPose as a benchmarked alternative, non-ML motion regions for Lite. Playloom's own identity tracker sits above all of them, and the startup benchmark chooses per device. | Approved | 2026-11-10 |
| D4 | **GPL-3.0-or-later** for the platform, with a written statement that games and assets belong to their authors, and MIT for SDK schemas, type definitions and templates. | Approved | 2026-11-10 |
| D8 | Game packages are ZIP files with `game.json` and `assets/`; there is no separate manifest, so version and requirements have one source of truth. Read with fflate (MIT). | Routine choice, recorded for visibility | 2026-11-10 |
| D5 | Android: Kotlin shell hosting the same web bundle, with native camera capture and inference feeding landmarks over the bridge where the WebView cannot see the camera. | Follows from D1; to be confirmed at Milestone 4 | — |
| D6 | Rendering: Playloom's own data-driven runtime, Canvas 2D first, PixiJS behind the same interface when needed. | Follows from D1; to be confirmed at Milestone 2 | — |
| D7 | **MediaPipe telemetry must be blocked.** Usage reporting to Google is never allowed to leave the device. See below. | Approved | 2026-11-10 |
| D9 | **MoveNet MultiPose Lightning runs on ONNX Runtime Web** (WebAssembly, local files, no telemetry). Implemented as a developer-playground backend. See below. | Implemented in the playground; Console wiring pending | 2026-11-10 |

## D7 — MediaPipe sends usage metrics from version 1.0.0

**Finding (2026-11-10, verified).** While testing real camera tracking, the browser reported that
`@mediapipe/tasks-vision` 1.2.2 tried to POST to `https://odml.pa.googleapis.com/v1/log`. The package's
README (privacy notice dated 2026-06-05) confirms it: MediaPipe Tasks send "metrics about the performance
and utilization of the APIs" to Google, and no option to turn this off is documented. Camera pictures are
not sent. Inspecting published packages showed the reporting code is present in 1.0.0, 1.1.0, 1.2.0 and
1.2.2 and absent in 0.10.34, the last 0.10 release.

This conflicts with Playloom's requirements (no mandatory analytics, offline-first), so an interim
measure is already in place:

- the dependency is pinned to exactly **0.10.34**, in which a full test run made no network requests;
- every page ships a Content-Security-Policy that blocks outbound connections, which was observed to
  block the 1.2.2 request while tracking continued to work.

**Options**

| | A. Stay on 0.10.34 (current) | B. Newer MediaPipe with reporting blocked | C. Make another backend the default |
|---|---|---|---|
| Approach | Keep the pin; rely on the policy as a second layer | Track upstream; block the endpoint by policy on web and desktop, and ship the Android app without the INTERNET permission | Run MoveNet MultiPose or RTMO through LiteRT.js or ONNX Runtime Web; keep MediaPipe optional or drop it |
| Benefits | Nothing is ever attempted; simplest; verified working with two people | Upstream fixes and model improvements | No dependency on a library whose direction conflicts with the project |
| Disadvantages | No upstream fixes; the pin must be defended against well-meaning upgrades | Relies on blocking rather than absence; the library's notice asks integrators to obtain user consent, which is awkward for a children's product even when blocked | More work now; candidates not yet benchmarked; LiteRT.js must itself be checked for reporting |
| Performance / compatibility | As measured in [status.md](../status.md) | Unknown until measured | Unknown until measured; MoveNet is single-pass, so it may be faster with two players |

**Decision (owner, 2026-11-10): block it.** Playloom does not send MediaPipe's usage metrics to
Google, by whatever means are needed.

How that is carried out:

1. The Content-Security-Policy that forbids outbound connections is a permanent, required part of every
   Playloom page, and the desktop and Android shells must enforce the same thing at their own level
   (request blocking in Electron; no `INTERNET` permission on Android).
2. The dependency stays on 0.10.34 for now, because a version with nothing to block is strictly safer
   than one that relies on the block, and no newer feature is needed yet.
3. Upgrading is permitted when there is a reason to (a fix, a better model), on condition that the
   upgrade is tested and shown to make no outbound request that gets through.

**Is blocking allowed?** MediaPipe is licensed under Apache-2.0, which lets anyone use, modify and
redistribute it and contains no condition requiring that telemetry be delivered. Playloom calls no
Google service and has accepted no terms of service for one. On that reading, preventing the request is
within the licence. This is an engineering reading of the licence, not legal advice.

## D9 — MoveNet MultiPose Lightning on ONNX Runtime Web

**Question.** D3 calls for MoveNet MultiPose as a benchmarked alternative to MediaPipe. Which runtime can
run it in a browser Web Worker without telemetry, under the strict page policy (no `unsafe-eval`;
`wasm-unsafe-eval` allowed, which must not be weakened), offline?

**Candidates and what was checked (2026-11-10, Linux container, headless Chromium 153).**

| | `@litertjs/core` 2.6.0 | `onnxruntime-web` 1.31.1 | `@tensorflow/tfjs` 4.22.0 |
|---|---|---|---|
| Licence | Apache-2.0 | MIT | Apache-2.0 |
| Model format | `.tflite` | `.onnx` | tfjs graph model |
| Model obtainable here | **No.** The Google-hosted `.tflite` (tfhub, Kaggle, GCS) returned 404/403 from this container, so no model could be run. | **Yes.** `Xenova/movenet-multipose-lightning` on Hugging Face, a conversion of Google's model, Apache-2.0, input `[1,H,W,3]` int32 with dynamic H and W, output `[1,6,56]`. float32 19.0 MB; fp16 9.7 MB; uint8 5.3 MB. | **No.** The tfjs model also lived on tfhub (404). |
| Bundle inspected for outbound URLs and telemetry | JS and the four wasm glue files: only emscripten comment URLs; `fetch(` once (model loading); no `sendBeacon`, `googleapis`, `telemetry`. Not run in a browser. | `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`: only a `web.dev` link inside a warning message; `fetch(`/`XMLHttpRequest` are used to read the files whose URL the caller supplies; no `sendBeacon`, `googleapis`, `telemetry`, no `eval(`, no `new Function`. Strings of the 14.8 MB wasm contain only documentation links in operator descriptions (arxiv.org, ieeexplore.ieee.org, docs.nvidia.com, github.com, tinyurl.com) and no `telemetry` or `sendBeacon`. | `tf.min.js`: no `eval(`, no `new Function`, no `sendBeacon`, no `googleapis`; remote URLs only in comments and the default model loaders. Not run. |
| Size to ship | wasm 11 MB + 0.3 MB glue (several variants) | wasm **14.8 MB** (3.8 MB gzipped) + 78 KB of JS (`wasm` build, single thread). The WebGPU build is 29 MB, so it is not shipped. | 1.5 MB JS plus backends; wasm backend is a separate package |
| Maintained | Yes (2026-10) | Yes (releases every few weeks) | Last release 2025-01 |

**Decision: ONNX Runtime Web with the float32 model.** It is the only candidate for which a legally
redistributable model was actually obtainable and could be run, it carries no telemetry code, and it
satisfies the policy. LiteRT.js remains a reasonable alternative and was **not** evaluated beyond reading
its bundle; if a `.tflite` file becomes available it should be benchmarked against this choice.
`@mediapipe/tasks-vision` stays pinned at 0.10.34 (D7).

**Verified in a real browser run** (production build served by `vite preview`, headless Chromium, Playwright
request log, camera replaced by a two-person video):

- The page policy in `apps/playground/index.html` was **not changed**. ONNX Runtime Web starts under it
  (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' blob: data:`);
  no policy violation was logged.
- Every request the page made went to the page's own origin. The list of requests to other origins was
  empty in every run (MoveNet worker, MoveNet on the main thread under the development server, and the
  compatibility check).
- The runtime is loaded from files copied out of `node_modules` by `pnpm fetch-models`
  (`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`) with pinned SHA-256
  values, so nothing needs the network at run time and an upgrade of the package fails the fetch step
  until the hashes are reviewed. They are loaded by a plain same-origin `import()` rather than bundled;
  bundling made Vite emit another 14.8 MB copy of the wasm into every app that imports the core package.
- Single thread only. ONNX Runtime's multi-threaded mode needs `SharedArrayBuffer`, which needs
  cross-origin isolation headers that Playloom's pages (web demo, `file`-like Electron loading) do not
  have. Multi-threading is possible in the desktop shell and is a candidate for later measurement.

**Model checks.**

- The pinned model file is a Hugging Face repository revision (`8506174d…`), not `main`. The checksum is in
  `scripts/models.json`.
- The uint8 model was tried by swapping the file: it found **no people** in the test video, so the
  quantised file is not used.
- Input size: 256 on the long side (256x192 for a 640x480 camera). 192 was tried and was not faster in
  the browser (about 9 Hz), so 256 stays the default. It is an option (`inputSize`, rounded up to a multiple
  of 32).

**Hands.** MoveNet reports wrists and no fingertips. The backend declares `hands: "coarse"`: Playloom's
hand point is then the wrist extended along the forearm, which is an approximation of the palm, not a
fingertip. Nothing in the code gates on the word today.

**Measured here** (4 virtual cores, no GPU, one 640x480 two-person video; relative numbers only):

| Backend | Tracking | Latency | People |
|---|---|---|---|
| `movenet-multipose` (worker) | 8–10 Hz | 93–124 ms | 2 |
| `mediapipe-pose-cpu` (worker) | 13–15 Hz | 58–76 ms | 2 |

With two people **MoveNet was slower than MediaPipe on this machine**: the model itself takes about
75 ms per frame in single-thread WebAssembly (native single-thread ONNX Runtime ran the same file in
22 ms). MoveNet's advantage is that its cost is nearly flat in the number of people, so it should win
for three or more people, which was not measured. The compatibility check measures it next to the others,
so the device chooses.

**Consequences.** `recommendProfile` needed no change: it already chooses the fastest skeleton backend,
and a test now covers MoveNet. The Console does not offer MoveNet yet (it lives in the playground
only); see the report for the one-line change.
