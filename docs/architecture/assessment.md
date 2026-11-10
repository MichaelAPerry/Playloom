# Playloom architecture assessment

Status: **proposal awaiting owner decision** (2026-11-10).
Decisions are recorded in [decisions.md](decisions.md) once the owner approves them.

This document covers the ten points of the initial execution instructions: tracking-library research,
cross-platform architecture, the shared game format, the low-end tracking recommendation, Android USB
camera risks, the preliminary schema, the motion API boundary, the simulator interface, licensing, and
the implementation strategy.

Evidence labels used below:

- **[checked]** — verified during this assessment (registry metadata, official documentation).
- **[known]** — established behaviour of the library from its documentation, not re-measured here.
- **[unverified]** — plausible but must be measured on real hardware before Playloom relies on it.

No performance number in this document was measured on Playloom hardware. Every latency and frame-rate
claim is a hypothesis for the startup benchmark (section 6) to confirm or reject.

## 1. Motion tracking libraries

| Candidate | Two people in one pass? | Keypoints | Model size | Runtimes | License | Maintenance |
|---|---|---|---|---|---|---|
| **MediaPipe Pose Landmarker** (`@mediapipe/tasks-vision`) | Yes, `numPoses` option; top-down, so cost grows per person **[known]** | 33 (includes wrist, thumb, index, pinky) | lite ≈ 6 MB, full ≈ 9 MB, heavy ≈ 30 MB **[known]** | Web (WASM + WebGL delegate), Android, iOS, Python | Apache-2.0 **[checked]** | Active: npm 1.2.2 published 2026-11-10 **[checked]** |
| **MoveNet MultiPose Lightning** | Yes, bottom-up single pass for up to 6 people; cost nearly flat in person count **[known]** | 17 (wrists, no fingers) plus a box per person | ≈ 9 MB | TF.js, TFLite / LiteRT | Apache-2.0 | Model is stable; the `@tensorflow-models/pose-detection` wrapper was last published 2023-10 and `@tensorflow/tfjs` 2025-01 **[checked]**. `@litertjs/core` 2.6.0 (2026-10) is the maintained way to run the `.tflite` file on the web **[checked]** |
| **RTMPose / RTMO** (OpenMMLab) via ONNX Runtime Web | RTMO: yes, one-stage. RTMPose: top-down, needs a person detector | 17 or 133 | 10–50 MB+ | `onnxruntime-web` 1.31 (MIT, active) **[checked]** | Apache-2.0 | Active research code; heavier than the two above **[unverified on low-end CPUs]** |
| **Ultralytics YOLO-pose** | Yes | 17 | 6 MB+ | ONNX, TFLite | **AGPL-3.0 or paid enterprise license**, covering trained weights **[checked]** | Active |
| **OpenCV only** (frame differencing, background subtraction, optical flow) | Yes, by screen region — no skeleton | none | 0 | everywhere; also trivial to write directly on a canvas | Apache-2.0 | Active |
| **MediaPipe Hand Landmarker** | Up to N hands, but hands are not attached to a person | 21 per hand | ≈ 8 MB | as MediaPipe | Apache-2.0 | Active |

Findings:

1. **Single-person pose does not give two-player tracking.** Both viable models return an unordered list
   of people each frame. Neither promises that index 0 is the same person next frame. Playloom therefore
   needs its own identity layer (section 4) regardless of the model.
2. **YOLO-pose is excluded.** AGPL weights plus a commercial dual-licence would bind every downstream
   redistributor, which conflicts with a platform that wants hardware vendors and schools to reuse it.
3. **Dedicated hand tracking is deferred.** A hand landmarker doubles inference cost and its output is
   not tied to a player. Wrist (and for MediaPipe, index-finger) landmarks from the pose model are enough
   for cursors, hits, swipes and raises. Finger gestures can be an Enhanced-mode feature later.
4. **MediaPipe vs MoveNet is a measurement question, not a taste question.** MediaPipe is better
   maintained and gives hand-tip points; MoveNet MultiPose should be cheaper with two people because it is
   a single pass. Which wins on a 2012 laptop or a Cortex-A53 TV box is **[unverified]**.

### Recommendation

Put a `PoseBackend` interface in front of inference and ship more than one implementation:

