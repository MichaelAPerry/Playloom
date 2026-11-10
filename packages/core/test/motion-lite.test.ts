import { describe, expect, it } from "vitest";
import { MotionEngine, MotionRegionAnalyzer, toGray, type PoseSource, type FrameSink } from "../src";

const W = 160;
const H = 120;

/** A dark frame with bright rectangles. */
function frame(...rects: Array<[x: number, y: number, w: number, h: number]>): Uint8Array {
  const g = new Uint8Array(W * H).fill(20);
  for (const [x, y, w, h] of rects) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) g[j * W + i] = 220;
  }
  return g;
}

describe("Lite motion backend", () => {
  it("reports nobody when nothing moves", () => {
    const a = new MotionRegionAnalyzer(W, H);
    let people = a.analyze(frame([20, 40, 10, 10]), 0);
    for (let t = 33; t < 1000; t += 33) people = a.analyze(frame([20, 40, 10, 10]), t);
    expect(people).toHaveLength(0);
  });

  it("ignores single-pixel sensor noise", () => {
    const a = new MotionRegionAnalyzer(W, H);
    let people = a.analyze(frame(), 0);
    for (let i = 1; i < 30; i++) {
      const f = frame();
      f[(i * 997) % f.length] = 255;
      people = a.analyze(f, i * 33);
    }
    expect(people).toHaveLength(0);
  });

  it("finds movement in each player's region independently", () => {
    const a = new MotionRegionAnalyzer(W, H);
    a.analyze(frame(), 0);
    let people = a.analyze(frame(), 33);
    for (let i = 0; i < 20; i++) {
      // Something waves only in the image's left half.
      people = a.analyze(frame([10 + (i % 2) * 12, 30, 12, 12]), 66 + i * 33);
    }
    expect(people).toHaveLength(1);
    expect(people[0]!.anchor!.x).toBeLessThan(0.5);
    expect(people[0]!.activity).toBeGreaterThan(0);
    // It was to the image-left of the body centre, i.e. the person's right hand.
    const hand = people[0]!.keypoints.rightWrist!;
    expect(hand.x).toBeCloseTo(22 / W, 1);
    expect(hand.y).toBeCloseTo(36 / H, 1);

    for (let i = 0; i < 20; i++) {
      people = a.analyze(frame([10 + (i % 2) * 12, 30, 12, 12], [120 + (i % 2) * 12, 80, 12, 12]), 800 + i * 33);
    }
    expect(people).toHaveLength(2);
  });

  it("forgets a region after movement stops", () => {
    const a = new MotionRegionAnalyzer(W, H, { presenceMs: 1000 });
    a.analyze(frame(), 0);
    for (let i = 1; i <= 5; i++) a.analyze(frame([10 + (i % 2) * 12, 30, 12, 12]), i * 33);
    const still = frame([10, 30, 12, 12]);
    expect(a.analyze(still, 500)).toHaveLength(1);
    expect(a.analyze(still, 2000)).toHaveLength(0);
  });

  it("converts RGBA to brightness", () => {
    const out = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), new Uint8Array(2));
    expect(out[0]).toBeGreaterThan(250);
    expect(out[1]).toBe(0);
  });

  it("maps regions to players by screen side through the engine, without a skeleton", () => {
    let sink: FrameSink = () => {};
    const source: PoseSource = {
      id: "motion-lite",
      capabilities: { skeleton: false, hands: "coarse", fixedRegions: true, maxPeople: 2 },
      start: async (s) => void (sink = s),
      stop: async () => {},
    };
    let clock = 0;
    const engine = new MotionEngine({ now: () => clock, mirror: true });
    const events: string[] = [];
    engine.api.events.on("player-joined", (e) => events.push(`joined:${e.player}`));
    engine.api.events.on("player-left", (e) => events.push(`left:${e.player}`));
    void engine.attach(source).then(() => engine.start());

    const a = new MotionRegionAnalyzer(W, H);
    return Promise.resolve()
      .then(() => new Promise((r) => setTimeout(r, 0)))
      .then(() => {
        a.analyze(frame(), 0);
        for (let i = 1; i <= 20; i++) {
          clock = i * 33;
          // Movement in the camera image's left half is on the right of a mirrored screen: Player 2.
          sink({ timestamp: clock, aspect: W / H, mirrored: false, people: a.analyze(frame([10 + (i % 2) * 12, 30, 12, 12]), clock) });
        }
        const p2 = engine.api.players.get(2)!;
        expect(engine.api.players.get(1)).toBeUndefined();
        expect(p2.present).toBe(true);
        expect(p2.skeleton).toBeUndefined();
        expect(p2.rightHand!.x).toBeGreaterThan(0.5);
        expect(p2.bodyPosition!.x).toBeGreaterThan(0.5);
        expect(events).toEqual(["joined:2"]);

        for (let i = 21; i <= 200; i++) {
          clock = i * 33;
          sink({ timestamp: clock, aspect: W / H, mirrored: false, people: a.analyze(frame([10, 30, 12, 12]), clock) });
        }
        expect(events).toEqual(["joined:2", "left:2"]);
        expect(engine.api.players.get(2)).toBeUndefined();
      });
  });
});
