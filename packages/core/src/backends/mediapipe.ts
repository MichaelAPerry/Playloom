import { onVideoFrame, openCamera, type CameraRequest, type OpenCamera } from "../camera/camera";
import type { PoseWorkerFrame, PoseWorkerInit, PoseWorkerReply } from "./pose-worker";
import type { FrameSink, KeypointName, PoseSource, RawPerson, Skeleton, SourceCapabilities } from "../types";

/**
 * Standard / Enhanced backend: MediaPipe Pose Landmarker with several people per frame.
 *
 * The model and WASM runtime are loaded from local paths (see `pnpm fetch-models`), never from a
 * CDN, so tracking works offline.
 *
 * Privacy: @mediapipe/tasks-vision is pinned to 0.10.34 on purpose. From 1.0.0 the library sends
 * usage metrics to Google with no documented way to turn that off, which Playloom does not allow.
 * See docs/privacy.md before changing the version.
 */

/** MediaPipe's 33 landmark indices mapped to Playloom keypoint names. */
export const MEDIAPIPE_LANDMARKS: Readonly<Record<KeypointName, number>> = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

export interface MediaPipeLandmark {
  x: number;
  y: number;
  visibility?: number;
}

/** Convert one MediaPipe pose (33 normalised landmarks) to a Playloom person. */
export function personFromLandmarks(landmarks: readonly MediaPipeLandmark[]): RawPerson {
  const keypoints: Skeleton = {};
  for (const name in MEDIAPIPE_LANDMARKS) {
    const lm = landmarks[MEDIAPIPE_LANDMARKS[name as KeypointName]];
    if (!lm) continue;
    // Landmarks outside the picture are extrapolated guesses; do not trust them.
    const inside = lm.x >= -0.05 && lm.x <= 1.05 && lm.y >= -0.05 && lm.y <= 1.05;
    keypoints[name as KeypointName] = { x: lm.x, y: lm.y, score: inside ? (lm.visibility ?? 1) : 0 };
  }
  const core = [keypoints.leftShoulder, keypoints.rightShoulder, keypoints.nose];
  const score = core.reduce((sum, k) => sum + (k?.score ?? 0), 0) / core.length;
  return { keypoints, score };
}

export interface MediaPipeOptions {
  /** URL of the `.task` model file. */
  modelPath: string;
  /** URL of the directory holding MediaPipe's `vision_wasm_internal.*` files. */
  wasmPath: string;
  maxPeople: number;
  delegate: "GPU" | "CPU";
  camera: CameraRequest;
  /** Upper limit on pose rate; frames arriving faster are skipped. 0 = no limit. */
  maxHz: number;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
  /**
   * Run the model in a worker so it cannot stall rendering. If the worker cannot start, the model
   * runs on the page's own thread instead.
   */
  worker: boolean;
}

export const DEFAULT_MEDIAPIPE_OPTIONS: MediaPipeOptions = {
  modelPath: "models/pose_landmarker_lite.task",
  wasmPath: "mediapipe/wasm",
  maxPeople: 2,
  delegate: "GPU",
  camera: {},
  maxHz: 0,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  worker: true,
};

interface Landmarker {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: MediaPipeLandmark[][] };
  close(): void;
}

export class MediaPipePoseSource implements PoseSource {
  readonly id: string;
  readonly capabilities: SourceCapabilities;
  readonly options: MediaPipeOptions;
  camera: OpenCamera | null = null;
  /** Delegate actually in use after any fallback. */
  activeDelegate: "GPU" | "CPU" | null = null;

  /** Where the model is running. */
  thread: "worker" | "main" | null = null;

  private landmarker: Landmarker | null = null;
  private worker: Worker | null = null;
  private stopLoop: (() => void) | null = null;
  private lastInference = -Infinity;

  constructor(options: Partial<MediaPipeOptions> = {}) {
    this.options = { ...DEFAULT_MEDIAPIPE_OPTIONS, ...options };
    this.id = `mediapipe-pose-${this.options.delegate.toLowerCase()}`;
    this.capabilities = { skeleton: true, hands: "precise", fixedRegions: false, maxPeople: this.options.maxPeople };
  }

