import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  handPoint,
  loadSettings,
  measureBody,
  MEDIAPIPE_LANDMARKS,
  OneEuroFilter,
  personFromLandmarks,
  pickTrialBackend,
  trialNeedsAnother,
  RateMeter,
  recommendProfile,
  saveSettings,
  type CompatibilityReport,
} from "../src";

describe("OneEuroFilter", () => {
  it("reduces jitter on a still signal", () => {
    const f = new OneEuroFilter();
    let noisy = 0;
    let smooth = 0;
    let prev = 0.5;
    for (let i = 0; i < 200; i++) {
      const v = 0.5 + (i % 2 === 0 ? 0.01 : -0.01);
      const out = f.filter(v, i * 33);
      if (i > 20) {
        noisy += 0.02;
        smooth += Math.abs(out - prev);
      }
      prev = out;
    }
    expect(smooth).toBeLessThan(noisy * 0.3);
  });

  it("catches up with a fast movement within a few frames", () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    let out = 0;
    for (let i = 30; i < 36; i++) out = f.filter(1, i * 33);
    expect(out).toBeGreaterThan(0.9);
  });

  it("starts fresh after a long gap", () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    expect(f.filter(1, 5000)).toBe(1);
  });
});

describe("body measurement", () => {
  const k = (x: number, y: number, score = 0.9) => ({ x, y, score });

  it("uses the shoulder centre as anchor and torso length as scale", () => {
    const body = measureBody(
      { score: 1, keypoints: { leftShoulder: k(0.4, 0.3), rightShoulder: k(0.6, 0.3), leftHip: k(0.45, 0.6), rightHip: k(0.55, 0.6) } },
      0.3,
    )!;
    expect(body.anchor).toEqual({ x: 0.5, y: 0.3 });
    expect(body.scale).toBeCloseTo(0.3);
  });

  it("estimates scale from shoulders alone and keeps the same anchor", () => {
    const body = measureBody({ score: 1, keypoints: { leftShoulder: k(0.4, 0.3), rightShoulder: k(0.6, 0.3), leftHip: k(0.45, 0.6, 0.1) } }, 0.3)!;
    expect(body.anchor).toEqual({ x: 0.5, y: 0.3 });
    expect(body.scale).toBeCloseTo(0.28);
  });

  it("returns null when nothing usable is visible", () => {
    expect(measureBody({ score: 1, keypoints: { nose: k(0.5, 0.2) } }, 0.3)).toBeNull();
  });

  it("prefers the finger tip, then an extended wrist", () => {
    expect(handPoint({ leftIndex: k(0.1, 0.1), leftWrist: k(0.2, 0.2) }, "left", 0.3)).toMatchObject({ x: 0.1, y: 0.1 });
    const extended = handPoint({ rightWrist: k(0.5, 0.5), rightElbow: k(0.5, 0.7) }, "right", 0.3)!;
    expect(extended.y).toBeCloseTo(0.45);
    expect(handPoint({ rightWrist: k(0.5, 0.5, 0.1) }, "right", 0.3)).toBeUndefined();
  });
});

describe("MediaPipe landmark mapping", () => {
  it("maps the 33 landmarks to named keypoints", () => {
    const landmarks = Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: 0.5, visibility: 0.8 }));
    const person = personFromLandmarks(landmarks);
    expect(person.keypoints.leftWrist!.x).toBeCloseTo(0.15);
    expect(person.keypoints.rightIndex!.x).toBeCloseTo(0.2);
    expect(person.keypoints.rightAnkle!.x).toBeCloseTo(0.28);
    expect(Object.keys(person.keypoints)).toHaveLength(Object.keys(MEDIAPIPE_LANDMARKS).length);
    expect(person.score).toBeCloseTo(0.8);
  });

  it("distrusts landmarks extrapolated outside the picture", () => {
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 1.4, visibility: 0.9 }));
    expect(personFromLandmarks(landmarks).keypoints.leftAnkle!.score).toBe(0);
  });
});

describe("RateMeter", () => {
  it("measures events per second", () => {
    const m = new RateMeter(2000);
    for (let t = 0; t <= 3000; t += 50) m.tick(t);
    expect(m.rate()).toBeCloseTo(20);
  });
});

