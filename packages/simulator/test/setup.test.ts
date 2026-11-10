import { PlayerJoin, type MotionApi, type PlayerState } from "@playloom/core";
import { describe, expect, it } from "vitest";
import { rig } from "./helpers";

/** A join monitor driven by every tracking frame, as the Console does it. */
async function setup(simOptions = {}) {
  const r = await rig(simOptions);
  const join = new PlayerJoin(r.engine.api);
  const events: string[] = [];
  join.on((e) => events.push(e.type === "start" ? "start" : `${e.type}:${e.slot}`));
  r.engine.api.events.on("frame", () => join.update());
  return { ...r, join, events };
}

const RAISED = { x: 0.25, y: 0.1 };

describe("joining by raising a hand", () => {
  it("detects people in their halves without joining anyone", async () => {
    const { sim, join } = await setup();
    sim.step(1000);
    expect(join.slots.map((s) => s.detected)).toEqual([true, true]);
    expect(join.slots.map((s) => s.joined)).toEqual([false, false]);
  });

  it("joins only the side whose player raised a hand", async () => {
    const { sim, join, events } = await setup();
    sim.step(1000);
    sim.setHand(2, "left", { x: 0.75, y: 0.1 });
    sim.step(400);
    expect(join.slots.map((s) => s.joined)).toEqual([false, true]);
    expect(events).toEqual(["joined:2"]);
    sim.setHand(1, "right", RAISED);
    sim.step(400);
    expect(join.slots.map((s) => s.joined)).toEqual([true, true]);
  });

  it("does not wait on a clock: three frames of a raised hand are enough", async () => {
    const { sim, join } = await setup();
    sim.step(1000);
    sim.setHand(1, "right", RAISED);
    sim.step(600);
    expect(join.slots[0]!.joined).toBe(true);
  });

  it("numbers players by side and records their sizes when calibrated now", async () => {
    const { sim, engine, join } = await setup();
    sim.setHeight(1, 0.8);
    sim.setHeight(2, 0.5);
    sim.step(1000);
    join.confirm(1);
    join.confirm(2);
    const result = engine.calibrateNow({ ids: join.joinedIds });
    expect(Object.keys(result.players).sort()).toEqual(["1", "2"]);
    expect(result.players[1]!.x).toBeLessThan(0.5);
    expect(result.players[2]!.x).toBeGreaterThan(0.5);
    expect(result.players[1]!.scale).toBeGreaterThan(result.players[2]!.scale * 1.3);
    expect(engine.calibrationResult).toEqual(result);
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeLessThan(0.5);
  });

  it("starts when both joined players hold both hands up, after lowering them once", async () => {
    const { sim, join, events } = await setup();
    sim.step(1000);
    sim.setHandsUp(1, true);
    sim.setHandsUp(2, true);
    sim.step(1000);
    // Hands that were up while joining do not start the game by themselves.
    expect(join.slots.map((s) => s.joined)).toEqual([true, true]);
    expect(join.startRequested).toBe(false);
    sim.setHandsUp(1, false);
    sim.setHandsUp(2, false);
    sim.step(500);
    sim.setHandsUp(1, true);
    sim.step(500);
    expect(join.startRequested).toBe(false);
    sim.setHandsUp(2, true);
    sim.step(500);
    expect(join.startRequested).toBe(true);
    expect(events.at(-1)).toBe("start");
  });

  it("lets one player continue alone, keeping the side they stand on", async () => {
    const { sim, engine, join } = await setup({ players: 1 });
    sim.step(1000);
    sim.moveTo(1, 0.8);
    sim.step(2500);
    expect(join.confirm(1)).toBe(false); // nobody on the left
    expect(join.confirm(2)).toBe(true);
    const result = engine.calibrateNow({ ids: join.joinedIds });
    expect(Object.keys(result.players)).toEqual(["2"]);
    expect(result.players[2]!.x).toBeGreaterThan(0.5);
    expect(engine.api.players.get(2)!.present).toBe(true);
    expect(engine.api.players.get(1)).toBeUndefined();
  });

  it("throws when nobody is in view", async () => {
    const { engine } = await setup({ players: 1 });
    expect(() => engine.calibrateNow()).toThrow(/nobody/);
  });
});

describe("rejecting glitches", () => {
  const person = (raised: boolean): PlayerState => ({
    id: 1,
    present: true,
    confidence: 1,
    identity: "locked",
    lean: 0,
    bodyPosition: { x: 0.25, y: 0.4 },
    gestures: { leftHandRaised: raised } as PlayerState["gestures"],
  });

  function fake(): { api: MotionApi; set: (p: PlayerState | null) => void } {
    let current: PlayerState | null = person(false);
    const api = { players: { all: () => (current ? [current] : []), get: () => undefined } } as unknown as MotionApi;
    return { api, set: (p) => (current = p) };
  }

  it("ignores a hand seen raised for a single frame", () => {
    const { api, set } = fake();
    const join = new PlayerJoin(api);
    for (const raised of [false, true, false, false, true, false, true, false]) {
      set(person(raised));
      join.update();
    }
    expect(join.slots[0]!.joined).toBe(false);
  });

  it("joins once the raise is seen on three consecutive frames", () => {
    const { api, set } = fake();
    const join = new PlayerJoin(api);
    for (const raised of [true, true, true]) {
      set(person(raised));
      join.update();
    }
    expect(join.slots[0]!.joined).toBe(true);
  });
});