  async start(sink: FrameSink): Promise<void> {
    const o = this.options;
    // Open the camera first: if there is none, there is no point loading a model.
    this.camera = await openCamera(o.camera);
    try {
      if (o.worker && typeof Worker !== "undefined" && typeof createImageBitmap === "function") {
        try {
          await this.startWorker(sink);
          this.thread = "worker";
          return;
        } catch (err) {
          console.warn("[playloom] pose worker unavailable, using the main thread:", err);
          this.worker?.terminate();
          this.worker = null;
        }
      }
      await this.startOnMainThread(sink);
      this.thread = "main";
    } catch (err) {
      this.camera?.stop();
      this.camera = null;
      throw err;
    }
  }

  private startWorker(sink: FrameSink): Promise<void> {
    const o = this.options;
    const { video, width, height } = this.camera!;
    const aspect = width / height;
    const minInterval = o.maxHz > 0 ? 1000 / o.maxHz : 0;
    const absolute = (path: string): string => new URL(path, document.baseURI).href;
    const worker = new Worker(new URL("./pose-worker.ts", import.meta.url), { type: "classic", name: "playloom-pose" });
    this.worker = worker;

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let busy = false;
      const timeout = setTimeout(() => reject(new Error("The pose worker did not start in time")), 30_000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(e.message || "The pose worker failed to load"));
      };
      worker.onmessage = (event: MessageEvent<PoseWorkerReply>) => {
        const message = event.data;
        if (message.type === "ready") {
          clearTimeout(timeout);
          ready = true;
          this.activeDelegate = message.delegate;
          // One frame in flight at a time: a slow model simply sees fewer frames, never a backlog.
          this.stopLoop = onVideoFrame(video, (captureTime) => {
            if (busy || captureTime - this.lastInference < minInterval) return;
            busy = true;
            this.lastInference = captureTime;
            createImageBitmap(video).then(
              (bitmap) => {
                if (this.worker !== worker) return bitmap.close();
                const frame: PoseWorkerFrame = { type: "frame", bitmap, time: captureTime };
                worker.postMessage(frame, [bitmap]);
              },
              () => (busy = false),
            );
          });
          resolve();
        } else if (message.type === "result") {
          busy = false;
          if (this.worker === worker) sink({ timestamp: message.time, aspect, mirrored: false, people: message.poses.map(personFromLandmarks) });
        } else {
          busy = false;
          if (!ready) {
            clearTimeout(timeout);
            reject(new Error(message.message));
          } else console.warn("[playloom] pose worker:", message.message);
        }
      };
      const init: PoseWorkerInit = {
        type: "init",
        wasmPath: absolute(o.wasmPath),
        modelPath: absolute(o.modelPath),
        delegate: o.delegate,
        maxPeople: o.maxPeople,
        minDetectionConfidence: o.minDetectionConfidence,
        minTrackingConfidence: o.minTrackingConfidence,
      };
      worker.postMessage(init);
    });
  }

  private async startOnMainThread(sink: FrameSink): Promise<void> {
    const o = this.options;
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(o.wasmPath);
    const create = (delegate: "GPU" | "CPU"): Promise<Landmarker> =>
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: o.modelPath, delegate },
        runningMode: "VIDEO",
        numPoses: o.maxPeople,
        minPoseDetectionConfidence: o.minDetectionConfidence,
        minPosePresenceConfidence: o.minDetectionConfidence,
        minTrackingConfidence: o.minTrackingConfidence,
      }) as unknown as Promise<Landmarker>;
    try {
      this.landmarker = await create(o.delegate);
      this.activeDelegate = o.delegate;
    } catch (err) {
      if (o.delegate !== "GPU") throw err;
      // Old or blocklisted graphics drivers: fall back to the CPU rather than failing.
      this.landmarker = await create("CPU");
      this.activeDelegate = "CPU";
    }
    const { video } = this.camera!;
    const aspect = this.camera!.width / this.camera!.height;
    const minInterval = o.maxHz > 0 ? 1000 / o.maxHz : 0;
    this.stopLoop = onVideoFrame(video, (captureTime) => {
      if (!this.landmarker || captureTime - this.lastInference < minInterval) return;
      this.lastInference = captureTime;
      // MediaPipe requires strictly increasing timestamps.
      const result = this.landmarker.detectForVideo(video, performance.now());
      sink({ timestamp: captureTime, aspect, mirrored: false, people: result.landmarks.map(personFromLandmarks) });
    });
  }

  async stop(): Promise<void> {
    this.stopLoop?.();
    this.stopLoop = null;
    this.worker?.terminate();
    this.worker = null;
    this.camera?.stop();
    this.camera = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.thread = null;
  }
}