describe("profile recommendation", () => {
  const base: CompatibilityReport = {
    createdAt: "2026-01-01T00:00:00Z",
    userAgent: "test",
    camera: { available: true, count: 1 },
    renderFps: 60,
    backends: [],
  };
  const pose = (trackingHz: number, latencyMs = 60) => ({ backend: "mediapipe-pose-gpu", trackingHz, latencyMs, processingMs: 1, playersSeen: 2, skeleton: true });
  const lite = { backend: "motion-lite", trackingHz: 30, latencyMs: 20, processingMs: 1, playersSeen: 2, skeleton: false };

  it("recommends Enhanced only for fast, low-latency skeleton tracking", () => {
    expect(recommendProfile({ ...base, backends: [pose(30), lite] }).profile).toBe("enhanced");
    expect(recommendProfile({ ...base, backends: [pose(30, 200), lite] }).profile).toBe("standard");
  });

  it("recommends Standard for moderate skeleton tracking", () => {
    const r = recommendProfile({ ...base, backends: [pose(15), lite] });
    expect(r.profile).toBe("standard");
    expect(r.capabilities.skeleton).toBe(true);
  });

  it("falls back to Lite when pose tracking is too slow or fails, and says why", () => {
    const slow = recommendProfile({ ...base, backends: [pose(5), lite] });
    expect(slow.profile).toBe("lite");
    expect(slow.capabilities).toEqual({ skeleton: false, hands: true, gestures: "simple" });
    expect(slow.reasons.join(" ")).toMatch(/5\.0 Hz/);
    const failed = recommendProfile({ ...base, backends: [{ ...pose(0), error: "WebGL unavailable" }, lite] });
    expect(failed.profile).toBe("lite");
    expect(failed.reasons.join(" ")).toMatch(/WebGL unavailable/);
  });

  it("reports unsupported without a camera or without any working backend", () => {
    expect(recommendProfile({ ...base, camera: { available: false, count: 0 } }).profile).toBe("unsupported");
    expect(recommendProfile({ ...base, backends: [] }).profile).toBe("unsupported");
  });
});

describe("quick tracking trial decision", () => {
  it("only times the processor backend when the graphics path is slow or failed", () => {
    expect(trialNeedsAnother(30)).toBe(false);
    expect(trialNeedsAnother(15)).toBe(false);
    expect(trialNeedsAnother(14.9)).toBe(true);
    expect(trialNeedsAnother(undefined)).toBe(true);
  });

  it("keeps whichever skeleton backend is faster, preferring the graphics card on a tie", () => {
    expect(pickTrialBackend({ gpu: 24 }).backend).toBe("mediapipe-pose-gpu");
    expect(pickTrialBackend({ gpu: 3, cpu: 16 }).backend).toBe("mediapipe-pose-cpu");
    expect(pickTrialBackend({ gpu: 12, cpu: 9 }).backend).toBe("mediapipe-pose-gpu");
    expect(pickTrialBackend({ gpu: 10, cpu: 10 }).backend).toBe("mediapipe-pose-gpu");
    expect(pickTrialBackend({ cpu: 12 }).backend).toBe("mediapipe-pose-cpu");
  });

  it("falls back to motion regions when the best is below 8 Hz or nothing started", () => {
    expect(pickTrialBackend({ gpu: 2, cpu: 7.9 }).backend).toBe("motion-lite");
    expect(pickTrialBackend({ gpu: 8 }).backend).toBe("mediapipe-pose-gpu");
    expect(pickTrialBackend({}).backend).toBe("motion-lite");
  });
});

describe("settings storage", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("round-trips settings", () => {
    const store = memory();
    saveSettings(store, { ...DEFAULT_SETTINGS, mirror: false, sensitivity: 1.5, cameraId: "abc" });
    expect(loadSettings(store)).toMatchObject({ mirror: false, sensitivity: 1.5, cameraId: "abc" });
  });

  it("falls back to defaults on malformed or hostile data", () => {
    const store = memory();
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
    store.setItem("playloom.motion-settings", "{not json");
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
    store.setItem("playloom.motion-settings", JSON.stringify({ version: 1, sensitivity: 9999, mirror: "yes", thresholds: { jump: -1, duck: "x" } }));
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
  });
});
