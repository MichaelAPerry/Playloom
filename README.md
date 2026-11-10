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

Playloom is at **Milestone 1: motion engine and simulator**. What exists today is the tracking
foundation and a developer playground, not yet a console or games. The honest, detailed picture —
what works, what was tested and how, and what has not been verified — is in
[docs/status.md](docs/status.md).

## Try it

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
players. Switch the source to a camera mode to try real tracking with two people.

`pnpm fetch-models` downloads the pose model once (about 6 MB, checksum-verified). After that,
everything runs without a network connection.

## Repository layout

```
packages/core        camera, tracking backends, player identity, gestures, calibration, performance
packages/simulator   simulated players, fault injection, pose recording and playback
apps/playground      developer tool and Milestone 1 demo
docs/                architecture, status, API and guides
```

The runtime, SDK, Console, Studio, platform shells and games arrive with their milestones; the planned
layout is in [docs/architecture/assessment.md](docs/architecture/assessment.md).

## Documentation

- [Project status and test evidence](docs/status.md)
- [Architecture assessment](docs/architecture/assessment.md) and [decisions](docs/architecture/decisions.md)
- [Motion API](docs/motion-api.md)
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
