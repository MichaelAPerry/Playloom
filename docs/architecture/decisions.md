# Architecture decisions

Decisions made by the project owner. The reasoning and the alternatives considered are in
[assessment.md](assessment.md).

| # | Decision | Status | Date |
|---|---|---|---|
| D1 | **Web stack.** Engine, runtime, Console and Studio are TypeScript running in a Chromium-class webview, with thin native shells per platform. | Approved | 2026-11-10 |
| D2 | **Electron** is the desktop shell for Windows and Linux. | Approved | 2026-11-10 |
| D3 | **Pluggable tracking backends** behind one interface: MediaPipe Pose Landmarker first, MoveNet MultiPose as a benchmarked alternative, non-ML motion regions for Lite. Playloom's own identity tracker sits above all of them, and the startup benchmark chooses per device. | Approved | 2026-11-10 |
| D4 | **GPL-3.0-or-later** for the platform, with a written statement that games and assets belong to their authors, and MIT for SDK schemas, type definitions and templates. | Approved | 2026-11-10 |
| D5 | Android: Kotlin shell hosting the same web bundle, with native camera capture and inference feeding landmarks over the bridge where the WebView cannot see the camera. | Follows from D1; to be confirmed at Milestone 4 | — |
| D6 | Rendering: Playloom's own data-driven runtime, Canvas 2D first, PixiJS behind the same interface when needed. | Follows from D1; to be confirmed at Milestone 2 | — |
| D7 | **MediaPipe version and telemetry** — see below. | **Needs owner decision** | — |

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

**Recommendation:** A now, and treat the MoveNet backend already planned under D3 as the route to C —
choosing between them by benchmark once both exist. B is not recommended.
