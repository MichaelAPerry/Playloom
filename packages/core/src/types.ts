/**
 * Shared types for the Playloom motion pipeline.
 *
 * Coordinate convention everywhere in this package:
 *   - normalised to the camera frame: x and y in 0..1, origin top-left, y pointing down;
 *   - "left"/"right" in keypoint names are the person's anatomical left and right.
 */

export type PlayerId = number;

export interface Point {
  x: number;
  y: number;
}

/** COCO-17 body keypoints plus optional index-finger tips (present on backends that provide them). */
export const KEYPOINT_NAMES = [
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftIndex",
  "rightIndex",
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

export interface Keypoint extends Point {
  /** Backend confidence, 0..1. */
  score: number;
}

export type Skeleton = Partial<Record<KeypointName, Keypoint>>;

/** One person as reported by a pose backend, before Playloom has decided who they are. */
export interface RawPerson {
  keypoints: Skeleton;
  /** Overall detection confidence, 0..1. */
  score: number;
  /** Body centre for backends that cannot provide shoulders or hips (Lite mode). */
  anchor?: Point;
  /** Amount of movement, 0..1, for backends that measure it (Lite mode). */
  activity?: number;
}

/** One tracking result. The order of `people` carries no meaning and may change every frame. */
export interface PoseFrame {
  /** Capture time in milliseconds, in the same clock the engine was given (default `performance.now()`). */
  timestamp: number;
  people: RawPerson[];
  /** Width divided by height of the analysed image. Defaults to 16/9. */
  aspect?: number;
  /** True when x has already been flipped so the image reads like a mirror. Defaults to false. */
  mirrored?: boolean;
}

export interface SourceCapabilities {
  /** Full body keypoints are available. False for the Lite motion backend. */
  skeleton: boolean;
  /** How trustworthy hand positions are. */
  hands: "precise" | "coarse" | "none";
  /**
   * The backend cannot tell people apart; players are defined by which half of the picture they stand in.
   */
  fixedRegions: boolean;
  /** Most people the backend can report at once. */
  maxPeople: number;
}

export type FrameSink = (frame: PoseFrame) => void;

/**
 * Anything that can produce pose frames: a camera backend, the simulator, a recording, or a native bridge.
 * This is the lower boundary of the motion API — the engine does not care which one it is given.
 */
export interface PoseSource {
  readonly id: string;
  readonly capabilities: SourceCapabilities;
  start(sink: FrameSink): Promise<void>;
  stop(): Promise<void>;
  /** Optional measurements for the performance panel; only camera backends have them. */
  diagnostics?(): SourceDiagnostics;
}

/** What a camera backend can tell about itself, all measured while running. */
export interface SourceDiagnostics {
  /** "GPU" or "CPU" for pose estimation. */
  delegate?: string;
  /** Where the model runs: a worker thread or the page's own thread. */
  thread?: string;
  /** What the camera really delivers, and how often it delivers a new picture (every picture, not only analysed ones). */
  camera?: { width: number; height: number; fps: number };
  /** Size of the picture handed to the model. */
  inference?: { width: number; height: number };
  /** Time the model needed per picture, milliseconds. */
  modelMs?: { median: number; p95: number; worst: number };
  /** Camera pictures skipped because the model was still busy, per second. */
  skippedPerSecond?: number;
}

export type Unsubscribe = () => void;
