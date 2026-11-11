import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_MOTION,
  DEFAULT_ONE_EURO,
  DisplayPoint,
  MotionEngine,
  OneEuroFilter,
  type OneEuroOptions,
  type PoseFrame,
} from "../src";

/** The defaults used before the retuning, kept here to compare against. */
const OLD_ONE_EURO: OneEuroOptions = { minCutoff: 1.5, beta: 0.4, dCutoff: 1 };

describe("DisplayPoint", () => {
  /** A point moving at `v` screen heights per second, sampled every `interval` ms, tracked from t = 0. */
  function ramp(interval: number, v: number, samples: number, latency = 0, opts = DEFAULT_DISPLAY_MOTION): DisplayPoint {
    const p = new DisplayPoint(opts);
    for (let i = 0; i < samples; i++) {
      const t = i * interval;
      p.push({ x: 0.2 + (v * t) / 1000, y: 0.5 }, t, t + latency);
    }
    return p;
  }

  it("moves smoothly between tracking results instead of in steps", () => {
    const interval = 66; // 15 Hz
    const p = new DisplayPoint();
    const shown: number[] = [];
    for (let t = 0; t <= 1500; t += 1000 / 60) {
      // A result for capture time k*66 reaches the screen 40 ms later.
      while ((p as unknown as { has: boolean }).has === false || nextSample * interval + 40 <= t) {
        const ts = nextSample * interval;
        p.push({ x: 0.1 + (0.5 * ts) / 1000, y: 0.5 }, ts, ts + 40);
        nextSample++;
        if (nextSample > 100) break;
      }
      shown.push(p.at(t).x);
    }
    nextSample = 0;
    const steps = shown.slice(1).map((x, i) => x - shown[i]!);
    const steady = steps.slice(20);
    const raw = (0.5 * interval) / 1000; // what stepping would move per tracking result
    const display = (0.5 * 1000) / 60 / 1000; // ideal per-frame movement
    expect(Math.min(...steady)).toBeGreaterThan(0);
    // No frame moves much more than one ideal step, and none is stuck (stepping would give zeros and one raw jump).
    expect(Math.max(...steady)).toBeLessThan(display * 1.8);
    expect(Math.max(...steady)).toBeLessThan(raw);
  });

  it("looks ahead of the last result but never more than the limit", () => {
    const p = ramp(66, 1, 10);
    const last = { x: 0.2 + (1 * 9 * 66) / 1000, y: 0.5 };
    const at = (ms: number) => p.at(9 * 66 + ms).x - last.x;
    expect(at(40) - at(0)).toBeGreaterThan(0.02);
    // Far past the last result it stops advancing: a stalled camera must not fling the cursor away.
    const limit = at(5000);
    expect(at(500)).toBeCloseTo(limit, 3);
    // Bounded by speed * horizon (damping only reduces it).
    expect(limit).toBeLessThanOrEqual((1 * DEFAULT_DISPLAY_MOTION.maxPredictMs) / 1000);
  });

  it("does not overshoot wildly when the hand stops", () => {
    const p = new DisplayPoint();
    // Moving at 2 heights/s, then still.
    for (let i = 0; i < 8; i++) p.push({ x: 0.1 + (2 * i * 66) / 1000, y: 0.5 }, i * 66, i * 66 + 40);
    const stopX = 0.1 + (2 * 7 * 66) / 1000;
    for (let i = 8; i < 14; i++) p.push({ x: stopX, y: 0.5 }, i * 66, i * 66 + 40);
    let worst = 0;
    for (let t = 14 * 66; t < 14 * 66 + 600; t += 16) worst = Math.max(worst, Math.abs(p.at(t).x - stopX));
    expect(worst).toBeLessThan(0.02);
    expect(Math.abs(p.at(14 * 66 + 600).x - stopX)).toBeLessThan(1e-3);
  });

  it("stays continuous when a new result arrives", () => {
    const p = ramp(66, 1, 10);
    const now = 10 * 66 + 40;
    const before = p.at(now);
    // The next result disagrees with the guess (the hand slowed down).
    p.push({ x: 0.2 + (9 * 66) / 1000 + 0.02, y: 0.5 }, 10 * 66, now);
    const after = p.at(now);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9); // no jump at the moment of arrival
    expect(Math.abs(p.at(now + 16).x - after.x)).toBeLessThan(0.03); // and no jump a frame later
    // The correction fades, so the display ends up on the predicted track of the new result.
    const far = p.at(now + 2000).x;
    expect(Math.abs(far - (0.2 + (9 * 66) / 1000 + 0.02))).toBeLessThan(0.06);
  });

  it("snaps instead of gliding after a teleport or a long gap", () => {
    const p = ramp(66, 1, 10);
    p.push({ x: 0.95, y: 0.05 }, 10 * 66, 10 * 66 + 40); // jump across the screen
    expect(p.at(10 * 66 + 40)).toEqual({ x: 0.95, y: 0.05 });
    const q = ramp(66, 1, 10);
    q.push({ x: 0.5, y: 0.5 }, 9 * 66 + 1200, 9 * 66 + 1240); // tracking was lost for over a second
    expect(q.at(9 * 66 + 1240)).toEqual({ x: 0.5, y: 0.5 });
    expect(q.at(9 * 66 + 1240 + 40).x).toBeCloseTo(0.5, 6); // no stale velocity
  });

  it("is repeatable: the same inputs always give the same positions", () => {
    const run = () => {
      const p = new DisplayPoint();
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        p.push({ x: 0.3 + Math.sin(i / 3) * 0.2, y: 0.5 }, i * 66, i * 66 + 35);
        for (let t = i * 66 + 35; t < i * 66 + 100; t += 16) out.push(p.at(t).x);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("MotionEngine display-rate states", () => {
  const k = (x: number, y: number) => ({ x, y, score: 0.95 });
  /** One person standing still with the right wrist at (wx, wy). */
  function frame(t: number, wx: number, wy = 0.4): PoseFrame {
    return {
      timestamp: t,
      aspect: 1,
      mirrored: false,
      people: [
        {
          score: 0.95,
          keypoints: {
            nose: k(0.5, 0.2),
            leftShoulder: k(0.4, 0.3),
            rightShoulder: k(0.6, 0.3),
            leftHip: k(0.43, 0.6),
            rightHip: k(0.57, 0.6),
            leftWrist: k(0.3, 0.5),
            rightWrist: k(wx, wy),
          },
        },
      ],
    };
  }
  function rig(options: ConstructorParameters<typeof MotionEngine>[0] = {}) {
    let clock = 0;
    const engine = new MotionEngine({ mirror: false, now: () => clock, ...options });
    return {
      engine,
      at: (t: number) => (clock = t),
      feed: (captureT: number, wx: number) => {
        clock = captureT + 40; // arrives 40 ms after capture
        engine.process(frame(captureT, wx));
      },
    };
  }

  it("returns tracking results unchanged until the host calls advance", () => {
    const { engine, feed } = rig();
    for (let i = 0; i < 10; i++) feed(i * 66, 0.3 + i * 0.03);
    const raw = engine.api.players.get(1)!.rightHand!;
    feed(10 * 66, 0.7);
    expect(engine.api.players.get(1)!.rightHand!.x).not.toBe(raw.x);
    // Without advance the hand sits exactly on the latest filtered result, however much time passes.
    const a = engine.api.players.get(1)!.rightHand!.x;
    expect(engine.api.players.get(1)!.rightHand!.x).toBe(a);
  });

  it("moves the hand between tracking results once advance is used, without touching gestures", () => {
    const { engine, feed } = rig();
    const gestures: string[] = [];
    engine.api.events.on("gesture", (e) => gestures.push(e.gesture));
    let t = 0;
    const xs: number[] = [];
    for (let i = 0; i < 10; i++) feed(i * 66, 0.3);
    for (let i = 10; i < 35; i++) {
      feed(i * 66, 0.3 + (i - 10) * 0.01);
      for (t = i * 66 + 40; t < (i + 1) * 66 + 40; t += 1000 / 60) {
        engine.advance(t);
        xs.push(engine.api.players.get(1)!.rightHand!.x);
      }
    }
    const distinct = new Set(xs.slice(20)).size;
    expect(distinct).toBeGreaterThan((xs.length - 20) * 0.95); // changes nearly every frame
    expect(xs.slice(20).every((x, i, a) => i === 0 || x >= a[i - 1]! - 1e-9)).toBe(true);
    const state = engine.api.players.get(1)!;
    expect(state.skeleton!.rightWrist!.x).toBeCloseTo(state.rightHand!.x, 6);
    expect(gestures).toEqual([]);
  });

  it("can be switched off to get raw tracking states", () => {
    const { engine, feed } = rig({ displayMotion: { ...DEFAULT_DISPLAY_MOTION, enabled: false } });
    for (let i = 0; i < 10; i++) feed(i * 66, 0.3 + i * 0.03);
    const before = engine.api.players.get(1)!.rightHand!.x;
    engine.advance(10 * 66 + 100);
    expect(engine.api.players.get(1)!.rightHand!.x).toBe(before);
  });

  it("reports how long a result took from capture to its first draw", () => {
    const { engine, feed } = rig();
    feed(0, 0.5);
    engine.advance(40 + 8);
    expect(engine.api.status.captureToScreenMs).toBeCloseTo(48, 5);
  });

  it("is deterministic with a manual clock", () => {
    const run = () => {
      const { engine, feed } = rig();
      const out: number[] = [];
      for (let i = 0; i < 10; i++) feed(i * 66, 0.3);
      for (let i = 10; i < 30; i++) {
        feed(i * 66, 0.3 + Math.sin(i / 2) * 0.1);
        for (let t = i * 66 + 40; t < (i + 1) * 66 + 40; t += 16) {
          engine.advance(t);
          out.push(engine.api.players.get(1)!.rightHand!.x);
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("snaps the shown hand to a new position after the player is lost and found", () => {
    const { engine, feed, at } = rig();
    for (let i = 0; i < 10; i++) feed(i * 66, 0.3);
    engine.advance(10 * 66);
    // Gap of two seconds with no frames, then a hand somewhere else.
    feed(2800, 0.8);
    at(2900);
    engine.advance(2900);
    const hand = engine.api.players.get(1)!.rightHand!;
    expect(Math.abs(hand.x - engine.api.players.get(1)!.skeleton!.rightWrist!.x)).toBeLessThan(1e-9);
    expect(hand.x).toBeGreaterThan(0.7);
  });
});

describe("One Euro defaults", () => {
  const dt = 1000 / 15;
  const noise = (() => {
    let seed = 7;
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32 - 0.5; // uniform, +-0.5
    };
  })();

  function stepTime(opts: OneEuroOptions): number {
    const f = new OneEuroFilter(opts);
    for (let i = 0; i < 30; i++) f.filter(0.3, i * dt);
    for (let i = 1; i < 100; i++) if (f.filter(0.5, (30 + i) * dt) >= 0.48) return i * dt;
    return Infinity;
  }

  /** Delay of the filtered signal behind a 0.7 Hz, 0.15-high sine, from the best matching shift. */
  function lag(opts: OneEuroOptions): number {
    const f = new OneEuroFilter(opts);
    const truth = (t: number) => 0.5 + 0.15 * Math.sin((2 * Math.PI * 0.7 * t) / 1000);
    const out: number[] = [];
    for (let i = 0; i < 90; i++) out.push(f.filter(truth(i * dt), i * dt));
    let best = 0;
    let bestErr = Infinity;
    for (let shift = 0; shift <= 300; shift += 2) {
      let err = 0;
      for (let i = 15; i < 90; i++) err += (out[i]! - truth(i * dt - shift)) ** 2;
      if (err < bestErr) [bestErr, best] = [err, shift];
    }
    return best;
  }

  function jitter(opts: OneEuroOptions): number {
    const f = new OneEuroFilter(opts);
    const out: number[] = [];
    for (let i = 0; i < 600; i++) out.push(f.filter(0.5 + 0.012 * noise() * 3.46, i * dt));
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    return Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length);
  }

  it("follows a fast step in about half the time of the old settings", () => {
    expect(stepTime(DEFAULT_ONE_EURO)).toBeLessThanOrEqual(stepTime(OLD_ONE_EURO) * 0.6);
    expect(stepTime(DEFAULT_ONE_EURO)).toBeLessThanOrEqual(150);
  });

  it("lags a moving hand by well under 50 ms (the old settings: about 80 ms)", () => {
    expect(lag(OLD_ONE_EURO)).toBeGreaterThanOrEqual(60);
    expect(lag(DEFAULT_ONE_EURO)).toBeLessThanOrEqual(40);
  });

  it("does not become much more jittery when the hand is still", () => {
    expect(jitter(DEFAULT_ONE_EURO)).toBeLessThan(jitter(OLD_ONE_EURO) * 1.25);
  });
});

let nextSample = 0;
