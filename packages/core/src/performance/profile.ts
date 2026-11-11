/**
 * Compatibility report and performance-profile selection.
 *
 * The report holds measurements only. `recommendProfile` is a pure function of a report so that
 * the thresholds are testable and the same rules apply on every platform.
 */

export type PerformanceProfile = "lite" | "standard" | "enhanced";

export interface BackendMeasurement {
  backend: string;
  /** Pose results per second actually delivered. */
  trackingHz: number;
  /** Mean time from frame capture to the motion API, in milliseconds. */
  latencyMs: number;
  /** Mean time the engine spent per frame, in milliseconds. */
  processingMs: number;
  /** Most players tracked at once during the measurement. */
  playersSeen: number;
  /** Whether the backend reports full skeletons. */
  skeleton: boolean;
  /** Set when the backend could not start. */
  error?: string;
}

export interface CompatibilityReport {
  createdAt: string;
  userAgent: string;
  camera: { available: boolean; count: number; label?: string; width?: number; height?: number; error?: string };
  renderFps: number;
  /** 95 % of screen frames arrived within this many milliseconds while tracking ran. */
  renderP95Ms?: number;
  /** Longest gap between two screen frames while tracking ran, milliseconds. */
  renderWorstMs?: number;
  /** Screen frames later than 33 ms while tracking ran. */
  renderLongFrames?: number;
  /** JS heap in megabytes where the browser exposes it. */
  memoryMb?: number;
  cpuCores?: number;
  backends: BackendMeasurement[];
}

export interface ProfileRecommendation {
  profile: PerformanceProfile | "unsupported";
  backend?: string;
  supportedPlayers: number;
  /** What games can rely on with this hardware. */
  capabilities: { skeleton: boolean; hands: boolean; gestures: "full" | "simple" | "none" };
  reasons: string[];
}

/** Minimum pose rate for skeleton gameplay to feel responsive, and the rate that earns Enhanced. */
export const STANDARD_MIN_HZ = 12;
export const ENHANCED_MIN_HZ = 24;
export const ENHANCED_MAX_LATENCY_MS = 120;
export const MIN_RENDER_FPS = 24;
/** Above this, one frame in twenty is late enough (two refreshes at 60 Hz) to be seen as a hitch. */
export const MAX_RENDER_P95_MS = 33.4;

export function recommendProfile(report: CompatibilityReport): ProfileRecommendation {
  const reasons: string[] = [];
  const none: ProfileRecommendation["capabilities"] = { skeleton: false, hands: false, gestures: "none" };
  if (!report.camera.available) {
    reasons.push(report.camera.error ? `Camera unavailable: ${report.camera.error}` : "No camera was found.");
    return { profile: "unsupported", supportedPlayers: 0, capabilities: none, reasons };
  }
  if (report.renderFps > 0 && report.renderFps < MIN_RENDER_FPS) {
    reasons.push(`Rendering reached only ${report.renderFps.toFixed(0)} fps; games may stutter.`);
  } else if (report.renderP95Ms !== undefined && report.renderP95Ms > MAX_RENDER_P95_MS) {
    reasons.push(`Screen frames were uneven (95% within ${report.renderP95Ms.toFixed(0)} ms, worst ${(report.renderWorstMs ?? 0).toFixed(0)} ms); games may stutter.`);
  }

  const working = report.backends.filter((b) => !b.error && b.trackingHz > 0);
  const skeletal = working.filter((b) => b.skeleton).sort((a, b) => b.trackingHz - a.trackingHz);
  const best = skeletal[0];
  if (best && best.trackingHz >= ENHANCED_MIN_HZ && best.latencyMs <= ENHANCED_MAX_LATENCY_MS) {
    reasons.push(`${best.backend} tracked at ${best.trackingHz.toFixed(0)} Hz with ${best.latencyMs.toFixed(0)} ms latency.`);
    return {
      profile: "enhanced",
      backend: best.backend,
      supportedPlayers: 2,
      capabilities: { skeleton: true, hands: true, gestures: "full" },
      reasons,
    };
  }
  if (best && best.trackingHz >= STANDARD_MIN_HZ) {
    reasons.push(`${best.backend} tracked at ${best.trackingHz.toFixed(0)} Hz.`);
    return {
      profile: "standard",
      backend: best.backend,
      supportedPlayers: 2,
      capabilities: { skeleton: true, hands: true, gestures: "full" },
      reasons,
    };
  }
  if (best) reasons.push(`${best.backend} reached only ${best.trackingHz.toFixed(1)} Hz, below the ${STANDARD_MIN_HZ} Hz needed for skeleton tracking.`);
  for (const b of report.backends) if (b.error) reasons.push(`${b.backend} could not start: ${b.error}`);

  const lite = working.find((b) => !b.skeleton);
  if (lite) {
    reasons.push(`Using motion regions (${lite.backend}) at ${lite.trackingHz.toFixed(0)} Hz.`);
    return {
      profile: "lite",
      backend: lite.backend,
      supportedPlayers: 2,
      capabilities: { skeleton: false, hands: true, gestures: "simple" },
      reasons,
    };
  }
  reasons.push("No tracking backend ran successfully.");
  return { profile: "unsupported", supportedPlayers: 0, capabilities: none, reasons };
}

/** Quick automatic trial (used when no full device check exists): the rate a backend must reach to be kept without timing the next. */
export const TRIAL_GOOD_HZ = 15;
/** Below this the best skeleton backend is too slow and motion regions are used instead. */
export const TRIAL_MIN_HZ = 8;

export interface TrialDecision {
  backend: "mediapipe-pose-gpu" | "mediapipe-pose-cpu" | "motion-lite";
  reason: string;
}

/** Whether the next backend is worth timing. `undefined` means the backend could not start. */
export function trialNeedsAnother(hz: number | undefined): boolean {
  return hz === undefined || hz < TRIAL_GOOD_HZ;
}

/**
 * Pick a backend from measured rates (updates per second). A missing rate means the backend failed to
 * start or was not timed. The faster skeleton backend wins (graphics card on a tie); if even that is
 * below `TRIAL_MIN_HZ`, or nothing ran, fall back to motion regions.
 */
export function pickTrialBackend(rates: { gpu?: number; cpu?: number }): TrialDecision {
  const { gpu, cpu } = rates;
  const best =
    cpu !== undefined && (gpu === undefined || cpu > gpu)
      ? ({ backend: "mediapipe-pose-cpu", hz: cpu } as const)
      : gpu !== undefined
        ? ({ backend: "mediapipe-pose-gpu", hz: gpu } as const)
        : null;
  if (!best) return { backend: "motion-lite", reason: "Full body tracking could not start." };
  if (best.hz < TRIAL_MIN_HZ) return { backend: "motion-lite", reason: `Full body tracking reached only ${best.hz.toFixed(1)} Hz.` };
  return { backend: best.backend, reason: `${best.backend} reached ${best.hz.toFixed(1)} Hz.` };
}
