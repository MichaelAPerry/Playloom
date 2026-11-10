import type { Keypoint, KeypointName, Point, RawPerson, Skeleton } from "./types";

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function visible(skeleton: Skeleton, name: KeypointName, minScore: number): Keypoint | undefined {
  const k = skeleton[name];
  return k && k.score >= minScore ? k : undefined;
}

export interface BodyMetrics {
  /** Reference point used to follow the person: shoulder centre when visible. */
  anchor: Point;
  /**
   * Body size in the same units as the keypoints: shoulder-to-hip length when hips are visible,
   * otherwise estimated from shoulder width. Null when neither can be measured.
   */
  scale: number | null;
  shoulderMid?: Point;
  hipMid?: Point;
}

/** Ratio between shoulder width and torso length for a person facing the camera. */
const SHOULDER_TO_TORSO = 1.4;

/**
 * Measure a person. Shoulders are preferred as the anchor because a webcam on a desk or TV
 * often cannot see hips, and the anchor must not jump when hips come and go.
 */
export function measureBody(person: RawPerson, minScore: number): BodyMetrics | null {
  const s = person.keypoints;
  const ls = visible(s, "leftShoulder", minScore);
  const rs = visible(s, "rightShoulder", minScore);
  const lh = visible(s, "leftHip", minScore);
  const rh = visible(s, "rightHip", minScore);
  const shoulderMid = ls && rs ? mid(ls, rs) : undefined;
  const hipMid = lh && rh ? mid(lh, rh) : undefined;

  let scale: number | null = null;
  if (shoulderMid && hipMid) scale = dist(shoulderMid, hipMid);
  else if (ls && rs) scale = dist(ls, rs) * SHOULDER_TO_TORSO;
  if (scale !== null && scale < 1e-4) scale = null;

  const anchor = shoulderMid ?? hipMid ?? person.anchor;
  if (!anchor) return null;
  return { anchor: { x: anchor.x, y: anchor.y }, scale, shoulderMid, hipMid };
}

/**
 * Where the player's hand is. Uses the index-finger tip when the backend provides one,
 * otherwise extends the forearm a little past the wrist to approximate the palm.
 */
export function handPoint(skeleton: Skeleton, side: "left" | "right", minScore: number): Keypoint | undefined {
  const index = visible(skeleton, side === "left" ? "leftIndex" : "rightIndex", minScore);
  if (index) return index;
  const wrist = visible(skeleton, side === "left" ? "leftWrist" : "rightWrist", minScore);
  if (!wrist) return undefined;
  const elbow = visible(skeleton, side === "left" ? "leftElbow" : "rightElbow", minScore);
  if (!elbow) return wrist;
  return {
    x: wrist.x + (wrist.x - elbow.x) * 0.25,
    y: wrist.y + (wrist.y - elbow.y) * 0.25,
    score: wrist.score,
  };
}

/** Copy a skeleton, transforming every point. */
export function mapSkeleton(skeleton: Skeleton, fn: (k: Keypoint) => Keypoint): Skeleton {
  const out: Skeleton = {};
  for (const name in skeleton) {
    const k = skeleton[name as KeypointName];
    if (k) out[name as KeypointName] = fn(k);
  }
  return out;
}
