# Playloom

**Play together. Create anything.**

Playloom is a free, open-source motion gaming platform. It turns a spare PC or a compatible Android TV
box, plus an ordinary webcam, into an offline two-player motion console — and it is being built so that
anyone can make their own motion games without writing code.

- **Playloom Console** — a family-friendly launcher for motion games. *(planned, Milestone 3)*
- **Playloom Engine** — camera tracking, player identity, gestures and the game runtime. *(in progress)*
- **Playloom Studio** — a visual game maker. *(planned, Milestone 5)*

No accounts, no subscriptions, no advertising, no cloud. Camera pictures are processed on the device and
never leave it. See [docs/privacy.md](docs/privacy.md).

## Where the project is

Milestones 1 and 2 are built: the motion engine and simulator, the game format and rules runtime, and
two games — **Mole Mayhem** and **Slice Party** — that are plain data files run by that runtime. There
is a developer playground to try them in; the Console and Studio do not exist yet. The detailed picture —
what works, what was tested and how, and what has not been verified — is in
[docs/status.md](docs/status.md).

## Try it in a browser (no install)

Once the repository owner has enabled GitHub Pages (Settings → Pages → Source: **GitHub Actions**), every
push to `main` publishes the playground at `https://<owner>.github.io/Playloom/`. It works in Chrome or
Edge on Windows, Linux or a Chromebook. The browser asks for camera permission only when you choose a
camera mode; pictures never leave your computer.

## Try it from source

Requirements: [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
```

```bash
pnpm fetch-models
```

```bash
pnpm dev
```

Open the address it prints. The playground starts in the **simulator**, which needs no camera: move the
mouse to steer a player's hand, and use the keys listed on the page to walk, jump, duck and lean two
players. Pick a game under **Game**. Switch the source to a camera mode to play with two real people.

`pnpm fetch-models` downloads the pose model once (about 6 MB, checksum-verified). After that,
everything runs without a network connection.

## Repository layout

```
packages/core        camera, tracking backends, player identity, gestures, calibration, performance
packages/simulator   simulated players, fault injection, pose recording and playback
packages/sdk         game format types and validator (MIT)
packages/runtime     interpreter for game definitions, canvas renderer, built-in sounds
games/               bundled games as data files
apps/playground      developer tool: motion test and game player
docs/                architecture, status, API and guides
```

The Console, Studio and platform shells arrive with their milestones; the planned
layout is in [docs/architecture/assessment.md](docs/architecture/assessment.md).

## Documentation

- [Project status and test evidence](docs/status.md)
- [Architecture assessment](docs/architecture/assessment.md) and [decisions](docs/architecture/decisions.md)
- [Motion API](docs/motion-api.md)
- [Game format](docs/game-format.md)
- [Simulator](docs/simulator.md)
- [Building and testing](docs/building.md)
- [Performance profiles and the compatibility check](docs/performance.md)
- [Hardware compatibility](docs/hardware/compatibility.md)
- [Privacy](docs/privacy.md)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Playloom is licensed under the [GNU General Public License v3.0 or later](LICENSE). Games and assets you
make with Playloom are yours, under whatever license you choose — see [LICENSING.md](LICENSING.md).
Third-party components are listed in [NOTICE.md](NOTICE.md).

Playloom is an independent project. It contains no code, assets or branding from any commercial motion
gaming product.
