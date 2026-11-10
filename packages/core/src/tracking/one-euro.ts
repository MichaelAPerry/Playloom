/**
 * One Euro filter (Casiez, Roussel, Vogel 2012): low-pass filtering whose cutoff rises with speed,
 * so a still hand does not jitter and a fast hand does not lag.
 */
export interface OneEuroOptions {
  /** Hz. Lower = smoother when still. */
  minCutoff: number;
  /** Higher = less lag when moving fast. */
  beta: number;
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroOptions = { minCutoff: 1.5, beta: 0.4, dCutoff: 1 };

const alpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(private opts: OneEuroOptions = DEFAULT_ONE_EURO) {}

  /** @param t timestamp in milliseconds */
  filter(value: number, t: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = (t - this.t) / 1000;
    if (dt <= 0) return this.x;
    // After a long gap the old state says nothing about the present.
    if (dt > 0.5) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.opts.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    this.t = t;
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
