# Building and testing

## Requirements

- Node.js 22 or newer
- pnpm 10 (`corepack enable` will provide the version pinned in `package.json`)

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies from the lockfile |
| `pnpm fetch-models` | Copy MediaPipe's WASM runtime and download the pose model, verifying its SHA-256 (`--all` also fetches the larger model) |
| `pnpm dev` | Run the playground with live reload |
| `pnpm test` | Run the automated tests |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Produce a static build in `apps/playground/dist` |
| `pnpm check` | Type-check, test and build |

The model files are not stored in the repository. `scripts/models.json` pins each model's URL and
checksum, so builds are reproducible and a tampered download is rejected. Without the models, the
simulator and Lite mode still work; skeleton tracking reports an error.

The static build can be served by any web server or opened through `pnpm --filter @playloom/playground preview`.
Browsers only allow camera access on `localhost` or HTTPS.

## Tests

Tests live next to each package in `test/` and run under Vitest in Node — no browser, camera or GPU.

- `packages/core/test` — the identity tracker with synthetic detections, the Lite motion analyser with
  synthetic images, filters, body measurement, MediaPipe landmark mapping, profile selection, settings.
- `packages/simulator/test` — simulated players driven through the complete engine: two-player
  independence, gestures, loss and recovery, crossing, occlusion, calibration, mirroring, and
  record/replay equivalence.

What the automated tests do **not** cover: the camera, the MediaPipe model, and the playground's user
interface. Those were exercised by hand-run browser checks recorded in [status.md](status.md); turning
them into automated browser tests is a listed task.

## Continuous integration

`.github/workflows/ci.yml` runs install, type-check, tests, model fetch and build on Ubuntu and Windows
for pushes to `main` and for pull requests.
