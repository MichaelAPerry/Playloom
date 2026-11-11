import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  formatDiagnostics,
  FramePacingMeter,
  inferenceSize,
  isSoftwareRenderer,
  recommendProfile,
  RollingSamples,
  shortUserAgent,
  type CompatibilityReport,
  type DiagnosticsInputs,
} from "../src";

describe("FramePacingMeter", () => {
  it("reports nothing before two frames", () => {
    const m = new FramePacingMeter();
    expect(m.stats().frames).toBe(0);
    m.tick(0);
    expect(m.stats().frames).toBe(0);
  });

  it("summarises steady 60 Hz", () => {
    const m = new FramePacingMeter();
    for (let i = 0; i < 100; i++) m.tick(i * (1000 / 60));
    const s = m.stats();
    expect(s.fps).toBeCloseTo(60, 3);
    expect(s.medianMs).toBeCloseTo(16.67, 1);
    expect(s.p95Ms).toBeCloseTo(16.67, 1);
    expect(s.worstMs).toBeCloseTo(16.67, 1);
    expect(s.longFrames).toBe(0);
  });

  it("shows stutter that the average hides", () => {
    const m = new FramePacingMeter(120);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += i % 10 === 9 ? 100 : 12; // a 100 ms hitch every tenth frame
      m.tick(t);
    }
    const s = m.stats();
    expect(s.medianMs).toBe(12);
    expect(s.p95Ms).toBe(100);
    expect(s.worstMs).toBe(100);
    expect(s.longFrames).toBe(10);
  });

  it("only looks at the most recent frames", () => {
    const m = new FramePacingMeter(20);
    let t = 0;
    for (let i = 0; i < 20; i++) m.tick((t += 100));
    for (let i = 0; i < 20; i++) m.tick((t += 10));
    expect(m.stats().worstMs).toBe(10);
  });

  it("ignores the pause of a hidden tab", () => {
    const m = new FramePacingMeter();
    m.tick(0);
    m.tick(16);
    m.tick(60_000);
    m.tick(60_016);
    expect(m.stats().worstMs).toBe(16);
  });
});

describe("RollingSamples", () => {
  it("gives quantiles and max of the window", () => {
    const r = new RollingSamples(5);
    for (const v of [9, 1, 5, 3, 7, 100]) r.add(v);
    expect(r.count).toBe(5);
    expect(r.max()).toBe(100);
    expect(r.quantile(0.5)).toBe(5);
  });
});

describe("diagnostics", () => {
  const base = (): DiagnosticsInputs => ({
    status: {
      running: true,
      source: "mediapipe-pose-gpu",
      capabilities: null,
      trackingHz: 18,
      latencyMs: 70,
      processingMs: 0.3,
      captureToScreenMs: 82,
      identity: "locked",
      needsAction: false,
      peopleInView: 2,
    },
    source: {
      delegate: "GPU",
      thread: "worker",
      camera: { width: 1280, height: 720, fps: 30 },
      inference: { width: 320, height: 180 },
      modelMs: { median: 30, p95: 40, worst: 55 },
      skippedPerSecond: 12,
    },
    pacing: { frames: 120, fps: 60, medianMs: 16.7, p95Ms: 17, worstMs: 20, longFrames: 0 },
    env: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      devicePixelRatio: 1.25,
      canvas: { width: 1280, height: 720, cssWidth: 1536, cssHeight: 864 },
      graphics: { renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)", software: false },
    },
  });

  it("recognises software renderers", () => {
    expect(isSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15)")).toBe(true);
    expect(isSoftwareRenderer("Microsoft Basic Render Driver")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)")).toBe(false);
    expect(isSoftwareRenderer("Intel(R) UHD Graphics 630")).toBe(false);
  });

  it("summarises a user agent", () => {
    expect(shortUserAgent(base().env.userAgent)).toBe("Chrome 131 on Windows");
  });

  it("finds nothing to complain about on a healthy machine", () => {
    expect(buildDiagnostics(base()).hints).toEqual([]);
  });

  it("tells a slow camera from a slow model", () => {
    const slowCamera = base();
    slowCamera.source!.camera = { width: 640, height: 480, fps: 8 };
    expect(buildDiagnostics(slowCamera).hints.join(" ")).toMatch(/camera itself delivers only 8/);

    const slowModel = base();
    slowModel.source!.modelMs = { median: 120, p95: 150, worst: 200 };
    expect(buildDiagnostics(slowModel).hints.join(" ")).toMatch(/Pose estimation needs 120 ms/);
  });

  it("flags software graphics and uneven drawing", () => {
    const d = base();
    d.env.graphics = { renderer: "Google SwiftShader", software: true };
    d.pacing = { frames: 120, fps: 40, medianMs: 16.7, p95Ms: 70, worstMs: 140, longFrames: 14 };
    const hints = buildDiagnostics(d).hints.join(" ");
    expect(hints).toMatch(/software graphics/);
    expect(hints).toMatch(/not redrawn evenly/);
  });

  it("formats plain text with every figure the owner needs to send", () => {
    const text = formatDiagnostics(buildDiagnostics(base()));
    expect(text).toContain("mediapipe-pose-gpu / GPU / worker");
    expect(text).toContain("1280x720, 30 pictures/s");
    expect(text).toContain("320x180");
    expect(text).toContain("18.0 per s");
    expect(text).toContain("30 ms typical, 55 ms worst");
    expect(text).toContain("Camera to screen: 82 ms");
    expect(text).toContain("worst 20 ms");
    expect(text).toContain("NVIDIA GeForce RTX 3070");
    expect(text).toContain("pixel ratio 1.25");
    expect(text).toContain("User agent: Mozilla/5.0");
  });

  it("chooses a smaller analysis picture but never enlarges one", () => {
    expect(inferenceSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    expect(inferenceSize(640, 480, 320)).toEqual({ width: 320, height: 240 });
    expect(inferenceSize(256, 144, 320)).toEqual({ width: 256, height: 144 });
    expect(inferenceSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("compatibility report with frame pacing", () => {
  it("mentions uneven rendering even when the average frame rate is fine", () => {
    const report: CompatibilityReport = {
      createdAt: "",
      userAgent: "",
      camera: { available: true, count: 1 },
      renderFps: 55,
      renderP95Ms: 60,
      renderWorstMs: 120,
      renderLongFrames: 9,
      backends: [{ backend: "x", trackingHz: 20, latencyMs: 80, processingMs: 1, playersSeen: 2, skeleton: true }],
    };
    expect(recommendProfile(report).reasons.join(" ")).toMatch(/uneven/);
  });
});
