# Motion API

The motion API is the only thing a game, the rules runtime or Studio's preview ever sees of the
tracking system. It is identical whether the frames come from a camera, the simulator or a recording.

Status: implemented in `packages/core` (`MotionEngine`). The API will be re-exported from the SDK
package when that is introduced in Milestone 2, and may still change before the first release.

## Reading players

```ts
import { MotionEngine } from "@playloom/core";
import { SimulatorSource } from "@playloom/simulator";

const engine = new MotionEngine();           // two players, mirrored, default thresholds
await engine.attach(new SimulatorSource());  // or new MediaPipePoseSource(), new MotionLiteSource()
await engine.start();

const playloom = engine.api;

const p1 = playloom.players.get(1);
const p2 = playloom.players.get(2);

p1?.rightHand;        // { x, y } on screen, 0..1 from the top-left; undefined if not visible
p1?.bodyPosition;     // centre of the shoulders
p2?.gestures.jump;    // true while it is happening
p2?.lean;             // −1 (left) … 1 (right)

playloom.events.on("gesture", (e) => {
  if (e.gesture === "jump" && e.phase === "start") { /* e.player jumped */ }
});
```

### `PlayerState`

| Field | Meaning |
|---|---|
| `id` | Player number, starting at 1 |
| `present` | False while the player cannot be seen; their number stays reserved for 10 s |
| `identity` | `locked`, `uncertain` (the engine is not sure this is still the same person) or `lost` |
| `confidence` | 0..1, how well the upper body is seen |
| `leftHand`, `rightHand` | Screen position of each hand; the finger tip where the backend provides one |
| `bodyPosition` | Screen position of the shoulder centre |
| `lean` | −1..1 |
| `gestures` | `jump`, `duck`, `handsUp`, `leftHandRaised`, `rightHandRaised`, `leanLeft`, `leanRight` |
| `activity` | 0..1 amount of movement (Lite mode only) |
| `skeleton` | Smoothed keypoints on screen. **Absent in Lite mode.** |

Coordinates are screen coordinates: already mirrored when mirroring is on, so a player who moves their
right hand to their right sees the cursor move right. "Left" and "right" hands are the player's own.

### Events

| Event | Payload | When |
|---|---|---|
| `gesture` | `player`, `gesture`, `phase` (`start`/`end`), and for swipes `hand`, `direction`, `speed` | A gesture begins or ends. `swipe` only has `start`. |
| `player-joined` / `player-left` | `player` | A new player is confirmed / a lost player's reservation expires |
| `tracking-lost` / `tracking-restored` | `player` | A player has been unseen for more than 0.4 s / is back |
| `identity-uncertain` | `players`, `reason` (`overlap`, `crossed`, `reentry`), `needsAction` | See below |
| `identity-restored` | `players` | Identity is certain again |
| `identity-swapped` | `players` | Player numbers were exchanged (by setup, by size evidence, or on request) |
| `calibration-progress` | `progress` 0..1, `playersSeen` | During player setup |
| `frame` | `timestamp` | After every tracking update |

### Status

`playloom.status` reports `source`, `capabilities`, `trackingHz`, `latencyMs`, `processingMs`,
`captureToScreenMs`, `identity`, `needsAction` and `peopleInView`.

### Display-rate motion

Pose results arrive at 10-20 Hz; screens draw at 60 Hz or more. If the host calls

```ts
engine.advance(now);   // once per rendered frame; same clock as frame timestamps (performance.now())
```

then `players.get()` / `players.all()` return the state **for that moment**: hands, body position and
skeleton are interpolated between tracking results and extended past the latest one, by at most 80 ms
and with damping, so cursors move on every drawn frame and the capture delay is partly compensated. A
result that is far from the previous one (over 0.35 screen heights) or arrives after a gap (over 250 ms)
is shown at once, not glided to. Gestures, `present`, `confidence`, identity and `lean` always come from
real tracking frames, and gesture detection never sees predicted positions. Games and the runtime need no
change: they read the same API. Without `advance` the API returns the latest tracking result, exactly as
before, so tests with a manual clock are unaffected and repeatable (the same calls always give the same
numbers). Options: `new MotionEngine({ displayMotion: { ...DEFAULT_DISPLAY_MOTION, maxPredictMs: 50 } })`
or `engine.configure({ displayMotion: { enabled: false } })`.

`engine.sourceDiagnostics()` returns what the active camera backend measured (camera size and delivered
fps, model time, analysed size); the performance panel (`DiagnosticsPanel`) and `buildDiagnostics` use it.

## Identity: what the engine promises

Pose models return an unordered list of people. Playloom's identity tracker turns that into stable
player numbers and — this is the important part — **says so when it is not sure**:

- Players are numbered left to right when they join together, and by **player setup**
  (`engine.calibrate()`), which also records each player's size and standing height.
- Short dropouts (under 0.4 s) are bridged. A player who leaves and returns gets their number back.
- When players overlap, hide one another, or return in a doubtful arrangement, they become `uncertain`
  and `identity-uncertain` fires.
- If the players' calibrated sizes differ clearly (by 30 % or more — typically an adult and a child),
  size is used to settle who is who.
- Otherwise identity is defined by side. If the players end up in the same left-to-right order as
  before, identity is restored automatically. If they have changed sides, `needsAction` becomes true
  and stays true until they step back, or the host calls `engine.confirmIdentities()` or
  `engine.swapPlayers()`.

A game or the Console should pause and show a prompt while `status.needsAction` is true.

**Known limit:** two people of similar size who swap places *while both are out of view* and return on
each other's side cannot be told apart by any skeleton-only tracker. They will be numbered by side.

## Capabilities

Not every device can provide everything. `status.capabilities` says what the active source offers:

| | `skeleton` | `hands` | `fixedRegions` |
|---|---|---|---|
| MediaPipe (Standard / Enhanced) | yes | `precise` | no |
| Lite motion regions | no | `coarse` | yes — the player is whoever is in that half of the picture |
| Simulator | yes | `precise` | no |

In Lite mode there is no skeleton, so `jump`, `duck`, lean and raised-hand gestures are never reported;
hands, `swipe` and `activity` are. Games will declare what they need, and the launcher will compare that
with the device's compatibility report.

## Configuration

```ts
new MotionEngine({ maxPlayers: 2, mirror: true, sensitivity: 1, thresholds: { ...DEFAULT_THRESHOLDS } });
engine.configure({ sensitivity: 1.5 });      // easier gestures, e.g. for small children
```

Gesture thresholds are expressed in body sizes (shoulder-to-hip length), so they scale with the player.
`maxPlayers` is a setting, not a structural limit; the tracker is tested with four.

## Writing a pose source

A source implements `PoseSource` and delivers `PoseFrame`s — a timestamp and a list of people with
named keypoints in 0..1 image coordinates. That is the whole contract, and it is the boundary at which a
native Android camera pipeline will plug in. See `packages/core/src/types.ts`.
