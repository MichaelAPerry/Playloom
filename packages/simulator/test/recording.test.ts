import { MotionEngine, type GestureEvent } from "@playloom/core";
import { describe, expect, it } from "vitest";
import { PlaybackSource, PoseRecorder, parseRecording, SimulatorSource } from "../src";

describe("recording and playback", () => {
  it("replays a session with identical results through the same API", async () => {
    const sim = new SimulatorSource({ clock: "manual" });
    const live = new MotionEngine({ now: () => sim.now });
    const recorder = new PoseRecorder({ source: sim.id, capabilities: sim.capabilities });
    const liveEvents: GestureEvent[] = [];
    live.api.events.on("gesture", (e) => liveEvents.push(e));
    // Record by tapping the frame stream on its way into the engine.
    await sim.start(recorder.tap((f) => live.process(f)));

    sim.step(1000);
    sim.jump(1);
    sim.step(700);
    sim.setHandsUp(2, true);
    sim.step(500);
    sim.setDuck(1, true);
    sim.step(500);
    expect(liveEvents.length).toBeGreaterThanOrEqual(4);

    const text = recorder.toJSONL();
    const recording = parseRecording(text);
    expect(recording.frames.length).toBe(recorder.frames.length);
    expect(text).not.toMatch(/data:image|video/);

    let clock = 0;
    const replay = new MotionEngine({ now: () => clock });
    const replayed: GestureEvent[] = [];
    replay.api.events.on("frame", (e) => (clock = e.timestamp));
    replay.api.events.on("gesture", (e) => replayed.push(e));
    const playback = new PlaybackSource(recording, { clock: "manual", loop: false });
    await replay.attach(playback);
    await replay.start();
    playback.playAll();

    const summary = (list: GestureEvent[]): string[] => list.map((e) => `${e.player}:${e.gesture}:${e.phase}`);
    expect(summary(replayed)).toEqual(summary(liveEvents));
    expect(replay.api.status.source).toBe("playback:simulator");
  });

  it("rejects files that are not pose recordings", () => {
    expect(() => parseRecording("")).toThrow();
    expect(() => parseRecording('{"hello":1}\n')).toThrow(/Not a Playloom pose recording/);
    const header = '{"playloom":"pose-recording","version":1,"source":"x","capabilities":{}}';
    expect(() => parseRecording(`${header}\n{"timestamp":"no"}\n`)).toThrow(/not a pose frame/);
    expect(() => parseRecording(`${header}\n{"timestamp":5,"people":[]}\n{"timestamp":1,"people":[]}\n`)).toThrow(/back in time/);
  });

  it("is deterministic for a given seed", async () => {
    const run = async (): Promise<string> => {
      const sim = new SimulatorSource({ clock: "manual", seed: 42 });
      const recorder = new PoseRecorder({ source: sim.id, capabilities: sim.capabilities });
      await sim.start(recorder.tap(() => {}));
      sim.setShuffle(true);
      sim.jump(1);
      sim.step(1000);
      return recorder.toJSONL();
    };
    expect(await run()).toBe(await run());
  });
});
