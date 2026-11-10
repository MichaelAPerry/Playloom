import {
  CameraError,
  listCameras,
  MediaPipePoseSource,
  MotionEngine,
  MotionLiteSource,
  runCompatibilityCheck,
  type CompatibilityReport,
  type MotionSettings,
  type PoseSource,
  type ProfileRecommendation,
} from "@playloom/core";
import { attachSimulatorControls, SimulatorSource, type SimulatorControls } from "@playloom/simulator";

/** Which tracking the family has chosen. "auto" follows the result of the device check. */
export type TrackingMode = "auto" | "mediapipe-pose-gpu" | "mediapipe-pose-cpu" | "motion-lite" | "practice";

export const MODE_LABELS: Record<TrackingMode, string> = {
  auto: "Automatic",
  "mediapipe-pose-gpu": "Full body (graphics card)",
  "mediapipe-pose-cpu": "Full body (processor)",
  "motion-lite": "Lite (movement only)",
  practice: "Practice (keyboard, no camera)",
};

export interface StoredCheck {
  recommendation: ProfileRecommendation;
  report: CompatibilityReport;
}

const CHECK_KEY = "playloom.compatibility";

export function loadCheck(): StoredCheck | null {
  try {
    const data = JSON.parse(localStorage.getItem(CHECK_KEY) ?? "null") as StoredCheck | null;
    return data?.recommendation?.profile && data.report ? data : null;
  } catch {
    return null;
  }
}

/** Owns the motion engine and whichever source is feeding it. */
export class Tracking {
  readonly engine: MotionEngine;
  state: "idle" | "starting" | "running" | "error" = "idle";
  error: { message: string; camera: boolean } | null = null;
  /** The backend actually in use. */
  active: string | null = null;
  private source: PoseSource | null = null;
  private sim: SimulatorControls | null = null;
  private generation = 0;

  constructor(
    private settings: MotionSettings,
    private surface: HTMLElement,
  ) {
    this.engine = new MotionEngine({ mirror: settings.mirror, sensitivity: settings.sensitivity, thresholds: settings.thresholds });
  }

  get mode(): TrackingMode {
    const m = this.settings.backend as TrackingMode | undefined;
    return m && m in MODE_LABELS ? m : "auto";
  }

  get practice(): boolean {
    return this.active === "simulator";
  }

  video(): HTMLVideoElement | null {
    return (this.source as { camera?: { video: HTMLVideoElement } | null } | null)?.camera?.video ?? null;
  }

  private make(backend: string): PoseSource {
    const camera = { deviceId: this.settings.cameraId, width: 640, height: 480 };
    if (backend === "mediapipe-pose-gpu") return new MediaPipePoseSource({ delegate: "GPU", camera });
    if (backend === "mediapipe-pose-cpu") return new MediaPipePoseSource({ delegate: "CPU", camera });
    if (backend === "motion-lite") return new MotionLiteSource({ camera: { deviceId: this.settings.cameraId } });
    return new SimulatorSource();
  }

  /** Start (or restart) tracking in the chosen mode, falling back to simpler tracking if needed. */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.state = "starting";
    this.error = null;
    this.sim?.detach();
    this.sim = null;

    const mode = this.mode;
    let order: string[];
    if (mode === "practice") order = ["simulator"];
    else if (mode === "auto") {
      const checked = loadCheck()?.recommendation.backend;
      order = [...new Set([checked ?? "mediapipe-pose-gpu", "mediapipe-pose-cpu", "motion-lite"])];
    } else order = [mode];

    for (const backend of order) {
      const source = this.make(backend);
      try {
        await this.engine.attach(source);
        await this.engine.start();
        if (generation !== this.generation) return;
        this.source = source;
        this.active = source.id;
        this.state = "running";
        if (source instanceof SimulatorSource) this.sim = attachSimulatorControls(source, this.surface);
        return;
      } catch (err) {
        if (generation !== this.generation) return;
        const camera = err instanceof CameraError;
        this.error = { message: (err as Error)?.message ?? String(err), camera };
        // A camera problem will not be solved by trying a different kind of tracking.
        if (camera) break;
      }
    }
    this.source = null;
    this.active = null;
    this.state = "error";
  }

  apply(patch: Partial<MotionSettings>): void {
    Object.assign(this.settings, patch);
    this.engine.configure({ mirror: this.settings.mirror, sensitivity: this.settings.sensitivity });
  }

  cameras = listCameras;

  /** Measure every backend on this device and remember the result. Tracking restarts afterwards. */
  async check(progress: (message: string) => void): Promise<StoredCheck> {
    this.generation++;
    this.sim?.detach();
    this.sim = null;
    const result = await runCompatibilityCheck(
      this.engine,
      ["mediapipe-pose-gpu", "mediapipe-pose-cpu", "motion-lite"].map((b) => () => (this.source = this.make(b))),
      () => this.renderFps(),
      progress,
    );
    try {
      localStorage.setItem(CHECK_KEY, JSON.stringify(result));
    } catch {
      // Storage full or blocked: the result is still used for this session.
    }
    await this.start();
    return result;
  }

  renderFps: () => number = () => 0;
}
