import { describe, expect, it } from "vitest";
import { bestAssignment, IdentityTracker, type Detection, type TrackerEvent } from "../src";

/** A person described only by where they are and how big they are. */
const person = (x: number, y = 0.4, scale = 0.25, score = 0.9): Detection => ({
  person: { keypoints: {}, score },
  anchor: { x, y },
  scale,
});

/** Run the tracker at 30 Hz, returning every event with its time. */
function run(tracker: IdentityTracker, frames: number, start: number, at: (i: number) => Detection[]) {
  const events: Array<TrackerEvent & { t: number }> = [];
  let t = start;
  let last = tracker.update(at(0), t);
  events.push(...last.events.map((e) => ({ ...e, t })));
  for (let i = 1; i < frames; i++) {
    t += 1000 / 30;
    last = tracker.update(at(i), t);
    events.push(...last.events.map((e) => ({ ...e, t })));
  }
  return { events, players: last.players, t: t + 1000 / 30 };
}

describe("bestAssignment", () => {
  it("prefers the cheaper pairing and reports the margin to the alternative", () => {
    const a = bestAssignment([
      [0.1, 2],
      [2, 0.2],
    ]);
    expect(a.cols).toEqual([0, 1]);
    expect(a.margin).toBeCloseTo(3.7);
  });

  it("matches as many as possible before minimising cost", () => {
    const a = bestAssignment([
      [0.1, Infinity],
      [0.2, Infinity],
    ]);
    expect(a.count).toBe(1);
    expect(a.cols).toEqual([0, -1]);
    expect(a.margin).toBeCloseTo(0.1);
  });

  it("handles no rows or no columns", () => {
    expect(bestAssignment([]).count).toBe(0);
    expect(bestAssignment([[], []]).cols).toEqual([-1, -1]);
  });
});

describe("IdentityTracker", () => {
  it("ignores a detection that flickers for a single frame", () => {
    const tracker = new IdentityTracker();
    const { players, events } = run(tracker, 30, 0, (i) => (i === 5 ? [person(0.5), person(1.2)] : [person(0.5)]));
    expect(players.map((p) => p.id)).toEqual([1]);
    expect(events.filter((e) => e.type === "joined")).toHaveLength(1);
  });

  it("does not let a bystander take a player's number", () => {
    const tracker = new IdentityTracker();
    let s = run(tracker, 30, 0, () => [person(0.4), person(1.3)]);
    expect(s.players.map((p) => p.id)).toEqual([1, 2]);
    // A third person walks through the background, far from both.
    s = run(tracker, 90, s.t, (i) => [person(0.4), person(1.3), person(0.85, 0.2 + i * 0.001, 0.1)]);
    expect(s.players.map((p) => p.id)).toEqual([1, 2]);
    expect(s.players[0]!.anchor.x).toBeCloseTo(0.4);
    expect(s.players[1]!.anchor.x).toBeCloseTo(1.3);
    expect(s.events.filter((e) => e.type === "joined" || e.type === "swapped")).toHaveLength(0);
  });

  it("merges duplicate detections of one person", () => {
    const tracker = new IdentityTracker();
    const { players, events } = run(tracker, 60, 0, () => [person(0.5), person(0.51, 0.4, 0.25, 0.5)]);
    expect(players).toHaveLength(1);
    expect(events.some((e) => e.type === "uncertain")).toBe(false);
  });

  it("drops low-confidence detections", () => {
    const tracker = new IdentityTracker();
    const { players } = run(tracker, 30, 0, () => [person(0.5, 0.4, 0.25, 0.1)]);
    expect(players).toHaveLength(0);
  });

  it("follows a fast-moving player using velocity", () => {
    const tracker = new IdentityTracker();
    // Player 1 runs across at 1.5 units/s past a stationary player 2 standing further back.
    const s = run(tracker, 60, 0, (i) => [person(0.2 + (i / 30) * 0.6, 0.5, 0.3), person(1.4, 0.3, 0.2)]);
    expect(s.players[0]!.anchor.x).toBeGreaterThan(1.3);
    expect(s.events.some((e) => e.type === "swapped")).toBe(false);
  });

  it("is uncertain when both players vanish and return where position cannot tell them apart", () => {
    const tracker = new IdentityTracker();
    let s = run(tracker, 30, 0, () => [person(0.4), person(1.3)]);
    s = run(tracker, 60, s.t, () => []);
    expect(s.players.every((p) => p.state === "lost")).toBe(true);
    // Both come back on the same side: either could be either.
    s = run(tracker, 10, s.t, () => [person(0.1), person(0.35)]);
    expect(s.events.some((e) => e.type === "uncertain" && e.reason === "reentry")).toBe(true);
    expect(tracker.identityState).toBe("uncertain");
  });

  it("re-identifies returning players by where they were when that is clear", () => {
    const tracker = new IdentityTracker();
    let s = run(tracker, 30, 0, () => [person(0.4), person(1.3)]);
    s = run(tracker, 60, s.t, () => []);
    s = run(tracker, 30, s.t, () => [person(1.25), person(0.45)]);
    expect(tracker.identityState).toBe("locked");
    expect(s.players.find((p) => p.id === 1)!.anchor.x).toBeCloseTo(0.45);
    expect(s.players.find((p) => p.id === 2)!.anchor.x).toBeCloseTo(1.25);
  });

  it("supports more than two players when configured", () => {
    const tracker = new IdentityTracker({ maxPlayers: 4 });
    const s = run(tracker, 30, 0, () => [person(1.5), person(0.3), person(1.1), person(0.7)]);
    expect(s.players.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(s.players.map((p) => p.anchor.x)).toEqual([0.3, 0.7, 1.1, 1.5]);
  });

  it("swap() exchanges numbers on request", () => {
    const tracker = new IdentityTracker();
    let s = run(tracker, 30, 0, () => [person(0.4), person(1.3)]);
    tracker.swap(1, 2);
    s = run(tracker, 5, s.t, () => [person(0.4), person(1.3)]);
    expect(s.players.find((p) => p.id === 1)!.anchor.x).toBeCloseTo(1.3);
  });
});
