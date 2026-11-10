import { clamp, handPoint, visible, type BodyMetrics } from "../geometry";
import type { Point, Skeleton } from "../types";

/** Gestures that are either happening or not. */
export const STATE_GESTURES = [
  "jump",
  "duck",
  "handsUp",
  "leftHandRaised",
  "rightHandRaised",
  "leanLeft",
  "leanRight",
] as const;
export type StateGesture = (typeof STATE_GESTURES)[number];
export type GestureName = StateGesture | "swipe";
export type GestureFlags = Record<StateGesture, boolean>;
export type SwipeDirection = "left" | "right" | "up" | "down";

export const noGestures = (): GestureFlags => ({
  jump: false,
  duck: false,
  handsUp: false,
  leftHandRaised: false,
  rightHandRaised: false,
  leanLeft: false,
  leanRight: false,
});

/**
 * Gesture thresholds, all relative to the player's own body size so that children and adults
 * trigger gestures with proportionally the same movement.
 */
export interface GestureThresholds {
  /** How far the shoulders must rise above standing height, in body sizes. */
  jump: number;
  /** How far the shoulders must drop below standing height, in body sizes. */
  duck: number;
  /** Sideways shoulder offset from the hips (body sizes) that counts as a full lean. */
  leanFull: number;
  /** Fraction of a full lean at which leanLeft / leanRight switch on. */
  lean: number;
  /** Hand speed in body sizes per second that counts as a swipe. */
  swipeSpeed: number;
  /** How far above the shoulder a wrist must be to count as raised, in body sizes. */
  raise: number;
  /** Minimum time between two swipes of the same hand. */
  swipeCooldownMs: number;
}

export const DEFAULT_THRESHOLDS: GestureThresholds = {
  jump: 0.15,
  duck: 0.3,
  leanFull: 0.4,
  lean: 0.5,
  swipeSpeed: 3,
  raise: 0.05,
  swipeCooldownMs: 300,
};

export interface GestureOccurrence {
  gesture: GestureName;
  phase: "start" | "end";
  hand?: "left" | "right";
  direction?: SwipeDirection;
  /** Body sizes per second, for swipes. */
  speed?: number;
}

export interface GestureResult {
  flags: GestureFlags;
  /** −1 (fully left on screen) to 1 (fully right). */
  lean: number;
  occurrences: GestureOccurrence[];
}

/** A gesture switches off at this fraction of its switch-on threshold, to avoid flicker at the edge. */
const HYSTERESIS = 0.6;
/** Seconds for the standing height to follow slow changes such as stepping closer. */
const BASELINE_TAU_S = 1.5;
/** A "jump" or "duck" held this long means the player moved, not gestured. */
const MAX_HOLD_MS = 4000;

interface HandTrail {
  p: Point;
  t: number;
  lastSwipe: number;
}

/** Recognises gestures for one body from its smoothed skeleton. Keep one instance per tracked body. */
export class GestureRecognizer {
  private flags = noGestures();
  private baselineY: number | null = null;
  private lastY: number | null = null;
  private lastT = 0;
  private heldSince: number | null = null;
  private hands: { left?: HandTrail; right?: HandTrail } = {};

  constructor(
    public thresholds: GestureThresholds = DEFAULT_THRESHOLDS,
    /** Above 1 makes gestures easier to trigger; below 1 harder. */
    public sensitivity = 1,
    private minScore = 0.3,
  ) {}

  /** Set the standing shoulder height from calibration. */
  setBaseline(shoulderY: number): void {
    this.baselineY = shoulderY;
  }

