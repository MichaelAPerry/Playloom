import {
  listCameras,
  loadSettings,
  MediaPipePoseSource,
  MotionEngine,
  MotionLiteSource,
  RateMeter,
  saveSettings,
  type FrameSink,
  type MotionEvents,
  type PoseSource,
} from "@playloom/core";
import {
  attachSimulatorControls,
  parseRecording,
  PlaybackSource,
  PoseRecorder,
  SIMULATOR_HELP,
  SimulatorSource,
  type SimulatorControls,
} from "@playloom/simulator";
import { runCompatibilityCheck } from "./benchmark";
import { draw } from "./draw";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d")!;
const stage = $("stage");
const sourceSelect = $<HTMLSelectElement>("source");
const cameraSelect = $<HTMLSelectElement>("camera");
const mirrorBox = $<HTMLInputElement>("mirror");
const overlayBox = $<HTMLInputElement>("overlay");
const sensitivity = $<HTMLInputElement>("sensitivity");
const logList = $("log");
const banner = $("banner");
const notice = $("notice");

const settings = loadSettings(localStorage);
const engine = new MotionEngine({ mirror: settings.mirror, sensitivity: settings.sensitivity, thresholds: settings.thresholds });
const api = engine.api;

let source: PoseSource | null = null;
let simControls: SimulatorControls | null = null;
let recorder: PoseRecorder | null = null;
let busy = false;

// ---- Sources ------------------------------------------------------------------------------------

/** Lets the recorder see frames from whichever source is active without the engine knowing. */
function recordable(inner: PoseSource): PoseSource {
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    start: (sink: FrameSink) => inner.start((frame) => (recorder ? recorder.tap(sink)(frame) : sink(frame))),
    stop: () => inner.stop(),
  };
}

const makeMediaPipe = (delegate: "GPU" | "CPU" = "GPU"): MediaPipePoseSource =>
  new MediaPipePoseSource({ delegate, camera: { deviceId: cameraSelect.value || undefined, width: 640, height: 480 } });
const makeLite = (): MotionLiteSource => new MotionLiteSource({ camera: { deviceId: cameraSelect.value || undefined } });

function currentVideo(): HTMLVideoElement | null {
  const camera = (source as { camera?: { video: HTMLVideoElement } | null } | null)?.camera;
  return camera?.video ?? null;
}

async function useSource(kind: string, playback?: PlaybackSource): Promise<void> {
  if (busy) return;
  busy = true;
  showNotice(kind === "simulator" || playback ? null : "Starting camera…");
  simControls?.detach();
  simControls = null;
  try {
    if (playback) source = playback;
    else if (kind === "mediapipe-gpu") source = makeMediaPipe("GPU");
    else if (kind === "mediapipe-cpu") source = makeMediaPipe("CPU");
    else if (kind === "lite") source = makeLite();
    else {
      const sim = new SimulatorSource();
      simControls = attachSimulatorControls(sim, stage);
      source = sim;
    }
    await engine.attach(recordable(source));
    await engine.start();
    showNotice(null);
    if (kind !== "simulator") void refreshCameras();
  } catch (err) {
    source = null;
    showNotice(`${(err as Error).message} You can still use the simulator.`, true);
  } finally {
    busy = false;
    $("sim-help").hidden = !simControls;
    $("camera-row").hidden = sourceSelect.value === "simulator";
  }
}

async function refreshCameras(): Promise<void> {
  const cameras = await listCameras();
  const selected = cameraSelect.value || settings.cameraId || "";
  cameraSelect.replaceChildren(
    ...cameras.map((c) => {
      const option = document.createElement("option");
      option.value = c.deviceId;
      option.textContent = c.label;
      return option;
    }),
  );
  if (cameras.some((c) => c.deviceId === selected)) cameraSelect.value = selected;
}

function showNotice(text: string | null, error = false): void {
  notice.hidden = !text;
  notice.textContent = text ?? "";
  notice.classList.toggle("error", error);
}

// ---- Event log ----------------------------------------------------------------------------------

