# Contributing to Playloom

Thank you for helping. Playloom is meant to be built in the open by families, teachers, hobbyists and
developers, so contributions of every size are welcome: bug reports, hardware compatibility reports,
documentation, tests, code, and eventually games.

## Ground rules

These come from the project's purpose and are not up for negotiation in a pull request:

- Two-player support, offline operation and privacy are requirements, not features.
- No accounts, advertising, subscriptions, analytics or cloud processing.
- No code, assets or branding from commercial motion gaming products. Everything must be original or
  properly licensed.
- Report only what you actually ran. Do not describe a build, test or hardware result as passing unless
  you saw it pass.

Product direction and significant features are decided by the project owner. If you want to propose
something large, open an issue first.

## Getting set up

See [docs/building.md](docs/building.md). In short:

```bash
pnpm install
```

```bash
pnpm fetch-models
```

```bash
pnpm check
```

You do not need a webcam or a second person: the [simulator](docs/simulator.md) drives the same code
paths as a camera, and the automated tests run entirely on simulated motion.

## Making a change

1. Add or update tests. Tracking and gesture behaviour is tested by driving simulated players through
   the real pipeline — see `packages/simulator/test`.
2. Run `pnpm check` (type-check, tests, build).
3. Keep changes focused, and explain *why* in the pull request.
4. Update the documentation and [docs/status.md](docs/status.md) when behaviour changes.

## Where things go

`packages/core` must not depend on anything game- or UI-specific. Games will never import `core`
directly; they see only the motion API. Dependencies must have a license compatible with GPL-3.0, must
work offline, and must not send data anywhere — check before adding one, and record it in
[NOTICE.md](NOTICE.md).

## Hardware reports

Run the compatibility check in the playground, save the report, and open an issue with the JSON file
and a description of the device and camera. See [docs/hardware/compatibility.md](docs/hardware/compatibility.md).

## Licensing of contributions

By contributing you agree that your contribution is licensed under GPL-3.0-or-later (or MIT for the SDK
schema, type and template files described in [LICENSING.md](LICENSING.md)), and that you have the right
to submit it.
