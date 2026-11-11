/**
 * Frame pacing: how evenly the screen is being redrawn.
 *
 * Average frames per second hides stutter (60 fps with a 100 ms hitch every second still averages
 * close to 60), so the meter keeps the time between frames and reports the median, the 95th
 * percentile, the worst one and how many were "long". Hosts call `tick(now)` once per rendered
 * frame. It allocates nothing after the window has filled.
 */

/** A frame that took longer than this to arrive was visibly late on a 60 Hz screen (two refreshes). */
export const LONG_FRAME_MS = 33.4;

export interface FramePacingStats {
  /** Frames in the window the numbers describe. */
  frames: number;
  /** Frames per second over the window. */
  fps: number;
  /** Typical time between frames, milliseconds. */
  medianMs: number;
  /** 95 % of frames arrived within this time. */
  p95Ms: number;
  /** Longest gap in the window. */
  worstMs: number;
  /** Frames later than `LONG_FRAME_MS`. */
  longFrames: number;
}

export const EMPTY_PACING: FramePacingStats = { frames: 0, fps: 0, medianMs: 0, p95Ms: 0, worstMs: 0, longFrames: 0 };

/** Percentile (0..1) of an ascending-sorted array by nearest rank. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
}

/** Keeps the most recent `capacity` numbers and summarises them. */
export class RollingSamples {
  private values: number[] = [];
  private next = 0;
  private scratch: number[] = [];
  constructor(readonly capacity = 120) {}

  add(value: number): void {
    if (this.values.length < this.capacity) this.values.push(value);
    else {
      this.values[this.next] = value;
      this.next = (this.next + 1) % this.capacity;
    }
  }

  get count(): number {
    return this.values.length;
  }

  /** Samples, oldest first is not guaranteed; only for order-free statistics. */
  all(): readonly number[] {
    return this.values;
  }

  /** Percentile 0..1 of the window; 0 when empty. */
  quantile(q: number): number {
    this.scratch.length = 0;
    for (const v of this.values) this.scratch.push(v);
    this.scratch.sort((a, b) => a - b);
    return percentile(this.scratch, q);
  }

  max(): number {
    let m = 0;
    for (const v of this.values) if (v > m) m = v;
    return m;
  }

  reset(): void {
    this.values = [];
    this.next = 0;
  }
}

export class FramePacingMeter {
  private gaps: RollingSamples;
  private last: number | null = null;
  private longMs: number;

  /**
   * @param windowFrames how many recent frames the statistics cover (120 = about two seconds at 60 Hz)
   * @param longMs gaps above this count as long frames
   */
  constructor(windowFrames = 120, longMs = LONG_FRAME_MS) {
    this.gaps = new RollingSamples(windowFrames);
    this.longMs = longMs;
  }

  /** Call once per rendered frame with a monotonic time in milliseconds. */
  tick(now: number): void {
    if (this.last !== null) {
      const gap = now - this.last;
      // A hidden tab pauses animation frames for seconds; that is not stutter and would swamp the window.
      if (gap > 0 && gap < 2000) this.gaps.add(gap);
    }
    this.last = now;
  }

  stats(): FramePacingStats {
    const n = this.gaps.count;
    if (n === 0) return EMPTY_PACING;
    let sum = 0;
    let long = 0;
    for (const g of this.gaps.all()) {
      sum += g;
      if (g > this.longMs) long++;
    }
    return {
      frames: n,
      fps: sum > 0 ? (n * 1000) / sum : 0,
      medianMs: this.gaps.quantile(0.5),
      p95Ms: this.gaps.quantile(0.95),
      worstMs: this.gaps.max(),
      longFrames: long,
    };
  }

  reset(): void {
    this.gaps.reset();
    this.last = null;
  }
}
