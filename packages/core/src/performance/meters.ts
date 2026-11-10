/** Counts events per second over a sliding window. */
export class RateMeter {
  private times: number[] = [];
  constructor(private windowMs = 2000) {}

  tick(t: number): void {
    this.times.push(t);
    const cutoff = t - this.windowMs;
    while (this.times.length > 0 && this.times[0]! < cutoff) this.times.shift();
  }

  /** Events per second, measured between the first and last event in the window. */
  rate(): number {
    if (this.times.length < 2) return 0;
    const span = this.times[this.times.length - 1]! - this.times[0]!;
    return span > 0 ? ((this.times.length - 1) * 1000) / span : 0;
  }

  reset(): void {
    this.times = [];
  }
}

/** Exponential moving average for durations. */
export class Average {
  private value: number | null = null;
  constructor(private weight = 0.1) {}

  add(sample: number): void {
    this.value = this.value === null ? sample : this.value + this.weight * (sample - this.value);
  }

  get(): number {
    return this.value ?? 0;
  }

  reset(): void {
    this.value = null;
  }
}