  update(skeleton: Skeleton, body: BodyMetrics, t: number): GestureResult {
    const th = this.thresholds;
    const sens = Math.max(this.sensitivity, 0.1);
    const scale = body.scale;
    const next = noGestures();
    const occurrences: GestureOccurrence[] = [];
    let lean = 0;

    if (scale && body.shoulderMid) {
      const y = body.shoulderMid.y;
      const dt = this.lastY === null ? 0 : (t - this.lastT) / 1000;
      const vy = dt > 0 && this.lastY !== null ? (y - this.lastY) / dt / scale : 0;
      this.lastY = y;
      this.lastT = t;
      if (this.baselineY === null) this.baselineY = y;

      const rise = (this.baselineY - y) / scale;
      const on = (current: boolean, value: number, threshold: number): boolean =>
        value > (current ? threshold * HYSTERESIS : threshold) / sens;
      next.jump = on(this.flags.jump, rise, th.jump);
      next.duck = on(this.flags.duck, -rise, th.duck);

      if (next.jump || next.duck) {
        this.heldSince ??= t;
        if (t - this.heldSince > MAX_HOLD_MS) {
          this.baselineY = y;
          next.jump = next.duck = false;
          this.heldSince = null;
        }
      } else {
        this.heldSince = null;
        // Follow slow drift only while the player is roughly still.
        if (dt > 0 && Math.abs(vy) < 0.5) this.baselineY += (y - this.baselineY) * (1 - Math.exp(-dt / BASELINE_TAU_S));
      }

      // Lean: shoulders displaced sideways relative to the hips (or, failing that, head relative to shoulders).
      const nose = visible(skeleton, "nose", this.minScore);
      if (body.hipMid) lean = (body.shoulderMid.x - body.hipMid.x) / scale / th.leanFull;
      else if (nose) lean = (nose.x - body.shoulderMid.x) / scale / th.leanFull;
      lean = clamp(lean * sens, -1, 1);
      next.leanLeft = -lean > (this.flags.leanLeft ? th.lean * HYSTERESIS : th.lean);
      next.leanRight = lean > (this.flags.leanRight ? th.lean * HYSTERESIS : th.lean);

      // Raised hands.
      const ls = visible(skeleton, "leftShoulder", this.minScore);
      const rs = visible(skeleton, "rightShoulder", this.minScore);
      const lw = visible(skeleton, "leftWrist", this.minScore);
      const rw = visible(skeleton, "rightWrist", this.minScore);
      const margin = (th.raise * scale) / sens;
      next.leftHandRaised = !!(ls && lw && lw.y < ls.y - margin);
      next.rightHandRaised = !!(rs && rw && rw.y < rs.y - margin);
      const headY = nose ? nose.y : body.shoulderMid.y - 0.45 * scale;
      next.handsUp = !!(lw && rw && lw.y < headY && rw.y < headY);
    }

    // Swipes: fast hand movement relative to the body, so that jumping, ducking or walking with
    // the arms hanging does not count. They need no skeleton beyond the hand, so Lite mode has them too.
    const unit = scale ?? 0.2;
    const origin = body.shoulderMid ?? { x: 0, y: 0 };
    for (const side of ["left", "right"] as const) {
      const hand = handPoint(skeleton, side, this.minScore);
      const trail = this.hands[side];
      if (!hand) {
        delete this.hands[side];
        continue;
      }
      const p = { x: hand.x - origin.x, y: hand.y - origin.y };
      if (trail && t > trail.t) {
        const dt = (t - trail.t) / 1000;
        const dx = (p.x - trail.p.x) / unit / dt;
        const dy = (p.y - trail.p.y) / unit / dt;
        const speed = Math.hypot(dx, dy);
        if (dt < 0.25 && speed > th.swipeSpeed / sens && t - trail.lastSwipe > th.swipeCooldownMs) {
          const direction: SwipeDirection =
            Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
          occurrences.push({ gesture: "swipe", phase: "start", hand: side, direction, speed });
          trail.lastSwipe = t;
        }
        trail.p = p;
        trail.t = t;
      } else if (!trail) {
        this.hands[side] = { p, t, lastSwipe: -Infinity };
      }
    }

    for (const g of STATE_GESTURES) {
      if (next[g] !== this.flags[g]) occurrences.push({ gesture: g, phase: next[g] ? "start" : "end" });
    }
    this.flags = next;
    return { flags: { ...next }, lean, occurrences };
  }

  /** The body is no longer visible: end whatever was in progress. */
  release(): GestureOccurrence[] {
    const occurrences: GestureOccurrence[] = [];
    for (const g of STATE_GESTURES) if (this.flags[g]) occurrences.push({ gesture: g, phase: "end" });
    this.flags = noGestures();
    this.hands = {};
    this.lastY = null;
    this.heldSince = null;
    return occurrences;
  }
}
