# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's **Report a vulnerability** button
on the repository's Security tab (private vulnerability reporting). If the button is not shown, contact the
repository owner privately through their GitHub profile instead. Include what you found, how to
reproduce it, and which version or commit is affected.

Playloom is pre-release software maintained by volunteers; reports will be acknowledged as soon as
practical, and fixes take priority over features.

## What Playloom treats as security-critical

- **Camera privacy.** Camera pictures must never be stored or transmitted. Any path by which frames,
  or data derived from them, could leave the device is a vulnerability.
- **Network silence.** Playloom's own code makes no network requests after models are fetched at build
  time. Pages ship a Content-Security-Policy that blocks outbound connections; a dependency that
  attempts to contact a server is treated as a defect (see [docs/privacy.md](docs/privacy.md)).
- **Untrusted games.** Community game packages will be treated as untrusted input: validated on import,
  interpreted rather than executed, and unable to reach the filesystem or network. (The package format
  and importer arrive in Milestones 2–3; this is the standard they will be held to.)
- **Untrusted files.** Anything a user can load — today, pose recordings — is parsed defensively.

## Supported versions

Until the first public release, only the latest commit on `main` is supported.
