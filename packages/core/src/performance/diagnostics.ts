import type { TrackingStatus } from "../engine";
import type { SourceDiagnostics } from "../types";
import { LONG_FRAME_MS, type FramePacingStats } from "./frame-pacing";

/**
 * Performance details a player can read out (or copy and send) when a game runs badly. Everything
 * here is measured on the device while it runs; nothing is assumed from the hardware's name.
 * The functions are pure so that they can be tested without a browser.
 */

export interface GraphicsInfo {
  /** The graphics adapter the browser reports ("NVIDIA GeForce RTX 3070", "Intel(R) UHD Graphics", "SwiftShader"...). */
  renderer: string;
  /** True for renderers that run graphics on the processor, which is slow. */
  software: boolean;
}

export interface DiagnosticsEnvironment {
  userAgent: string;
  devicePixelRatio: number;
  /** Drawing surface in pixels and its size on screen in CSS pixels. */
  canvas?: { width: number; height: number; cssWidth: number; cssHeight: number };
  graphics: GraphicsInfo;
}

export interface DiagnosticsInputs {
  status: TrackingStatus;
  source: SourceDiagnostics | null;
  pacing: FramePacingStats;
  env: DiagnosticsEnvironment;
}

export interface DiagnosticsReport {
  backend: string;
  delegate: string;
  thread: string;
  camera?: { width: number; height: number; fps: number };
  inference?: { width: number; height: number };
  trackingHz: number;
  modelMs?: { median: number; worst: number };
  /** Camera capture until the result is first drawn, milliseconds. */
  captureToScreenMs: number;
  /** Camera capture until the result reaches the motion API, milliseconds. */
  captureToApiMs: number;
  display: FramePacingStats;
  people: number;
  graphics: GraphicsInfo;
  userAgent: string;
  devicePixelRatio: number;
  canvas?: DiagnosticsEnvironment["canvas"];
  /** Plain-language findings, most important first. */
  hints: string[];
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|microsoft basic|warp/i;

export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE_RENDERER.test(renderer);
}

/** Ask the browser which graphics adapter it uses. Returns "unknown" where it will not say. */
export function detectGraphicsRenderer(): GraphicsInfo {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { renderer: "no WebGL", software: true };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, software: isSoftwareRenderer(renderer) };
  } catch {
    return { renderer: "unknown", software: false };
  }
}

export function currentEnvironment(canvas: HTMLCanvasElement | null, graphics: GraphicsInfo): DiagnosticsEnvironment {
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio || 1,
    canvas: canvas
      ? { width: canvas.width, height: canvas.height, cssWidth: Math.round(canvas.clientWidth), cssHeight: Math.round(canvas.clientHeight) }
      : undefined,
    graphics,
  };
}

export function buildDiagnostics(input: DiagnosticsInputs): DiagnosticsReport {
  const { status, source, pacing, env } = input;
  const report: DiagnosticsReport = {
    backend: status.source ?? "none",
    delegate: source?.delegate ?? "-",
    thread: source?.thread ?? "-",
    camera: source?.camera,
    inference: source?.inference,
    trackingHz: status.trackingHz,
    modelMs: source?.modelMs ? { median: source.modelMs.median, worst: source.modelMs.worst } : undefined,
    captureToScreenMs: status.captureToScreenMs,
    captureToApiMs: status.latencyMs,
    display: pacing,
    people: status.peopleInView,
    graphics: env.graphics,
    userAgent: env.userAgent,
    devicePixelRatio: env.devicePixelRatio,
    canvas: env.canvas,
    hints: [],
  };
  report.hints = findings(report, source);
  return report;
}

