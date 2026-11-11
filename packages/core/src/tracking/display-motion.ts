import type { Point } from "../types";

/**
 * Display-rate motion.
 *
 * Pose results arrive at 10-20 Hz but the screen is drawn at 60 Hz or more. Showing the latest
 * result unchanged makes cursors move in steps and lag by the age of the result. A `DisplayPoint`
 * answers "where is this point *now*?" for any time: it extends the last known motion forward in
 * time (bounded and damped) and, when a new result arrives, absorbs the difference between where
 * it had guessed and where the point really is gradually instead of jumping.
 *
 * It is a pure function of the samples and the times it is given, so tests with a manual clock are
 * exactly repeatable.
 */
export interface DisplayMotionOptions {
  /** Turn display-rate motion off to get the latest tracking result unchanged. */
  enabled: boolean;
  /** Never look further ahead than this many milliseconds past the last tracking result. */
  maxPredictMs: number;
  /** Results further apart than this (tracking lost for a moment) restart the motion without gliding. */
  gapSnapMs: number;
  /** A move larger than this between two results (screen heights) is a jump, not motion: snap to it. */
  teleportDistance: number;
  /** Fastest believable hand speed in screen heights per second; faster velocities are clipped. */
  maxSpeed: number;
  /** How quickly the correction after a new result fades away. */
  blendMs: number;
  /** Time constant of the damping applied to extrapolated motion. */
  dampingMs: number;
}

export const DEFAULT_DISPLAY_MOTION: DisplayMotionOptions = {
  enabled: true,
  maxPredictMs: 80,
  gapSnapMs: 250,
  teleportDistance: 0.35,
  maxSpeed: 6,
  blendMs: 70,
  dampingMs: 200,
};

export class DisplayPoint {
  private has = false;
  private x = 0;
  private y = 0;
  private t = 0;
  private vx = 0;
  private vy = 0;
  private ox = 0;
  private oy = 0;
  private to = 0;

  constructor(private opts: DisplayMotionOptions = DEFAULT_DISPLAY_MOTION) {}

  setOptions(opts: DisplayMotionOptions): void {
    this.opts = opts;
  }

  /**
   * A tracking result for this point.
   * @param p position
   * @param t when it was captured (ms)
   * @param now when it arrived (ms), used to keep the shown position continuous
   */
  push(p: Point, t: number, now: number): void {
    const o = this.opts;
    if (!this.has) {
      this.snap(p, t);
      return;
    }
    const dt = t - this.t;
    if (dt <= 0) return;
    const jump = Math.hypot(p.x - this.x, p.y - this.y);
    if (dt > o.gapSnapMs || jump > o.teleportDistance) {
      this.snap(p, t);
      return;
    }
    const before = this.at(now);
    let vx = ((p.x - this.x) / dt) * 1000;
    let vy = ((p.y - this.y) / dt) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed > o.maxSpeed) {
      vx *= o.maxSpeed / speed;
      vy *= o.maxSpeed / speed;
    }
    this.x = p.x;
    this.y = p.y;
    this.t = t;
    this.vx = vx;
    this.vy = vy;
    const target = this.base(now);
    this.ox = before.x - target.x;
    this.oy = before.y - target.y;
    this.to = now;
  }

  /** Where the point is estimated to be at `now`. */
  at(now: number): Point {
    const b = this.base(now);
    if (this.ox === 0 && this.oy === 0) return b;
    const k = Math.exp(-Math.max(0, now - this.to) / this.opts.blendMs);
    return { x: b.x + this.ox * k, y: b.y + this.oy * k };
  }

  get started(): boolean {
    return this.has;
  }

  private snap(p: Point, t: number): void {
    this.has = true;
    this.x = p.x;
    this.y = p.y;
    this.t = t;
    this.vx = this.vy = 0;
    this.ox = this.oy = 0;
  }

  /** Last result plus damped motion, no more than `maxPredictMs` ahead. */
  private base(now: number): Point {
    const o = this.opts;
    const h = Math.min(Math.max(now - this.t, 0), o.maxPredictMs);
    // Distance travelled by a velocity that decays with time constant `dampingMs`.
    const travel = (o.dampingMs * (1 - Math.exp(-h / o.dampingMs))) / 1000;
    return { x: this.x + this.vx * travel, y: this.y + this.vy * travel };
  }
}
