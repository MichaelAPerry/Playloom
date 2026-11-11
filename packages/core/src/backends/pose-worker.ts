/// <reference lib="webworker" />
/**
 * Pose estimation in a worker, so that a slow model lowers the tracking rate instead of freezing
 * the game. It is a classic (non-module) worker because MediaPipe loads its WebAssembly glue with
 * importScripts, which module workers do not have.
 *
 * The page sends one camera frame at a time and waits for the answer before sending the next.
 */
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

export interface PoseWorkerInit {
  type: "init";
  wasmPath: string;
  modelPath: string;
  delegate: "GPU" | "CPU";
  maxPeople: number;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
}
export interface PoseWorkerFrame {
  type: "frame";
  bitmap: ImageBitmap;
  time: number;
}
export type PoseWorkerReply =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string }
  | { type: "result"; time: number; inferenceMs: number; poses: Array<Array<{ x: number; y: number; visibility?: number }>> };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const reply = (message: PoseWorkerReply): void => scope.postMessage(message);
let landmarker: PoseLandmarker | null = null;
let lastStamp = 0;

async function init(o: PoseWorkerInit): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(o.wasmPath);
  const create = (delegate: "GPU" | "CPU"): Promise<PoseLandmarker> =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: o.modelPath, delegate },
      runningMode: "VIDEO",
      numPoses: o.maxPeople,
      minPoseDetectionConfidence: o.minDetectionConfidence,
      minPosePresenceConfidence: o.minDetectionConfidence,
      minTrackingConfidence: o.minTrackingConfidence,
    });
  let delegate = o.delegate;
  try {
    landmarker = await create(delegate);
  } catch (err) {
    if (delegate !== "GPU") throw err;
    delegate = "CPU";
    landmarker = await create(delegate);
  }
  reply({ type: "ready", delegate });
}

scope.onmessage = (event: MessageEvent<PoseWorkerInit | PoseWorkerFrame>) => {
  const message = event.data;
  if (message.type === "init") {
    init(message).catch((err) => reply({ type: "error", message: (err as Error)?.message ?? String(err) }));
    return;
  }
  const { bitmap, time } = message;
  try {
    if (!landmarker) throw new Error("Pose worker used before it was ready");
    // MediaPipe needs strictly increasing timestamps.
    lastStamp = Math.max(lastStamp + 1, Math.round(time));
    const began = performance.now();
    const result = landmarker.detectForVideo(bitmap, lastStamp);
    const inferenceMs = performance.now() - began;
    reply({ type: "result", time, inferenceMs, poses: result.landmarks.map((pose) => pose.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }))) });
  } catch (err) {
    reply({ type: "error", message: (err as Error)?.message ?? String(err) });
  } finally {
    bitmap.close();
  }
};
