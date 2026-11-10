import { describe, expect, it } from "vitest";
import { rig } from "./helpers";

/** The simulator's person 1 always raises a hand, so we can tell which tracked player they became. */
function whoHasHandsUp(engine: Awaited<ReturnType<typeof rig>>["engine"]): number[] {
  return engine.api.players.all().filter((p) => p.gestures.handsUp).map((p) => p.id);
}

describe("tracking loss and recovery", () => {
  it("rides through a short dropout without reporting loss", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.dropout(200);
    sim.step(1000);
    expect(types()).not.toContain("tracking-lost");
    expect(engine.api.players.all().every((p) => p.present)).toBe(true);
  });

  it("reports loss on a long dropout and restores the same numbers afterwards", async () => {
    const { sim, engine, types } = await rig();
    sim.setHandsUp(1, true);
    sim.step(1000);
    sim.dropout(1500);
    sim.step(1000);
    expect(types().filter((t) => t === "tracking-lost")).toHaveLength(2);
    expect(engine.api.players.get(1)!.present).toBe(false);
    expect(engine.api.players.get(1)!.identity).toBe("lost");
    sim.step(1500);
    expect(types().filter((t) => t === "tracking-restored")).toHaveLength(2);
    expect(whoHasHandsUp(engine)).toEqual([1]);
    expect(engine.api.status.identity).toBe("locked");
  });

  it("ends gestures in progress when a player is lost", async () => {
    const { sim, gestures } = await rig();
    sim.step(1000);
    sim.setHandsUp(1, true);
    sim.step(500);
    sim.setPresent(1, false);
    sim.step(1000);
    expect(gestures(1)).toContain("handsUp:end");
  });

  it("gives a returning player their number back", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.setPresent(2, false);
    sim.step(3000);
    expect(engine.api.players.get(2)!.present).toBe(false);
    expect(engine.api.players.get(1)!.present).toBe(true);
    sim.setPresent(2, true);
    sim.step(1000);
    expect(engine.api.players.get(2)!.present).toBe(true);
    expect(engine.api.players.get(2)!.bodyPosition!.x).toBeGreaterThan(0.5);
    expect(types()).not.toContain("identity-swapped");
  });

  it("frees the number after a long absence", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.setPresent(2, false);
    sim.step(12_000);
    expect(types()).toContain("player-left");
    expect(engine.api.players.get(2)).toBeUndefined();
  });

  it("keeps tracking the body when hands are hidden", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.occlude(1, 1000, "hands");
    sim.step(500);
    const p1 = engine.api.players.get(1)!;
    expect(p1.present).toBe(true);
    expect(p1.rightHand).toBeUndefined();
    expect(p1.bodyPosition).toBeDefined();
    sim.step(1000);
    expect(engine.api.players.get(1)!.rightHand).toBeDefined();
    expect(types()).not.toContain("tracking-lost");
  });

  it("still works when the camera cannot see hips", async () => {
    const { sim, engine, gestures } = await rig();
    sim.occlude(1, 60_000, "lower");
    sim.occlude(2, 60_000, "lower");
    sim.step(1000);
    expect(engine.api.players.all().map((p) => p.id)).toEqual([1, 2]);
    sim.jump(1);
    sim.step(1000);
    expect(gestures(1)).toEqual(["jump:start", "jump:end"]);
  });
});