| Profile | Backend | Output |
|---|---|---|
| **Lite** | No neural network. Frame-differencing motion energy inside calibrated left/right player regions, computed on a downscaled (≈ 160×120) frame | Per-player motion centroid, activity level, coarse "hand" points (top-most / side-most motion blobs), simplified gestures |
| **Standard** | MediaPipe Pose Landmarker *lite*, `numPoses: 2`, 256-px input, tracked at whatever rate the benchmark sustains (target ≥ 15 Hz, interpolated to render rate) | Full two-skeleton tracking |
| **Enhanced** | MediaPipe *full* (or MoveNet / RTMO if the benchmark prefers it), GPU delegate, ≥ 30 Hz | Higher precision, finger-tip landmarks |

MoveNet MultiPose through LiteRT.js is implemented as a second Standard backend during Milestone 1 so the
startup benchmark can choose by measurement on each device. Inference runs in a Web Worker so a slow
model degrades tracking rate, not rendering rate.

## 2. Cross-platform architecture

### Options

| | A. Web stack (TypeScript) + thin native shells | B. Godot 4 | C. Native per platform (Kotlin + C++/Qt) |
|---|---|---|---|
| One codebase for Console, Engine, Studio | Yes | Yes | No — three UIs |
| Pose inference | First-party web builds of MediaPipe / LiteRT / ORT | No first-party integration; a GDExtension must be built and maintained per OS and ABI | First-party on Android; C++ graph builds on desktop |
| Visual Studio editor | DOM is the strongest toolkit for drag-and-drop editors, forms, and rule builders | Possible with Godot UI, but it means writing an editor inside an engine that already has one | Largest effort |
| Android TV | WebView + Kotlin shell | Native export; camera needs a custom plugin | Native |
| Low-end performance | 2D canvas/WebGL is adequate; the browser's memory floor (≈ 250–400 MB) is the main cost **[unverified]** | Best rendering efficiency; Vulkan/GLES3 requirements exclude some old GPUs | Best |
| Sandboxing untrusted games | Browser primitives exist: sandboxed iframes, CSP, workers | Must be built by hand | Must be built by hand |
| Contributor pool, AI-agent testability | Largest; headless tests are easy | Smaller | Smallest |

### Recommendation: option A

- **Engine, runtime, Console and Studio are TypeScript**, built as a static web application with no server
  dependency. Everything works from `file`-like local origins and offline.
