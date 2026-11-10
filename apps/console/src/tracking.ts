import {
  CameraError,
  listCameras,
  MediaPipePoseSource,
  MotionEngine,
  MotionLiteSource,
  pickTrialBackend,
  trialNeedsAnother,
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
const TRIAL_KEY = "playloom.trial";
const TRIAL_WARMUP_MS = 1500;
const TRIAL_MEASURE_MS = 4000;

/** Result of the quick automatic speed trial, kept so later launches go straight to the winner. */
export interface StoredTrial {
  backend: string;
  rates: { gpu?: number; cpu?: number };
  at: string;
}

export function loadTrial(): StoredTrial | null {
  try {
    const data = JSON.parse(localStorage.getItem(TRIAL_KEY) ?? "null") as StoredTrial | null;
    return data && typeof data.backend === "string" ? data : null;
  } catch {
    return null;
  }
}

function saveTrial(trial: StoredTrial): void {
  try {
    localStorage.setItem(TRIAL_KEY, JSON.stringify(trial));
  } catch {
    // Storage blocked: the choice still holds for this session.
  }
}

/** Forget the quick trial so the next start measures again. */
export function clearTrial(): void {
  try {
    localStorage.removeItem(TRIAL_KEY);
  } catch {
    // Nothing to clear.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  state: "idle" | "starting" | "tuning" | "running" | "error" = "idle";
  error: { message: string; camera: boolean } | null = null;
  /** The backend actually in use. */
  active: string | null = null;
  private source: PoseSource | null = null;
  private sim: SimulatorControls | null = null;
  private generation = 0;
  /** Which step of the quick automatic trial is running, for the progress display. */
  trialProgress: { step: number; of: number; label: string; since: number } | null = null;

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
      if (!checked && !loadTrial()) {
        const chosen = await this.trial(generation);
        if (chosen === null) return; // superseded, or a camera problem was recorded
        order = [...new Set([chosen, "mediapipe-pose-cpu", "motion-lite"])];
      } else {
        const preferred = checked ?? loadTrial()?.backend ?? "mediapipe-pose-gpu";
        order = [...new Set([preferred, "mediapipe-pose-cpu", "motion-lite"])];
      }
    } else order = [mode];

    for (const backend of order) {
      if (await this.tryBackend(backend, generation)) return;
      if (generation !== this.generation) return;
      // A camera problem will not be solved by trying a different kind of tracking.
      if (this.cameraFailed()) break;
    }
    this.fail();
  }

  private cameraFailed(): boolean {
    return !!this.error?.camera;
  }

  /** How far the quick trial has got, from 0 to 1, from the step and the time spent on it. */
  trialFraction(): number {
    const t = this.trialProgress;
    if (!t) return 0;
    const within = Math.min(1, (Date.now() - t.since) / (TRIAL_WARMUP_MS + TRIAL_MEASURE_MS));
    return Math.min(0.98, (t.step - 1 + within) / t.of);
  }

  private fail(): void {
    this.trialProgress = null;
    this.source = null;
    this.active = null;
    this.state = "error";
  }

  /** Start one backend. Returns true when it is running; false (with `error` set) when it failed or was superseded. */
  private async tryBackend(backend: string, generation: number): Promise<boolean> {
    const source = this.make(backend);
    try {
      await this.engine.attach(source);
      await this.engine.start();
      if (generation !== this.generation) return false;
      this.source = source;
      this.active = source.id;
      this.state = "running";
      this.error = null;
      if (source instanceof SimulatorSource) this.sim = attachSimulatorControls(source, this.surface);
      return true;
    } catch (err) {
      if (generation !== this.generation) return false;
      this.error = { message: (err as Error)?.message ?? String(err), camera: err instanceof CameraError };
      return false;
    }
  }

  /** Time one backend: warm up, then average the tracking rate. Undefined when it could not start. */
  private async timeBackend(backend: string, generation: number, step: number): Promise<number | undefined> {
    this.trialProgress = { step, of: 2, label: MODE_LABELS[backend as TrackingMode] ?? backend, since: Date.now() };
    const source = this.make(backend);
    try {
      await this.engine.attach(source);
      await this.engine.start();
    } catch (err) {
      if (generation !== this.generation) return undefined;
      this.error = { message: (err as Error)?.message ?? String(err), camera: err instanceof CameraError };
      return undefined;
    }
    this.source = source;
    await sleep(TRIAL_WARMUP_MS);
    const samples: number[] = [];
    for (let waited = 0; waited < TRIAL_MEASURE_MS && generation === this.generation; waited += 250) {
      await sleep(250);
      samples.push(this.engine.api.status.trackingHz);
    }
    if (generation !== this.generation || samples.length === 0) return undefined;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  /**
   * Quick automatic trial: graphics card first, processor only if that is slow. Returns the backend to use,
   * or null if the trial was superseded or hit a camera problem (in which case the state is already set).
   */
  private async trial(generation: number): Promise<string | null> {
    this.state = "tuning";
    const rates: { gpu?: number; cpu?: number } = {};
    rates.gpu = await this.timeBackend("mediapipe-pose-gpu", generation, 1);
    if (generation !== this.generation) return null;
    if (this.cameraFailed()) {
      this.fail();
      return null;
    }
    if (trialNeedsAnother(rates.gpu)) {
      rates.cpu = await this.timeBackend("mediapipe-pose-cpu", generation, 2);
      if (generation !== this.generation) return null;
      if (this.cameraFailed()) {
        this.fail();
        return null;
      }
    }
    const decision = pickTrialBackend(rates);
    saveTrial({ backend: decision.backend, rates, at: new Date().toISOString() });
    this.trialProgress = null;
    this.error = null;
    this.state = "starting";
    return decision.backend;
  }

  apply(patch: Partial<MotionSettings>): void {
    Object.assign(this.settings, patch);
    this.engine.configure({ mirror: this.settings.mirror, sensitivity: this.settings.sensitivity });
  }

  cameras = listCameras;

  /** Measure every backend on this device and remember the result. Tracking restarts afterwards. */
  async check(progress: (step: { index: number; of: number; label: string }) => void): Promise<StoredCheck> {
    this.generation++;
    this.sim?.detach();
    this.sim = null;
    const ids = ["mediapipe-pose-gpu", "mediapipe-pose-cpu", "motion-lite"];
    const result = await runCompatibilityCheck(
      this.engine,
      ids.map((b) => () => (this.source = this.make(b))),
      () => this.renderFps(),
      (message) => {
        const id = /^Measuring (.+)…$/.exec(message)?.[1] ?? "";
        const index = ids.indexOf(id);
        progress({ index: index < 0 ? 1 : index + 1, of: ids.length, label: MODE_LABELS[id as TrackingMode] ?? id });
      },
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