function log(text: string, cls: string): void {
  const li = document.createElement("li");
  li.className = cls;
  li.textContent = text;
  logList.prepend(li);
  while (logList.children.length > 60) logList.lastChild?.remove();
}

api.events.on("gesture", (e) => {
  const detail = e.gesture === "swipe" ? ` ${e.hand} hand ${e.direction}` : ` ${e.phase}`;
  log(`P${e.player} ${e.gesture}${detail}`, `p${e.player}`);
});
const system: Array<[keyof MotionEvents, string]> = [
  ["player-joined", "joined"],
  ["player-left", "left"],
  ["tracking-lost", "tracking lost"],
  ["tracking-restored", "tracking restored"],
];
for (const [type, text] of system) {
  api.events.on(type, (e) => log(`P${(e as { player: number }).player} ${text}`, `p${(e as { player: number }).player}`));
}
api.events.on("identity-uncertain", (e) => log(`identity uncertain (${e.reason})${e.needsAction ? " — action needed" : ""}`, "sys"));
api.events.on("identity-restored", () => log("identity restored", "sys"));
api.events.on("identity-swapped", () => log("players renumbered", "sys"));

// ---- Banner: identity warnings and calibration ---------------------------------------------------

let calibrating = false;
let calibrationProgress = 0;
api.events.on("calibration-progress", (e) => (calibrationProgress = e.progress));

function setBanner(title: string | null, text = "", actions: Array<[string, () => void]> = []): void {
  banner.hidden = title === null;
  if (title === null) return;
  if ($("banner-title").textContent !== title) {
    $("banner-title").textContent = title;
    $("banner-actions").replaceChildren(
      ...actions.map(([label, fn]) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", fn);
        return b;
      }),
    );
  }
  $("banner-text").textContent = text;
}

function updateBanner(): void {
  if (calibrating) {
    const seen = api.players.all().filter((p) => p.present).length;
    setBanner(
      "Player setup",
      seen < 2 ? `Waiting for two players… (${seen} in view)` : `Stand still… ${Math.round(calibrationProgress * 100)}%`,
      [["Cancel", () => engine.cancelCalibration()]],
    );
  } else if (api.status.needsAction) {
    setBanner("Who is who?", "Step back to your own side — or tell me if you have swapped places.", [
      ["We swapped places", () => engine.confirmIdentities()],
    ]);
  } else {
    setBanner(null);
  }
}

$("calibrate").addEventListener("click", async () => {
  if (calibrating) return;
  calibrating = true;
  calibrationProgress = 0;
  try {
    const result = await engine.calibrate({ players: 2, durationMs: 2000, timeoutMs: 30_000 });
    const sizes = Object.entries(result.players).map(([id, c]) => `P${id}: ${(c.scale * 100).toFixed(0)}%`);
    $("calibration-info").textContent = `Set up. Body size (of picture height) — ${sizes.join(", ")}.`;
    log("player setup complete", "sys");
  } catch (err) {
    $("calibration-info").textContent = (err as Error).message;
  } finally {
    calibrating = false;
  }
});
$("swap").addEventListener("click", () => engine.swapPlayers(1, 2));

// ---- Settings -----------------------------------------------------------------------------------

function persist(): void {
  saveSettings(localStorage, {
    ...settings,
    mirror: mirrorBox.checked,
    sensitivity: Number(sensitivity.value),
    cameraId: cameraSelect.value || undefined,
    backend: sourceSelect.value,
  });
}
mirrorBox.checked = settings.mirror;
sensitivity.value = String(settings.sensitivity);
$("sensitivity-out").textContent = settings.sensitivity.toFixed(1);
mirrorBox.addEventListener("change", () => {
  engine.configure({ mirror: mirrorBox.checked });
  persist();
});
sensitivity.addEventListener("input", () => {
  engine.configure({ sensitivity: Number(sensitivity.value) });
  $("sensitivity-out").textContent = Number(sensitivity.value).toFixed(1);
  persist();
});
sourceSelect.addEventListener("change", () => {
  persist();
  void useSource(sourceSelect.value);
});
cameraSelect.addEventListener("change", () => {
  persist();
  if (sourceSelect.value !== "simulator") void useSource(sourceSelect.value);
});