- **Desktop shell: Electron.** It bundles Chromium, so `getUserMedia`, WebGL, WASM-SIMD and Web Workers
  behave identically on Windows and Linux. Tauri was evaluated and rejected for the Console: on Linux it
  uses the system WebKitGTK, whose default builds lack WebRTC/`getUserMedia` and have a documented slow
  WebGL path **[checked — Tauri's own Linux graphics guide and a 2026 field report]**. A webcam app cannot
  depend on that. Cost of Electron: ≈ 100 MB installer, higher RAM floor, and current Electron supports
  only 64-bit Windows 10+ and 64-bit Linux. 32-bit machines are out of scope for the packaged app but can
  still open the static build in any installed Chromium/Firefox browser.
- **Android shell: Kotlin app hosting the same bundle in the system WebView** (section 5).
- **Rendering: Playloom's own small scene runtime behind a `Renderer` interface**, starting with Canvas 2D.
  Phaser was rejected as the base because it brings its own scene and object model, which would compete
  with the declarative game format that Studio must own. PixiJS (MIT) is the intended WebGL renderer
  implementation when Enhanced-mode effects need it; it is a renderer, not a framework, so it fits behind
  the interface.

### Repository layout

The conceptual layout in the brief is kept, expressed as a pnpm workspace so the dependency rules are
enforced by the package graph rather than by convention:

```
packages/
  core/        camera, tracking backends, identity, players, gestures, calibration, performance
  simulator/   simulated PoseSource, recording/playback, fault injection
  runtime/     scenes, objects, events/rules, physics, audio, lifecycle       (Milestone 2)
  sdk/         motion-api types, game-api, game-schema (JSON Schema), templates (Milestone 2)
apps/
  playground/  Milestone 1 demo and developer tool (cursors, overlay, benchmark)
  console/     launcher, library, settings, player setup                     (Milestone 3)
  studio/      scene/object/event editors, asset manager, preview, exporter  (Milestone 5)
platforms/
  desktop/     Electron shell for Windows and Linux                          (Milestone 3)
  android/     Kotlin shell, camera bridge                                   (Milestone 4)
games/         bundled games as plain Playloom packages
docs/  tests/
```

One change from the brief: `windows/` and `linux/` merge into `platforms/desktop/` because the Electron
shell is the same code for both. The dependency rule is `core ← runtime ← {console, studio}`; games never
import `core` directly.

## 3. Can one game format serve Console and Studio?

Yes, provided the format is **the only way games are expressed**:

- A game is a JSON document (plus assets). The runtime *interprets* it. There is no compile step and no
  generated code.
- Studio is an editor for that document, and its preview embeds the very same runtime package the Console
  uses. There is no "Studio runtime".
- Bundled games live in `games/` in exactly the package form a community game would have.
- Behaviour is a list of rules — `WHEN trigger [IF conditions] THEN actions` — drawn from a closed,
  versioned vocabulary. Values are literals or references to variables/properties through a small
  expression tree. Nothing is ever passed to `eval` or `Function`.

## 4. Two-player identity

The identity layer sits between the pose backend and the game-facing API:

1. **Association.** Each frame, detections are matched to player tracks by minimum cost over a
   combination of predicted torso-centre distance (constant-velocity prediction), torso-scale similarity,
   and keypoint-wise distance. With two players this is an exhaustive comparison of the two possible
   assignments — no heuristics needed.
2. **Ambiguity margin.** The tracker records how much better the chosen assignment is than the
   alternative. When players cross or overlap, the margin collapses. Below a threshold the track state
   becomes `uncertain` instead of guessing.
3. **Recovery.** A lost track coasts on prediction briefly, then is `lost`. A returning detection is
   re-attached using side-of-frame and calibrated body scale. If two candidates are plausible, the engine
   raises `identity-uncertain`; the runtime pauses and shows a "step back to your side" prompt.
4. **Calibration.** Player setup records each player's side, shoulder width and standing height in
   normalised units. Gestures are measured relative to these, so a child and an adult both "jump" at an
   appropriate threshold.
5. **N players.** Tracks are a map keyed by player id; two is a configuration value, not a structural
   assumption. Association for N > 2 switches to the Hungarian algorithm.

## 5. Android

Facts and risks:

- UVC support is **optional** in Android. A webcam works through the platform camera API only if the
  vendor kernel has UVC enabled and the device ships the external-camera HAL; it then appears as a
  Camera2 device with `LENS_FACING_EXTERNAL` **[checked — AOSP external USB camera documentation]**.
- WebView `getUserMedia` sees only what Camera2 exposes, and reports from the field say USB cameras are
  often missing or mis-selected there **[checked — developer reports; behaviour varies by device]**.
- User-space UVC libraries (saki4510t/UVCCamera and its descendant AUSBC, both Apache-2.0) talk to the
  camera directly over USB host with libusb/libuvc and need no root. Historic versions required
  `targetSdk ≤ 27` on Android 9+; current-SDK behaviour of the maintained forks is **[unverified]**, and
  upstream activity is slow.
- Old boxes ship old WebViews. WASM-SIMD needs Chromium 91+. The WebView is updatable on Android 7+
  devices *with a working Play Store or a sideloaded WebView APK*; many no-name boxes have neither.
- 32-bit-only firmware (armeabi-v7a userspace on a 64-bit SoC) is common on cheap boxes.

Design consequence: **the motion API boundary is at the landmark level, not the pixel level.** That gives
three interchangeable capture paths, tried in order by a compatibility probe:

1. WebView `getUserMedia` → in-WebView inference (same code as desktop).
2. Native Camera2 (external camera) → native MediaPipe/LiteRT inference → landmarks over the JS bridge.
3. Native user-space UVC → native inference → landmarks over the JS bridge.

Paths 2 and 3 never send frames into the WebView, which also avoids the bridge's copy overhead.

The probe produces the compatibility report (camera path, WebView version, ABI, benchmark numbers,
selected profile). Reports are exportable as JSON and collected in `docs/hardware/compatibility.md`.
No device is listed as supported until someone has run the report on it. Android hardware acceptance
cannot be performed in this development environment and will be reported as unverified until an owner
or contributor runs it.

Launcher replacement: the app can declare `LEANBACK_LAUNCHER` (appears on the TV home row) with no risk.
Declaring `HOME` (becoming the launcher) is possible without root and will be an opt-in setting.

## 6. Performance profiles and benchmark

The startup benchmark runs each available backend for a few seconds on live or bundled frames and records
camera availability and resolution, tracking Hz per backend with one and two people, render fps, estimated
input latency (capture timestamp → API timestamp + one frame), JS heap, and the people count sustained.
Profile selection is a pure function of that report. Games declare `requires` (for example
`{ "players": 2, "tracking": "skeleton", "gestures": ["jump"] }`), and the launcher compares it with the
report to warn before launch.

## 7. Preliminary game format (`formatVersion: 1`)

A package is a ZIP file with the extension `.playloom`:

```
manifest.json      id, name, version, formatVersion, author, license, requires, entry, asset index
game.json          scenes, objects, variables, input mappings, rules
assets/…           images (PNG, JPEG, WebP), audio (OGG, MP3, WAV)
extensions/…       optional, advanced tier only; never loaded by the visual-rules runtime
```

```jsonc
{
  "formatVersion": 1,
  "meta": { "id": "org.example.mole-mayhem", "name": "Mole Mayhem", "version": "1.0.0", "license": "CC-BY-4.0" },
  "requires": { "players": { "min": 2, "max": 2 }, "tracking": "hands", "gestures": [] },
  "variables": [{ "id": "round", "type": "number", "initial": 1, "scope": "game" }],
  "inputs": {
    "p1": [{ "id": "hit", "source": { "gesture": "hand-touch", "hand": "any" } }],
    "p2": [{ "id": "hit", "source": { "gesture": "hand-touch", "hand": "any" } }]
  },
  "scenes": [{
    "id": "main", "size": [1280, 720], "background": "asset:bg",
    "objects": [
      { "id": "mole", "type": "sprite", "asset": "asset:mole", "x": 400, "y": 500, "collider": { "shape": "circle", "r": 60 } },
      { "id": "clock", "type": "timer", "seconds": 60, "autostart": true }
    ],
    "rules": [
      { "when": { "type": "hand-touches", "player": "any", "object": "mole" },
        "then": [ { "do": "add-score", "player": "$trigger.player", "amount": 10 },
                  { "do": "play-sound", "asset": "asset:bonk" },
                  { "do": "move-to-random", "object": "mole", "region": "playfield" } ] },
      { "when": { "type": "timer-ends", "object": "clock" }, "then": [ { "do": "end-round", "winner": "highest-score" } ] }
    ]
  }]
}
```

Rules for the format itself: published as JSON Schema in `packages/sdk`; additive changes bump the minor
schema revision, breaking changes bump `formatVersion` and ship a migration function; the runtime refuses
versions it does not know. Import validation enforces schema validity, a closed set of file types checked
by content signature, per-file and total size limits, entry-count limits (ZIP-bomb protection), and
normalised relative paths. A ZIP is treated only as a container — safety comes from the validator and
from the fact that game data is interpreted, never executed.

Advanced JavaScript extensions (Milestone 6) run in a sandboxed, origin-less iframe/worker with a strict
CSP (no network), talk to the runtime only through a message API, receive only the permissions listed in
the manifest, and require an explicit trust prompt at install time.

## 8. Motion API boundary

Everything above this line is game-facing and identical for camera and simulator; everything below is
replaceable.

```
Camera / native bridge / simulator
        │  PoseFrame { timestamp, people: RawPerson[] }       ← PoseSource interface
        ▼
Identity tracker → smoothing → calibration normalisation → gesture recognisers
        │
        ▼
MotionApi  (the only thing games and the rules runtime see)
```

```ts
interface MotionApi {
  readonly players: { get(id: PlayerId): PlayerState | undefined; all(): PlayerState[] };
  readonly events: { on<E extends keyof MotionEvents>(type: E, fn: (e: MotionEvents[E]) => void): Unsubscribe };
  readonly status: TrackingStatus;          // profile, backend, tracking Hz, identity confidence
}
interface PlayerState {
  id: PlayerId; present: boolean; confidence: number; identity: "locked" | "uncertain" | "lost";
  leftHand?: Point; rightHand?: Point;      // normalised 0..1, mirrored for display, origin top-left
  bodyPosition?: Point; lean: number;       // −1..1
  gestures: { jump: boolean; duck: boolean; handsUp: boolean; leftHandRaised: boolean; rightHandRaised: boolean; /* … */ };
  skeleton?: Skeleton;                      // absent in Lite mode — games must declare if they need it
}
// events: "gesture", "player-joined", "player-left", "tracking-lost", "identity-uncertain", "identity-restored"
```

Coordinates are normalised and already mirrored, so "move your right hand right" moves the cursor right.
Capabilities are explicit: a game that reads `skeleton` must say so in `requires`.

## 9. Simulator interface

The simulator is another `PoseSource`. It synthesises complete skeletons for two virtual players and
feeds the *same* tracker, so identity, smoothing and gestures are exercised for real.

- Mouse drives the selected player's active hand; `Tab` switches player, keys trigger jump, duck, lean,
  raise-hands and swipes as animated skeleton motion, not as injected events.
- Fault injection: player leaves/enters, tracking dropout, occlusion (keypoint confidence drop), players
  crossing, detection-order shuffling, jitter.
- Recording and playback of `PoseFrame` streams as JSON Lines, from either the camera or the simulator.
  Recordings contain landmarks only, never images.
- A deterministic headless mode with a virtual clock drives automated tests.

## 10. Dependencies and licensing

| Component | License | Notes |
|---|---|---|
| MediaPipe Tasks Vision + pose models | Apache-2.0 | Ship `NOTICE`; models are downloaded at build time and bundled for offline use |
| MoveNet model, LiteRT.js | Apache-2.0 | |
| ONNX Runtime Web (optional later) | MIT | |
| PixiJS (later), Vite, Vitest, Ajv, fflate | MIT | |
| TypeScript | Apache-2.0 | build-time only |
| Electron / Chromium | MIT / BSD and others | Chromium's notices ship with the binary |
| AUSBC / UVCCamera, libuvc, libusb (Android fallback) | Apache-2.0, BSD, LGPL-2.1 | libusb is LGPL: dynamic linking, as these libraries already do |

All are compatible with distribution under GPL-3.0, which is what the repository's existing `LICENSE`
file contains.

**Platform licence options**

| | GPL-3.0-or-later + game/content exception | Apache-2.0 | MPL-2.0 |
|---|---|---|---|
| Keeps forks of the console open | Yes | No | Only modified files |
| Lets a vendor preload a closed fork on hardware | No | Yes | Partly |
| Games made in Studio | Explicitly the author's own (data, not a derivative work); stated in an exception so nobody has to guess | Unrestricted | Unrestricted |
| Patent grant | Yes | Yes | Yes |
| Friction for corporate contributors | Higher | Lowest | Low |

Recommendation: **keep GPL-3.0-or-later** for the platform — it protects the "always free, no
subscription" promise against closed forks — and add (a) a written statement that game packages and
assets are independent works under their authors' chosen licences, and (b) the SDK type definitions,
JSON Schemas and templates under **MIT**, so that extension authors and third-party tools are never in
doubt. Bundled original games' art and music: CC-BY-SA-4.0.

## Decisions requiring owner approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Platform stack | Web stack in TypeScript with thin native shells |
| D2 | Desktop shell | Electron |
| D3 | Tracking strategy | Pluggable backends; MediaPipe Pose Landmarker as first Standard backend, MoveNet MultiPose as benchmarked alternative, non-ML region motion for Lite |
| D4 | Licence | Keep GPL-3.0-or-later; add game-content statement; SDK schemas/templates under MIT |
| D5 | Android approach | Kotlin shell + WebView with landmark-level native camera fallback (follows from D1) |
| D6 | Renderer | Own data-driven runtime, Canvas 2D first, PixiJS behind the same interface later |

## Sources

- [MediaPipe Pose Landmarker — web guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe PoseLandmarkerOptions reference](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.poselandmarkeroptions)
- [`@tensorflow-models/pose-detection` on npm](https://npmjs.com/package/@tensorflow-models/pose-detection)
- [MoveNet announcement, TensorFlow blog](https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html)
- [Ultralytics licensing](https://ultralytics.com/license)
- [AOSP — External USB cameras](https://source.android.com/docs/core/camera/external-usb-cameras)
- [Stack Overflow — external USB camera from an Android WebView](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/52092939/access-an-external-usb-camera-from-the-webview-in-android)
- [saki4510t/UVCCamera](https://github.com/saki4510t/UVCCamera)
- [Dynamsoft — USB camera on Android (targetSdk note)](https://www.dynamsoft.com/codepool/usb-camera-android-barcode-scanner.html)
- [Tauri — Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)
- [Hopp — field report on WebKitGTK and WebRTC](https://gethopp.app/blog/hate-webkit)
- npm registry metadata for the packages named above, queried 2026-11-10