function findings(r: DiagnosticsReport, source: SourceDiagnostics | null): string[] {
  const hints: string[] = [];
  if (r.graphics.software) hints.push(`The browser is drawing with software graphics (${r.graphics.renderer}), which is slow. Check the graphics driver.`);
  if (r.camera && r.camera.fps > 0 && r.camera.fps < 20) {
    hints.push(`The camera itself delivers only ${r.camera.fps.toFixed(0)} pictures per second (often a dim room or a busy USB port). Tracking cannot be faster than that.`);
  }
  if (r.modelMs && r.modelMs.median > 60) {
    hints.push(`Pose estimation needs ${r.modelMs.median.toFixed(0)} ms per picture, which limits tracking to about ${(1000 / r.modelMs.median).toFixed(0)} Hz.`);
  }
  if (r.camera && r.camera.fps >= 20 && r.trackingHz > 0 && r.trackingHz < 12 && r.modelMs && r.modelMs.median <= 60) {
    hints.push("The camera is fast and the model is quick, yet tracking is slow: something else is delaying it (a busy page or a slow graphics driver).");
  }
  if (r.display.frames > 30 && (r.display.p95Ms > LONG_FRAME_MS || r.display.longFrames > r.display.frames * 0.05)) {
    hints.push(
      `The screen is not redrawn evenly: 1 frame in 20 takes ${r.display.p95Ms.toFixed(0)} ms or more (worst ${r.display.worstMs.toFixed(0)} ms). That is what looks like stutter.`,
    );
  }
  if (r.camera && r.camera.width > 1280) {
    hints.push(`The camera sends ${r.camera.width}x${r.camera.height}. Playloom analyses a smaller copy (${r.inference?.width ?? "?"} wide), so this is normally fine.`);
  }
  if (source?.skippedPerSecond !== undefined && r.camera && source.skippedPerSecond > r.camera.fps * 0.7 && r.camera.fps > 0) {
    hints.push("Most camera pictures are skipped because the model is still busy with the previous one.");
  }
  if (r.captureToScreenMs > 150) hints.push(`From camera to screen takes ${r.captureToScreenMs.toFixed(0)} ms, which feels laggy.`);
  return hints;
}

const n = (v: number, digits = 0): string => v.toFixed(digits);

/** Label/value pairs in display order, shared by the on-screen panel and the copied text. */
export function diagnosticsRows(r: DiagnosticsReport): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  rows.push(["Tracking", `${r.backend} / ${r.delegate} / ${r.thread}`]);
  rows.push(["Camera", r.camera ? `${r.camera.width}x${r.camera.height}, ${n(r.camera.fps)} pictures/s` : "-"]);
  rows.push(["Analysed at", r.inference ? `${r.inference.width}x${r.inference.height}` : "-"]);
  rows.push(["Tracking updates", `${n(r.trackingHz, 1)} per s`]);
  rows.push(["Model time", r.modelMs ? `${n(r.modelMs.median)} ms typical, ${n(r.modelMs.worst)} ms worst` : "-"]);
  rows.push(["Camera to API", `${n(r.captureToApiMs)} ms`]);
  rows.push(["Camera to screen", r.captureToScreenMs > 0 ? `${n(r.captureToScreenMs)} ms` : "-"]);
  rows.push(["Screen", `${n(r.display.fps)} fps, 95% under ${n(r.display.p95Ms, 1)} ms, worst ${n(r.display.worstMs)} ms, ${r.display.longFrames} long`]);
  rows.push(["People seen", String(r.people)]);
  rows.push(["Graphics", `${r.graphics.renderer}${r.graphics.software ? " (SOFTWARE)" : ""}`]);
  rows.push(["Canvas", r.canvas ? `${r.canvas.width}x${r.canvas.height} shown at ${r.canvas.cssWidth}x${r.canvas.cssHeight}, pixel ratio ${r.devicePixelRatio}` : `pixel ratio ${r.devicePixelRatio}`]);
  rows.push(["Browser", shortUserAgent(r.userAgent)]);
  return rows;
}

/** "Chrome 131 on Windows" style summary of a user agent string. */
export function shortUserAgent(ua: string): string {
  const browser = /Edg\/([\d.]+)/.exec(ua) ?? /Firefox\/([\d.]+)/.exec(ua) ?? /Chrome\/([\d.]+)/.exec(ua) ?? /Version\/([\d.]+).*Safari/.exec(ua);
  const name = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "unknown system";
  const version = browser ? ` ${browser[1]!.split(".")[0]}` : "";
  return `${name}${version} on ${os}`;
}

/** Plain text for pasting into a message. */
export function formatDiagnostics(r: DiagnosticsReport): string {
  const lines = ["Playloom performance details", ...diagnosticsRows(r).map(([k, v]) => `${k}: ${v}`)];
  lines.push(`User agent: ${r.userAgent}`);
  if (r.hints.length) lines.push("", "Findings:", ...r.hints.map((h) => `- ${h}`));
  return lines.join("\n");
}