// ---- Recording and playback -----------------------------------------------------------------------

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const recordButton = $("record");
recordButton.addEventListener("click", () => {
  if (!source) return;
  if (recorder) {
    // Recordings hold keypoint coordinates only — never camera images.
    download(`playloom-poses-${Date.now()}.jsonl`, recorder.toJSONL(), "application/jsonl");
    log(`saved recording (${recorder.frames.length} frames)`, "sys");
    recorder = null;
  } else {
    recorder = new PoseRecorder({ source: source.id, capabilities: source.capabilities });
  }
  recordButton.textContent = recorder ? "Stop & save" : "Record";
  recordButton.classList.toggle("active", !!recorder);
});

const fileInput = $<HTMLInputElement>("file");
$("play").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) return showNotice("That file is too large to be a pose recording.", true);
  try {
    const playback = new PlaybackSource(parseRecording(await file.text()), { clock: "realtime", loop: true });
    await useSource("playback", playback);
    log(`playing ${file.name}`, "sys");
  } catch (err) {
    showNotice((err as Error).message, true);
  }
});

// ---- Compatibility check --------------------------------------------------------------------------

const renderRate = new RateMeter(2000);
$("benchmark").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  simControls?.detach();
  simControls = null;
  const reportBox = $("report");
  reportBox.hidden = false;
  try {
    const { report, recommendation } = await runCompatibilityCheck(
      engine,
      [
        () => (source = makeMediaPipe("GPU")),
        () => (source = makeMediaPipe("CPU")),
        () => (source = makeLite()),
      ],
      () => renderRate.rate(),
      (message) => (reportBox.textContent = message),
    );
    const text = JSON.stringify({ recommendation, report }, null, 2);
    reportBox.textContent = `Recommended profile: ${recommendation.profile.toUpperCase()}\n${recommendation.reasons.join("\n")}\n\n${text}`;
    const save = $("save-report");
    save.hidden = false;
    save.onclick = () => download("playloom-compatibility.json", text, "application/json");
  } finally {
    busy = false;
    await useSource(sourceSelect.value);
  }
});

// ---- Render loop ----------------------------------------------------------------------------------

function stat(label: string, value: string, warn = false): string {
  return `<span class="stat${warn ? " warn" : ""}">${label} <b>${value}</b></span>`;
}

let lastStats = 0;
function frame(now: number): void {
  renderRate.tick(now);
  draw(ctx, api, {
    video: currentVideo(),
    mirror: mirrorBox.checked,
    overlay: overlayBox.checked,
    selectedSimPlayer: simControls?.selectedPlayer ?? 0,
  });
  updateBanner();
  if (now - lastStats > 250) {
    lastStats = now;
    const s = api.status;
    const present = api.players.all().filter((p) => p.present).length;
    $("stats").innerHTML =
      stat("Source", s.source ?? "none") +
      stat("Players", `${present}`) +
      stat("People in view", `${s.peopleInView}`) +
      stat("Tracking", `${s.trackingHz.toFixed(0)} Hz`, s.running && s.trackingHz < 12) +
      stat("Render", `${renderRate.rate().toFixed(0)} fps`) +
      stat("Latency", `${s.latencyMs.toFixed(0)} ms`, s.latencyMs > 150) +
      stat("Engine", `${s.processingMs.toFixed(2)} ms`) +
      stat("Identity", s.identity, s.identity === "uncertain");
  }
  requestAnimationFrame(frame);
}

// ---- Start ----------------------------------------------------------------------------------------

$("keys").replaceChildren(
  ...SIMULATOR_HELP.flatMap(([key, text]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = text;
    return [dt, dd];
  }),
);
// Always start in the simulator: it needs no permission and works on any machine.
sourceSelect.value = "simulator";
void useSource("simulator");
requestAnimationFrame(frame);

// Exposed for automated browser tests and for poking around in the console.
(window as unknown as { playloom: unknown }).playloom = { engine, api, getSource: () => source };
