import { listCameras } from "../camera/camera";
import type { MotionEngine } from "../engine";
import type { PoseSource } from "../types";
import type { FramePacingStats } from "./frame-pacing";
import { recommendProfile, type BackendMeasurement, type CompatibilityReport, type ProfileRecommendation } from "./profile";

const MEASURE_MS = 4000;
const WARMUP_MS = 1500;

/**
 * Measure each camera backend on this device. Every number in the report is measured here and
 * now; nothing is assumed from the hardware's name or age.
 */
export async function runCompatibilityCheck(
  engine: MotionEngine,
  backends: Array<() => PoseSource>,
  renderFps: () => number,
  progress: (message: string) => void,
  /** Frame pacing of the host's render loop, read after each backend's measurement (optional). */
  pacing?: () => FramePacingStats,
): Promise<{ report: CompatibilityReport; recommendation: ProfileRecommendation }> {
  const report: CompatibilityReport = {
    createdAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    camera: { available: false, count: 0 },
    renderFps: 0,
    cpuCores: navigator.hardwareConcurrency,
    backends: [],
  };

  for (const make of backends) {
    const source = make();
    progress(`Measuring ${source.id}…`);
    const measurement: BackendMeasurement = {
      backend: source.id,
      trackingHz: 0,
      latencyMs: 0,
      processingMs: 0,
      playersSeen: 0,
      skeleton: source.capabilities.skeleton,
    };
    try {
      await engine.attach(source);
      await engine.start();
      const camera = (source as { camera?: { width: number; height: number; label: string } | null }).camera;
      if (camera) {
        report.camera.available = true;
        report.camera.width = camera.width;
        report.camera.height = camera.height;
        report.camera.label = camera.label;
      }
      await sleep(WARMUP_MS);
      const off = engine.api.events.on("frame", () => {
        const present = engine.api.players.all().filter((p) => p.present).length;
        measurement.playersSeen = Math.max(measurement.playersSeen, present);
      });
      await sleep(MEASURE_MS);
      off();
      const status = engine.api.status;
      measurement.trackingHz = round(status.trackingHz);
      measurement.latencyMs = round(status.latencyMs);
      measurement.processingMs = round(status.processingMs);
      report.renderFps = Math.max(report.renderFps, round(renderFps()));
      const frames = pacing?.();
      if (frames && frames.frames > 0) {
        report.renderP95Ms = Math.max(report.renderP95Ms ?? 0, round(frames.p95Ms));
        report.renderWorstMs = Math.max(report.renderWorstMs ?? 0, round(frames.worstMs));
        report.renderLongFrames = Math.max(report.renderLongFrames ?? 0, frames.longFrames);
      }
    } catch (err) {
      measurement.error = (err as Error)?.message ?? String(err);
      if ((err as Error)?.name === "CameraError") report.camera.error = measurement.error;
    } finally {
      await engine.stop();
    }
    report.backends.push(measurement);
  }

  report.camera.count = (await listCameras()).length;
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (memory) report.memoryMb = round(memory.usedJSHeapSize / 1048576);
  return { report, recommendation: recommendProfile(report) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round = (v: number): number => Math.round(v * 10) / 10;
