# Privacy

Playloom is used by children in their homes, with a camera pointed at them. Privacy is a design
requirement.

## What Playloom does

- **Camera pictures stay on the device.** Frames are analysed in memory to find body positions and are
  then discarded. Playloom does not record, store or transmit video or images.
- **No network use.** Playloom's own code makes no network requests. There are no accounts, analytics,
  advertising or update pings. The only download is `pnpm fetch-models` at build time, performed by the
  person building Playloom, not by players' devices.
- **Enforced, not just promised.** Every page carries a Content-Security-Policy that forbids
  connections to anything other than the app's own files. If any component tries to contact a server,
  the browser refuses and logs it.
- **Settings stay local.** Mirror, sensitivity and camera choice are stored in the browser's local
  storage on the device.
- **Player calibration is not kept.** Who stood where, and how tall they were, is held in memory for
  the current session only.
- **Pose recordings contain no images.** The developer tool can save a recording of body keypoint
  coordinates for testing. It is saved only when someone presses Record, only to a file they choose, and
  it holds numbers, not pictures. Keypoint data still describes how a person moved, so treat recordings
  of real people with care and get their agreement before sharing them.

## Third-party components

MediaPipe, the pose-estimation library, added usage reporting to Google in version 1.0.0, with no
documented way to disable it. Playloom therefore pins **version 0.10.34**, which contains no such code,
and keeps the Content-Security-Policy as a second line of defence. The owner's decision is that this
reporting is always blocked; the details are recorded as D7 in
[architecture/decisions.md](architecture/decisions.md).

**Do not upgrade `@mediapipe/tasks-vision` without re-reading its privacy notice and checking the
browser console and network panel for outbound requests.**

## How to verify

Open the playground with the browser's developer tools on the Network tab, start a camera mode, and
play. After the page and model have loaded from the local server, no further requests should appear,
and none to any other host at any time.