describe("players crossing", () => {
  it("flags uncertainty instead of silently swapping, and recovers when players return to their sides", async () => {
    const { sim, engine, log } = await rig();
    sim.setHandsUp(1, true);
    sim.step(1000);
    sim.cross();
    sim.step(3000);

    // The players have changed sides. With equal body sizes nothing can prove who is who.
    const uncertain = log.filter((e) => e.type === "identity-uncertain");
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.at(-1)).toMatchObject({ needsAction: true, reason: "crossed" });
    expect(engine.api.status.identity).toBe("uncertain");
    expect(engine.api.status.needsAction).toBe(true);
    expect(engine.api.players.all().every((p) => p.identity === "uncertain")).toBe(true);

    sim.cross();
    sim.step(3000);
    expect(engine.api.status.identity).toBe("locked");
    expect(log.at(-1)!.type).toBe("identity-restored");
    // Left-to-right order is what it was before, so Player 1 is on the left again.
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeLessThan(0.5);
    expect(engine.api.players.get(2)!.bodyPosition!.x).toBeGreaterThan(0.5);
  });

  it("lets the host confirm the new arrangement", async () => {
    const { sim, engine } = await rig();
    sim.step(1000);
    sim.cross();
    sim.step(3000);
    expect(engine.api.status.needsAction).toBe(true);
    engine.confirmIdentities();
    expect(engine.api.status.identity).toBe("locked");
    expect(engine.api.status.needsAction).toBe(false);
    sim.step(1000);
    expect(engine.api.status.identity).toBe("locked");
  });

  it("uses calibrated body size to follow an adult and a child through a crossing", async () => {
    const { sim, engine, log } = await rig();
    sim.setHeight(1, 0.8);
    sim.setHeight(2, 0.5);
    sim.setHandsUp(1, true); // the adult
    sim.step(500);
    const calibration = engine.calibrate({ players: 2, durationMs: 1000 });
    sim.step(1500);
    const result = await calibration;
    expect(result.players[1]!.scale).toBeGreaterThan(result.players[2]!.scale * 1.3);

    sim.cross();
    sim.step(4000);
    // The adult is now on the right but must still be Player 1.
    expect(engine.api.status.identity).toBe("locked");
    expect(whoHasHandsUp(engine)).toEqual([1]);
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeGreaterThan(0.5);
    expect(engine.api.status.needsAction).toBe(false);
    expect(log.some((e) => e.type === "identity-swapped")).toBe(false);
  });

  it("does not raise an alarm when players merely stand close together", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.moveTo(1, 0.43);
    sim.moveTo(2, 0.57);
    sim.step(3000);
    expect(types()).not.toContain("identity-uncertain");
    expect(engine.api.status.identity).toBe("locked");
  });

  it("flags uncertainty when one player hides behind the other, then recovers", async () => {
    const { sim, engine, types } = await rig();
    sim.step(1000);
    sim.moveTo(1, 0.45);
    sim.moveTo(2, 0.55);
    sim.step(2000);
    sim.occlude(1, 800);
    sim.step(300);
    expect(engine.api.status.identity).toBe("uncertain");
    sim.step(2500);
    expect(engine.api.status.identity).toBe("locked");
    expect(types()).not.toContain("identity-swapped");
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeLessThan(engine.api.players.get(2)!.bodyPosition!.x);
  });
});

describe("calibration", () => {
  it("numbers players by side and records their size", async () => {
    const { sim, engine } = await rig();
    // Person 2 arrives first, so join order alone would have made them Player 1.
    sim.setPresent(1, false);
    sim.step(3000);
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeGreaterThan(0.5);
    sim.setPresent(1, true);
    sim.step(1000);

    const progress: number[] = [];
    engine.api.events.on("calibration-progress", (e) => progress.push(e.progress));
    const done = engine.calibrate({ players: 2, durationMs: 1000 });
    sim.step(1500);
    const result = await done;
    expect(result.players[1]!.x).toBeLessThan(0.5);
    expect(result.players[2]!.x).toBeGreaterThan(0.5);
    expect(engine.api.players.get(1)!.bodyPosition!.x).toBeLessThan(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(engine.calibrationResult).toEqual(result);
  });

  it("waits until both players stand still", async () => {
    const { sim, engine } = await rig();
    sim.step(500);
    let finished = false;
    const done = engine.calibrate({ players: 2, durationMs: 1000 }).then((r) => ((finished = true), r));
    sim.moveTo(1, 0.1);
    sim.step(400); // walking: no progress
    await Promise.resolve();
    expect(finished).toBe(false);
    sim.step(2500);
    await done;
    expect(finished).toBe(true);
  });

  it("times out when a player is missing", async () => {
    const { sim, engine } = await rig({ players: 1 });
    const done = engine.calibrate({ players: 2, durationMs: 500, timeoutMs: 2000 });
    sim.step(3000);
    await expect(done).rejects.toThrow(/timed out/);
  });
});

describe("mirroring", () => {
  it("flips unmirrored camera coordinates when mirror is on, and not when off", async () => {
    for (const mirror of [true, false]) {
      const { sim, engine } = await rig({}, { mirror });
      // The simulator declares its frames as already mirrored; with mirror off the engine un-mirrors them.
      sim.step(500);
      sim.setHand(1, "right", { x: 0.2, y: 0.3 });
      sim.step(600);
      const all = engine.api.players.all();
      const xs = all.flatMap((p) => [p.leftHand?.x ?? 9, p.rightHand?.x ?? 9]);
      const closest = Math.min(...xs.map((x) => Math.abs(x - (mirror ? 0.2 : 0.8))));
      expect(closest).toBeLessThan(0.02);
    }
  });
});
