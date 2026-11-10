import { KEYPOINT_NAMES, type RawPerson, type Skeleton } from "../types";

/**
 * Pure maths for the MoveNet MultiPose backend: how a camera frame is resized into the model's
 * input, and how the model's output is mapped back to normalised camera-frame coordinates.
 * Kept free of browser and runtime APIs so it can be unit tested.
 */

/** MoveNet outputs 17 COCO keypoints; Playloom's first 17 names are in the same order. */
export const MOVENET_KEYPOINTS = 17;
/** One row of output: 17 x (y, x, score), then box (ymin, xmin, ymax, xmax) and person score. */
export const MOVENET_ROW = 56;

export interface Letterbox {
  /** Model input size in pixels; both are multiples of 32. */
  inputWidth: number;
  inputHeight: number;
  /** Size of the camera picture inside the input, in pixels. */
  drawWidth: number;
  drawHeight: number;
  /** Offset of the picture inside the input, in pixels (the rest is black padding). */
  padX: number;
  padY: number;
}

const up32 = (n: number): number => Math.max(32, Math.ceil(n / 32) * 32);

/**
 * Fit a frame of `frameWidth` x `frameHeight` into a model input whose long side is `longSide`
 * (rounded to a multiple of 32), keeping the aspect ratio and centring the picture in black padding.
 */
export function letterbox(frameWidth: number, frameHeight: number, longSide = 256): Letterbox {
  if (!(frameWidth > 0) || !(frameHeight > 0)) throw new Error("Frame size must be positive");
  const long = up32(longSide);
  const scale = long / Math.max(frameWidth, frameHeight);
  const drawWidth = Math.max(1, Math.round(frameWidth * scale));
  const drawHeight = Math.max(1, Math.round(frameHeight * scale));
  const inputWidth = up32(drawWidth);
  const inputHeight = up32(drawHeight);
  return {
    inputWidth,
    inputHeight,
    drawWidth,
    drawHeight,
    padX: Math.floor((inputWidth - drawWidth) / 2),
    padY: Math.floor((inputHeight - drawHeight) / 2),
  };
}

/** Convert a point normalised to the model input into a point normalised to the camera frame. */
export function inputToFrame(lb: Letterbox, x: number, y: number): { x: number; y: number } {
  return { x: (x * lb.inputWidth - lb.padX) / lb.drawWidth, y: (y * lb.inputHeight - lb.padY) / lb.drawHeight };
}

export interface MoveNetMappingOptions {
  /** People whose overall score is below this are dropped. */
  minPersonScore: number;
  /** Keypoints below this score are reported with score 0 (unusable), not dropped. */
  minKeypointScore: number;
}

export const DEFAULT_MOVENET_MAPPING: MoveNetMappingOptions = { minPersonScore: 0.25, minKeypointScore: 0.1 };

/**
 * Map the `[1, 6, 56]` output tensor (flattened) to Playloom people. Coordinates are normalised to
 * the camera frame, undoing the letterbox. Keypoints that fall outside the camera picture (inside
 * the padding, or beyond it) get score 0 so the engine ignores them.
 */
export function personsFromMoveNet(
  output: ArrayLike<number>,
  lb: Letterbox,
  options: Partial<MoveNetMappingOptions> = {},
): RawPerson[] {
  const { minPersonScore, minKeypointScore } = { ...DEFAULT_MOVENET_MAPPING, ...options };
  const people: RawPerson[] = [];
  const rows = Math.floor(output.length / MOVENET_ROW);
  for (let r = 0; r < rows; r++) {
    const base = r * MOVENET_ROW;
    const personScore = output[base + 55]!;
    if (!(personScore >= minPersonScore)) continue;
    const keypoints: Skeleton = {};
    for (let k = 0; k < MOVENET_KEYPOINTS; k++) {
      const y = output[base + k * 3]!;
      const x = output[base + k * 3 + 1]!;
      const s = output[base + k * 3 + 2]!;
      const p = inputToFrame(lb, x, y);
      const inside = p.x >= -0.05 && p.x <= 1.05 && p.y >= -0.05 && p.y <= 1.05;
      keypoints[KEYPOINT_NAMES[k]!] = { x: p.x, y: p.y, score: inside && s >= minKeypointScore ? Math.min(1, s) : 0 };
    }
    people.push({ keypoints, score: personScore });
  }
  return people;
}

/** Pack RGBA pixels into the model's input: int32, RGB, 0..255, row-major (NHWC without the N). */
export function rgbaToRgbInt32(rgba: ArrayLike<number>, pixels: number, out?: Int32Array): Int32Array {
  const dst = out && out.length >= pixels * 3 ? out : new Int32Array(pixels * 3);
  for (let i = 0, j = 0, p = 0; p < pixels; p++, i += 4, j += 3) {
    dst[j] = rgba[i]!;
    dst[j + 1] = rgba[i + 1]!;
    dst[j + 2] = rgba[i + 2]!;
  }
  return dst;
}
