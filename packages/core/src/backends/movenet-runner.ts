import type * as OrtModule from "onnxruntime-web/wasm";
import { letterbox, personsFromMoveNet, rgbaToRgbInt32, type Letterbox, type MoveNetMappingOptions } from "./movenet-math";
import type { RawPerson } from "../types";

/**
 * Runs the MoveNet MultiPose Lightning ONNX model with ONNX Runtime Web (WebAssembly, single
 * thread). Used by the worker, and by the main thread when no worker can be started.
 *
 * Privacy: ONNX Runtime Web has no telemetry code (checked in docs/architecture/decisions.md, D9).
 * The WebAssembly file is loaded from `wasmPath`, never from a CDN.
 */

export interface MoveNetRunnerOptions {
  /** URL of `movenet_multipose_lightning.onnx`. */
  modelPath: string;
  /** URL of the folder with the ONNX Runtime Web files (`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs` and `.wasm`). */
  wasmPath: string;
  /** Long side of the model input in pixels (multiple of 32). */
  inputSize: number;
  mapping?: Partial<MoveNetMappingOptions>;
}

type Ort = typeof OrtModule;

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Drawable = ImageBitmap | HTMLVideoElement;

export class MoveNetRunner {
  private lb: Letterbox | null = null;
  private frameKey = "";
  private canvas: Surface | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private pixels: Int32Array | null = null;

  private constructor(
    private readonly ort: Ort,
    private readonly session: OrtModule.InferenceSession,
    private readonly options: MoveNetRunnerOptions,
  ) {}

  static async create(options: MoveNetRunnerOptions): Promise<MoveNetRunner> {
    const base = options.wasmPath.endsWith("/") ? options.wasmPath : `${options.wasmPath}/`;
    // Loaded from the local files copied by `pnpm fetch-models` rather than bundled, so the app
    // bundle stays small and nothing can resolve to another origin. The `import()` is a plain
    // same-origin script load, which the page's script-src 'self' allows.
    const ort = (await import(/* @vite-ignore */ `${base}ort.wasm.min.mjs`)) as Ort;
    ort.env.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
    // One thread: multi-threading needs cross-origin isolation, which Playloom's pages do not have
    // and which would need a worker URL that the page policy would have to allow.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const res = await fetch(options.modelPath);
    if (!res.ok) throw new Error(`Could not load the MoveNet model (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return new MoveNetRunner(ort, session, options);
  }

  private prepare(width: number, height: number): Letterbox {
    const key = `${width}x${height}`;
    if (!this.lb || key !== this.frameKey) {
      this.frameKey = key;
      this.lb = letterbox(width, height, this.options.inputSize);
      const { inputWidth, inputHeight } = this.lb;
      this.canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(inputWidth, inputHeight) : Object.assign(document.createElement("canvas"), { width: inputWidth, height: inputHeight });
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true }) as typeof this.ctx;
      this.pixels = new Int32Array(inputWidth * inputHeight * 3);
    }
    return this.lb;
  }

  /** Estimate poses in one picture. `width`/`height` are the picture's own size. */
  async run(image: Drawable, width: number, height: number): Promise<RawPerson[]> {
    const lb = this.prepare(width, height);
    const ctx = this.ctx!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, lb.inputWidth, lb.inputHeight);
    ctx.drawImage(image, lb.padX, lb.padY, lb.drawWidth, lb.drawHeight);
    const rgba = ctx.getImageData(0, 0, lb.inputWidth, lb.inputHeight).data;
    const data = rgbaToRgbInt32(rgba, lb.inputWidth * lb.inputHeight, this.pixels!);
    const input = new this.ort.Tensor("int32", data, [1, lb.inputHeight, lb.inputWidth, 3]);
    const outputs = await this.session.run({ input });
    const out = outputs[this.session.outputNames[0]!]!.data as Float32Array;
    return personsFromMoveNet(out, lb, this.options.mapping);
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}
