# Simulator

The simulator lets you develop and test Playloom without a camera or a second person.

It is not a shortcut around the tracking system. The simulator generates complete skeletons for virtual
people and feeds them into the same identity tracker, smoothing and gesture recognition a camera feeds.
A simulated jump is a body that really moves up and comes back down, so what works in the simulator has
been through the real pipeline — and games cannot tell the difference, because the motion API is the
same.

## In the playground

Run `pnpm dev` and keep the source set to **Simulator**.

| Input | Action |
|---|---|
| Mouse | Move the selected player's right hand (hold Shift for the left hand) |
| `1` / `2` | Select which player the mouse controls |
| `A` `D` · `J` `L` | Walk (Player 1 · Player 2) |
| `W` · `I` | Jump |
| `S` · `K` | Duck (hold) |
| `Q` `E` · `U` `O` | Lean (hold) |
| `F` · `H` | Hands up (hold) |
| `R` · `P` | Swipe |
| `X` | Selected player leaves / returns |
| `Z` | Tracking dropout for 1 second |
| `C` | Hide the selected player for 1.5 seconds |
| `V` | Players swap places |
| `B` | Toggle random detection order |
| `Esc` | Relax the selected player's arms |

Try `V`: the players cross, the engine reports that identity is uncertain and asks them to step back;
press `V` again and it recovers.

## In tests

With the manual clock, time only moves when you say so, which makes tests exact and fast.

```ts
import { MotionEngine } from "@playloom/core";
import { SimulatorSource } from "@playloom/simulator";

const sim = new SimulatorSource({ clock: "manual" });
const engine = new MotionEngine({ now: () => sim.now });
await engine.attach(sim);
await engine.start();

sim.step(1000);          // one second passes; both players are found
sim.jump(2);
sim.step(1000);          // Player 2's jump:start and jump:end events have fired
```

Controls: `setHand`, `setHandsUp`, `jump`, `setDuck`, `setLean`, `moveTo`, `setWalking`, `teleport`,
`setHeight`, `swipe`, `setPresent`, `cross`.
Faults: `dropout(ms)`, `occlude(player, ms, "all" | "hands" | "lower")`, `setShuffle(on)`, plus keypoint
noise (`noise`, `seed` options).

## Recording and playback

Any frame stream — camera or simulator — can be recorded and replayed:

```ts
const recorder = new PoseRecorder({ source: source.id, capabilities: source.capabilities });
await source.start(recorder.tap((frame) => engine.process(frame)));
// …
const text = recorder.toJSONL();

const playback = new PlaybackSource(parseRecording(text), { clock: "manual", loop: false });
```

In the playground, **Record** saves a `.jsonl` file and **Play recording…** loops one. Recordings hold
keypoint coordinates only, never images; recordings of real play sessions make good regression tests.

## Limits of the simulator

Simulated skeletons are clean and geometric. They do not reproduce what a real pose model does with
poor light, loose clothing, motion blur or a partly visible body. The simulator proves the logic above
the model; only tests with real cameras and people prove the tracking quality.
