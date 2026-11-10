import { onVideoFrame, openCamera, type CameraRequest, type OpenCamera } from "../camera/camera";
import type { FrameSink, PoseSource, RawPerson, SourceCapabilities } from "../types";

/**
 * Lite backend: no neural network. Each player owns one vertical strip of the picture, and the
 * backend looks at what moved in that strip between frames.
 *
 * What it provides: a body position, coarse left- and right-hand positions that follow whatever
 * is moving on each side of the body, and an activity level. What it cannot provide: a skeleton,
 * jump/duck/lean, or any way to tell players apart other than by where they stand.
 */

export interface MotionLiteOptions {
  /** Number of side-by-side player regions. */
  regions: number;
  /** Brightness change (0..255) for a pixel to count as moving. */
  pixelThreshold: number;
  /** Fraction of a region that must be moving before it counts as activity (rejects sensor noise). */
  minActivity: number;
  /** A region with no movement for this long is treated as empty. */
  presenceMs: number;
}

export const DEFAULT_MOTION_LITE: MotionLiteOptions = {
  regions: 2,
  pixelThreshold: 28,
  minActivity: 0.004,
  presenceMs: 4000,
};

interface RegionState {
  bodyX: number;
  bodyY: number;
  hands: { left: { x: number; y: number; seen: number } | null; right: { x: number; y: number; seen: number } | null };
  lastActive: number;
  activity: number;
}

const HAND_HOLD_MS = 600;

/** Pure analysis of greyscale frames; separate from the camera so it can be tested with synthetic images. */
export class MotionRegionAnalyzer {
  readonly options: MotionLiteOptions;
  private previous: Uint8Array | null = null;
  private regions: RegionState[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    options: Partial<MotionLiteOptions> = {},
  ) {
    this.options = { ...DEFAULT_MOTION_LITE, ...options };
    for (let i = 0; i < this.options.regions; i++) {
      this.regions.push({
        bodyX: (i + 0.5) / this.options.regions,
        bodyY: 0.5,
        hands: { left: null, right: null },
        lastActive: -Infinity,
        activity: 0,
      });
    }
  }

  /**
   * @param gray one brightness byte per pixel, row by row, unmirrored camera image
   * @param t milliseconds
   */
  analyze(gray: Uint8Array, t: number): RawPerson[] {
    const { width: w, height: h } = this;
    const o = this.options;
    const prev = this.previous;
    this.previous = gray.slice();
    if (!prev || prev.length !== gray.length) return this.people(t);

    const regionWidth = w / o.regions;
    for (let r = 0; r < o.regions; r++) {
      const state = this.regions[r]!;
      const x0 = Math.floor(r * regionWidth);
      const x1 = Math.floor((r + 1) * regionWidth);
      const bodyPx = state.bodyX * w;
      // Sums for: everything, pixels left of the body in the image, pixels right of it.
      let n = 0, sx = 0, sy = 0;
      let nl = 0, lx = 0, ly = 0;
      let nr = 0, rx = 0, ry = 0;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const d = gray[row + x]! - prev[row + x]!;
          if (d > o.pixelThreshold || d < -o.pixelThreshold) {
            n++; sx += x; sy += y;
            if (x < bodyPx) { nl++; lx += x; ly += y; }
            else { nr++; rx += x; ry += y; }
          }
        }
      }
      const area = (x1 - x0) * h;
      const activity = n / area;
      state.activity += 0.5 * (Math.min(1, activity * 10) - state.activity);
      if (activity < o.minActivity) continue;

      state.lastActive = t;
      // The body centre follows movement slowly, so waving one arm does not drag it far.
      state.bodyX += 0.05 * (sx / n / w - state.bodyX);
      state.bodyY += 0.05 * (sy / n / h - state.bodyY);
      const minHand = Math.max(4, area * o.minActivity * 0.5);
      // The camera image is not mirrored: a person facing the camera has their right hand on the image's left.
      if (nl >= minHand) state.hands.right = this.follow(state.hands.right, lx / nl / w, ly / nl / h, t);
      if (nr >= minHand) state.hands.left = this.follow(state.hands.left, rx / nr / w, ry / nr / h, t);
    }
    return this.people(t);
  }

  private follow(hand: { x: number; y: number; seen: number } | null, x: number, y: number, t: number) {
    if (!hand || t - hand.seen > HAND_HOLD_MS) return { x, y, seen: t };
    return { x: hand.x + 0.6 * (x - hand.x), y: hand.y + 0.6 * (y - hand.y), seen: t };
  }

  private people(t: number): RawPerson[] {
    const out: RawPerson[] = [];
    for (const state of this.regions) {
      const idle = t - state.lastActive;
      if (idle > this.options.presenceMs) continue;
      const person: RawPerson = {
        keypoints: {},
        score: 1 - idle / this.options.presenceMs,
        anchor: { x: state.bodyX, y: state.bodyY },
        activity: state.activity,
      };
      for (const side of ["left", "right"] as const) {
        const hand = state.hands[side];
        if (!hand) continue;
        const age = t - hand.seen;
        if (age > HAND_HOLD_MS) continue;
        person.keypoints[side === "left" ? "leftWrist" : "rightWrist"] = { x: hand.x, y: hand.y, score: 1 - (0.5 * age) / HAND_HOLD_MS };
      }
      out.push(person);
    }
    return out;
  }
}

/** Convert RGBA pixels to one brightness byte per pixel. */
export function toGray(rgba: Uint8ClampedArray, out: Uint8Array): Uint8Array {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  }
  return out;
}

export interface MotionLiteSourceOptions extends Partial<MotionLiteOptions> {
  camera?: CameraRequest;
  /** Analysis resolution; small on purpose. */
  width?: number;
  height?: number;
  maxHz?: number;
}

export class MotionLiteSource implements PoseSource {
  readonly id = "motion-lite";
  readonly capabilities: SourceCapabilities;
  camera: OpenCamera | null = null;
  private stopLoop: (() => void) | null = null;

  constructor(private options: MotionLiteSourceOptions = {}) {
    this.capabilities = { skeleton: false, hands: "coarse", fixedRegions: true, maxPeople: options.regions ?? 2 };
  }

  async start(sink: FrameSink): Promise<void> {
    const w = this.options.width ?? 160;
    const h = this.options.height ?? 120;
    this.camera = await openCamera({ width: 320, height: 240, ...this.options.camera });
    const { video } = this.camera;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available");
    const analyzer = new MotionRegionAnalyzer(w, h, this.options);
    const gray = new Uint8Array(w * h);
    const aspect = this.camera.width / this.camera.height;
    const minInterval = 1000 / (this.options.maxHz ?? 30);
    let last = -Infinity;

    this.stopLoop = onVideoFrame(video, (captureTime) => {
      if (captureTime - last < minInterval * 0.9) return;
      last = captureTime;
      ctx.drawImage(video, 0, 0, w, h);
      toGray(ctx.getImageData(0, 0, w, h).data, gray);
      sink({ timestamp: captureTime, aspect, mirrored: false, people: analyzer.analyze(gray, captureTime) });
    });
  }

  async stop(): Promise<void> {
    this.stopLoop?.();
    this.stopLoop = null;
    this.camera?.stop();
    this.camera = null;
  }
}
