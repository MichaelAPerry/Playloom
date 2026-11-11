import { onVideoFrame, openCamera, type CameraRequest, type OpenCamera } from "../camera/camera";
import type { MoveNetWorkerFrame, MoveNetWorkerInit, MoveNetWorkerReply } from "./movenet-worker";
import type { MoveNetRunner } from "./movenet-runner";
import { RateMeter } from "../performance/meters";
import type { FrameSink, PoseSource, SourceCapabilities, SourceDiagnostics } from "../types";

export { letterbox, personsFromMoveNet, inputToFrame, rgbaToRgbInt32 } from "./movenet-math";
export type { Letterbox, MoveNetMappingOptions } from "./movenet-math";

/**
 * Skeleton backend: MoveNet MultiPose Lightning (Apache-2.0), up to six people in one pass, so the
 * cost does not grow with the number of people the way a top-down model's does.
 *
 * Runs on ONNX Runtime Web (WebAssembly) in a worker; model and runtime files are served locally
 * (see `pnpm fetch-models`). Decision D9 records why this runtime was chosen.
 *
 * Hands: MoveNet reports wrists but no fingertips, so hand positions are derived from the wrist
 * (extended along the forearm by `handPoint`). That is "coarse" rather than "precise".
 */

export interface MoveNetOptions {
  /** URL of the ONNX model. */
  modelPath: string;
  /** URL of the folder holding `ort-wasm-simd-threaded.wasm`. */
  wasmPath: string;
  maxPeople: number;
  /** Long side of the model input in pixels; rounded up to a multiple of 32. */
  inputSize: number;
  camera: CameraRequest;
  /** Upper limit on pose rate; 0 = no limit. */
  maxHz: number;
  /** Minimum overall person score to report someone. */
  minPersonScore: number;
  /** Run in a worker; falls back to the page's own thread if the worker cannot start. */
  worker: boolean;
}

export const DEFAULT_MOVENET_OPTIONS: MoveNetOptions = {
  modelPath: "models/movenet_multipose_lightning.onnx",
  wasmPath: "ort",
  maxPeople: 6,
  inputSize: 256,
  camera: {},
  maxHz: 0,
  minPersonScore: 0.25,
  worker: true,
};

export class MoveNetPoseSource implements PoseSource {
  readonly id = "movenet-multipose";
  readonly capabilities: SourceCapabilities;
  readonly options: MoveNetOptions;
  camera: OpenCamera | null = null;
  /** Where the model is running. */
  thread: "worker" | "main" | null = null;

  private runner: MoveNetRunner | null = null;
  private worker: Worker | null = null;
  private stopLoop: (() => void) | null = null;
  private lastInference = -Infinity;
  private cameraRate = new RateMeter(2000);
  private skipRate = new RateMeter(2000);

  constructor(options: Partial<MoveNetOptions> = {}) {
    this.options = { ...DEFAULT_MOVENET_OPTIONS, ...options };
    this.capabilities = { skeleton: true, hands: "coarse", fixedRegions: false, maxPeople: Math.min(6, this.options.maxPeople) };
  }

  async start(sink: FrameSink): Promise<void> {
    const o = this.options;
    this.camera = await openCamera(o.camera);
    try {
      if (o.worker && typeof Worker !== "undefined" && typeof createImageBitmap === "function") {
        try {
          await this.startWorker(sink);
          this.thread = "worker";
          return;
        } catch (err) {
          console.warn("[playloom] MoveNet worker unavailable, using the main thread:", err);
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

  private runnerOptions(): MoveNetWorkerInit {
    const o = this.options;
    const absolute = (path: string): string => new URL(path, document.baseURI).href;
    return { type: "init", modelPath: absolute(o.modelPath), wasmPath: absolute(o.wasmPath), inputSize: o.inputSize, mapping: { minPersonScore: o.minPersonScore } };
  }

  private startWorker(sink: FrameSink): Promise<void> {
    const o = this.options;
    const { video, width, height } = this.camera!;
    const aspect = width / height;
    const minInterval = o.maxHz > 0 ? 1000 / o.maxHz : 0;
    const maxPeople = this.capabilities.maxPeople;
    const worker = new Worker(new URL("./movenet-worker.ts", import.meta.url), { type: "classic", name: "playloom-movenet" });
    this.worker = worker;

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let busy = false;
      const timeout = setTimeout(() => reject(new Error("The MoveNet worker did not start in time")), 30_000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(e.message || "The MoveNet worker failed to load"));
      };
      worker.onmessage = (event: MessageEvent<MoveNetWorkerReply>) => {
        const message = event.data;
        if (message.type === "ready") {
          clearTimeout(timeout);
          ready = true;
          // One frame in flight at a time: a slow model simply sees fewer frames, never a backlog.
          this.stopLoop = onVideoFrame(video, (captureTime) => {
            this.cameraRate.tick(performance.now());
            if (busy || captureTime - this.lastInference < minInterval) {
              this.skipRate.tick(performance.now());
              return;
            }
            busy = true;
            this.lastInference = captureTime;
            createImageBitmap(video).then(
              (bitmap) => {
                if (this.worker !== worker) return bitmap.close();
                const frame: MoveNetWorkerFrame = { type: "frame", bitmap, time: captureTime };
                worker.postMessage(frame, [bitmap]);
              },
              () => (busy = false),
            );
          });
          resolve();
        } else if (message.type === "result") {
          busy = false;
          if (this.worker === worker) sink({ timestamp: message.time, aspect, mirrored: false, people: message.people.slice(0, maxPeople) });
        } else {
          busy = false;
          if (!ready) {
            clearTimeout(timeout);
            reject(new Error(message.message));
          } else console.warn("[playloom] MoveNet worker:", message.message);
        }
      };
      worker.postMessage(this.runnerOptions());
    });
  }

  private async startOnMainThread(sink: FrameSink): Promise<void> {
    const o = this.options;
    const { MoveNetRunner } = await import("./movenet-runner");
    const runner = await MoveNetRunner.create(this.runnerOptions());
    this.runner = runner;
    const { video, width, height } = this.camera!;
    const aspect = width / height;
    const minInterval = o.maxHz > 0 ? 1000 / o.maxHz : 0;
    const maxPeople = this.capabilities.maxPeople;
    let busy = false;
    this.stopLoop = onVideoFrame(video, (captureTime) => {
      this.cameraRate.tick(performance.now());
      if (busy || this.runner !== runner || captureTime - this.lastInference < minInterval) return;
      busy = true;
      this.lastInference = captureTime;
      runner.run(video, video.videoWidth || width, video.videoHeight || height).then(
        (people) => {
          busy = false;
          if (this.runner === runner) sink({ timestamp: captureTime, aspect, mirrored: false, people: people.slice(0, maxPeople) });
        },
        (err) => {
          busy = false;
          console.warn("[playloom] MoveNet:", err);
        },
      );
    });
  }

  diagnostics(): SourceDiagnostics {
    return {
      delegate: "ONNX (processor)",
      thread: this.thread ?? undefined,
      camera: this.camera ? { width: this.camera.width, height: this.camera.height, fps: this.cameraRate.rate() } : undefined,
      skippedPerSecond: this.skipRate.rate(),
    };
  }

  async stop(): Promise<void> {
    this.stopLoop?.();
    this.stopLoop = null;
    this.worker?.terminate();
    this.worker = null;
    this.camera?.stop();
    this.camera = null;
    const runner = this.runner;
    this.runner = null;
    await runner?.close().catch(() => undefined);
    this.thread = null;
  }
}
