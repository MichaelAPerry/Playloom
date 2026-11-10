import { describe, expect, it } from "vitest";
import { rig } from "./helpers";

describe("two players through the full pipeline", () => {
  it("numbers players left to right and reports both as present", async () => {
    const { sim, engine, types } = await rig();
    sim.step(500);
    const [p1, p2] = engine.api.players.all();
    expect(p1?.id).toBe(1);
    expect(p2?.id).toBe(2);
    expect(p1!.present && p2!.present).toBe(true);
    expect(p1!.bodyPosition!.x).toBeLessThan(p2!.bodyPosition!.x);
    expect(types().filter((t) => t === "player-joined")).toHaveLength(2);
    expect(engine.api.status.identity).toBe("locked");
  });

  it("gives each player independent hand cursors", async () => {
    const { sim, engine } = await rig();
    sim.step(500);
    sim.setHand(1, "right", { x: 0.2, y: 0.3 });
    sim.setHand(2, "left", { x: 0.8, y: 0.6 });
    sim.step(600);
    const p1 = engine.api.players.get(1)!;
    const p2 = engine.api.players.get(2)!;
    expect(p1.rightHand!.x).toBeCloseTo(0.2, 1);
    expect(p1.rightHand!.y).toBeCloseTo(0.3, 1);
    expect(p2.leftHand!.x).toBeCloseTo(0.8, 1);
    expect(p2.leftHand!.y).toBeCloseTo(0.6, 1);

    // Moving one player's hand must not move the other's.
    const before = { ...p2.leftHand! };
    sim.setHand(1, "right", { x: 0.35, y: 0.7 });
    sim.step(600);
    const after = engine.api.players.get(2)!.leftHand!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.01);
    expect(engine.api.players.get(1)!.rightHand!.y).toBeCloseTo(0.7, 1);
  });

  it("keeps numbers stable when the backend reports people in random order", async () => {
    const { sim, engine, types } = await rig();
    sim.setShuffle(true);
    sim.step(500);
    for (let i = 0; i < 300; i++) {
      // Both players move around on their own sides.
      sim.moveTo(1, 0.25 + 0.1 * Math.sin(i / 7));
      sim.moveTo(2, 0.75 + 0.1 * Math.cos(i / 5));
      sim.step(33.4);
      expect(engine.api.players.get(1)!.bodyPosition!.x).toBeLessThan(0.5);
      expect(engine.api.players.get(2)!.bodyPosition!.x).toBeGreaterThan(0.5);
    }
    expect(types()).not.toContain("identity-swapped");
    expect(types()).not.toContain("identity-uncertain");
  });

  it("supports one player alone", async () => {
    const { sim, engine } = await rig({ players: 1 });
    sim.step(500);
    expect(engine.api.players.all().map((p) => p.id)).toEqual([1]);
  });

  it("reports tracking rate and latency", async () => {
    const { sim, engine } = await rig({ hz: 20 });
    sim.step(3000);
    const status = engine.api.status;
    expect(status.trackingHz).toBeGreaterThan(19);
    expect(status.trackingHz).toBeLessThan(21);
    expect(status.source).toBe("simulator");
    expect(status.peopleInView).toBe(2);
  });
});

describe("gestures", () => {
  it("attributes a jump to the player who jumped, once", async () => {
    const { sim, gestures } = await rig();
    sim.step(1000);
    sim.jump(2);
    sim.step(1000);
    expect(gestures(2)).toEqual(["jump:start", "jump:end"]);
    expect(gestures(1)).toEqual([]);
  });

  it("detects ducking while held", async () => {
    const { sim, engine, gestures } = await rig();
    sim.step(1000);
    sim.setDuck(1, true);
    sim.step(600);
    expect(engine.api.players.get(1)!.gestures.duck).toBe(true);
    expect(engine.api.players.get(2)!.gestures.duck).toBe(false);
    sim.setDuck(1, false);
    sim.step(600);
    expect(engine.api.players.get(1)!.gestures.duck).toBe(false);
    expect(gestures(1)).toEqual(["duck:start", "duck:end"]);
  });

  it("reports lean direction and amount", async () => {
    const { sim, engine } = await rig();
    sim.step(1000);
    sim.setLean(1, -1);
    sim.setLean(2, 1);
    sim.step(600);
    const p1 = engine.api.players.get(1)!;
    const p2 = engine.api.players.get(2)!;
    expect(p1.gestures.leanLeft).toBe(true);
    expect(p1.lean).toBeLessThan(-0.5);
    expect(p2.gestures.leanRight).toBe(true);
    expect(p2.lean).toBeGreaterThan(0.5);
  });

  it("detects raised hands", async () => {
    const { sim, engine, gestures } = await rig();
    sim.step(1000);
    sim.setHandsUp(2, true);
    sim.step(400);
    const g = engine.api.players.get(2)!.gestures;
    expect(g.handsUp && g.leftHandRaised && g.rightHandRaised).toBe(true);
    expect(engine.api.players.get(1)!.gestures.handsUp).toBe(false);
    expect(gestures(2)).toContain("handsUp:start");
  });

  it("detects a swipe with its hand and direction", async () => {
    const { sim, log } = await rig();
    sim.step(1000);
    // Placing the hand is itself an instant movement, so only look at what happens afterwards.
    sim.setHand(1, "right", { x: 0.3, y: 0.4 });
    sim.step(800);
    const since = sim.now;
    sim.swipe(1, "right", "right");
    sim.step(500);
    const swipes = log.filter((e) => e.type === "gesture" && e.gesture === "swipe" && (e.timestamp as number) > since);
    expect(swipes).toHaveLength(1);
    expect(swipes[0]).toMatchObject({ player: 1, hand: "right", direction: "right" });
  });

  it("does not report gestures for a player who is standing still", async () => {
    const { sim, gestures } = await rig();
    sim.step(10_000);
    expect(gestures()).toEqual([]);
  });

  it("scales thresholds to body size, so a small player's jump still counts", async () => {
    const { sim, gestures } = await rig();
    sim.setHeight(1, 0.4); // a child standing far back
    sim.step(1000);
    sim.jump(1);
    sim.step(1000);
    expect(gestures(1)).toEqual(["jump:start", "jump:end"]);
  });

  it("honours sensitivity", async () => {
    const { sim, gestures } = await rig({}, { sensitivity: 0.25 });
    sim.step(1000);
    sim.jump(1);
    sim.step(1000);
    expect(gestures(1)).toEqual([]);
  });
});
