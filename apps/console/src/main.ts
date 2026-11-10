import { loadSettings, RateMeter, saveSettings, type KeypointName, type PlayerState } from "@playloom/core";
import { GameRuntime, PLAYER_COLORS, renderToCanvas, WebAudioPlayer } from "@playloom/runtime";
import { PACKAGE_LIMITS, packageFileName, unpackGame, type GameDefinition } from "@playloom/sdk";
import { bundledGames, exportGame, installedGames, installGame, loadImages, removeGame, type LibraryEntry } from "./library";
import { focusFirst, setNavigation, startNavigation } from "./nav";
import { loadCheck, MODE_LABELS, Tracking, type StoredCheck, type TrackingMode } from "./tracking";

// ---- Small DOM helpers ----------------------------------------------------------------------------

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "onclick") el.addEventListener("click", value as EventListener);
    else if (key === "style") el.setAttribute("style", String(value));
    else if (key.startsWith("data-")) el.setAttribute(key, value === true ? "" : String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children) if (child) el.append(child);
  return el;
}
const button = (label: Child, onclick: () => void, cls = "", extra: Record<string, unknown> = {}): HTMLButtonElement =>
  h("button", { class: cls, onclick, type: "button", ...extra }, label);

const stage = document.getElementById("stage") as HTMLCanvasElement;
const ctx = stage.getContext("2d")!;
const screenEl = document.getElementById("screen")!;
const overlayEl = document.getElementById("overlay")!;
const toastEl = document.getElementById("toast")!;
const fileInput = document.getElementById("package-file") as HTMLInputElement;

// ---- App state ------------------------------------------------------------------------------------

interface Prefs {
  volume: number;
  welcomed: boolean;
}
const PREFS_KEY = "playloom.console";
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { volume: typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : 0.8, welcomed: p.welcomed === true };
  } catch {
    return { volume: 0.8, welcomed: false };
  }
}
const prefs = loadPrefs();
const savePrefs = (): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not being able to remember a setting must never stop the game.
  }
};

const settings = loadSettings(localStorage);
const persist = (): void => {
  try {
    saveSettings(localStorage, settings);
  } catch {
    /* as above */
  }
};
const tracking = new Tracking(settings, stage);
const api = tracking.engine.api;
const audio = new WebAudioPlayer();
audio.volume = prefs.volume;
for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, () => audio.unlock(), { once: true });

type Screen = "home" | "setup" | "play" | "settings";
let screen: Screen = "home";
let library: LibraryEntry[] = [];
let calibrated = false;
let pendingGame: LibraryEntry | null = null;
let playing: { entry: LibraryEntry; runtime: GameRuntime; images: Map<string, HTMLImageElement>; release: () => void } | null = null;
let playOverlay = "";
let setupRun = 0;

// ---- Toasts and dialogs ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

interface DialogButton {
  id: string;
  label: string;
  cls?: string;
}
let dialogCancel: (() => void) | null = null;

function showOverlay(content: HTMLElement, cancel: (() => void) | null): void {
  overlayEl.replaceChildren(content);
  overlayEl.hidden = false;
  dialogCancel = cancel;
  focusFirst();
}
function hideOverlay(): void {
  overlayEl.hidden = true;
  overlayEl.replaceChildren();
  dialogCancel = null;
}

/** Ask a question. Resolves with the id of the chosen button; going back chooses `cancel`. */
function ask(title: string, body: Child[], buttons: DialogButton[], cancel: string): Promise<string> {
  return new Promise((resolve) => {
    const done = (id: string): void => {
      hideOverlay();
      resolve(id);
      focusFirst();
    };
    showOverlay(
      h("div", { class: "dialog", role: "dialog" }, h("h1", {}, title), ...body, h("div", { class: "row" }, ...buttons.map((b, i) => button(b.label, () => done(b.id), b.cls ?? "", { "data-first": i === 0 })))),
      () => done(cancel),
    );
  });
}

// ---- Navigation -----------------------------------------------------------------------------------

function back(): void {
  if (dialogCancel) return dialogCancel();
  if (screen === "play") return togglePause();
  if (screen !== "home") show("home");
}

function togglePause(): void {
  const runtime = playing?.runtime;
  if (!runtime || runtime.state === "ended") return;
  if (runtime.pauseReason === "user") runtime.resume();
  else runtime.pause();
}

setNavigation({ layer: () => (overlayEl.hidden ? screenEl : overlayEl), back, menu: () => (screen === "play" ? togglePause() : undefined) });

function show(next: Screen): void {
  if (screen === "setup" && next !== "setup") {
    setupRun++;
    tracking.engine.cancelCalibration();
  }
  if (screen === "play" && next !== "play") {
    playing?.runtime.stop();
    playing?.release();
    playing = null;
    playOverlay = "";
    hideOverlay();
  }
  screen = next;
  document.body.classList.toggle("show-stage", next === "setup" || next === "play");
  if (next === "home") renderHome();
  else if (next === "settings") renderSettings();
  else if (next === "setup") renderSetup();
  else screenEl.replaceChildren(h("div", { class: "corner" }, "Esc or Back: pause"));
  focusFirst();
}

// ---- Home -----------------------------------------------------------------------------------------

const TILE_COLORS = ["#e4572e", "#17bebb", "#8f5bd8", "#f2a541", "#3f88c5", "#d1495b"];

function canPlay(game: GameDefinition): string | null {
  const caps = api.status.capabilities;
  if (game.requires.tracking === "skeleton" && caps && !caps.skeleton) return "Needs full body tracking";
  return null;
}

function gameTile(entry: LibraryEntry, index: number): HTMLButtonElement {
  const { game } = entry;
  const background = game.assets?.find((a) => a.id === game.scenes.find((s) => s.id === game.startScene)?.backgroundImage);
  const picture = background && entry.assets.get(background.file);
  const art = h("div", { class: "art", style: `background-color:${TILE_COLORS[index % TILE_COLORS.length]}` });
  if (typeof picture === "string") art.style.backgroundImage = `url("${picture}")`;
  else art.append(h("b", {}, game.meta.name.slice(0, 1).toUpperCase()));
  const warning = canPlay(game);
  const players = game.requires.players;
  return button(
    h(
      "span",
      { style: "display:contents" },
      art,
      h(
        "span",
        { class: "info" },
        h("span", { class: "name" }, game.meta.name),
        h(
          "span",
          { class: "meta" },
          h("span", { class: "badge" }, game.meta.mode === "cooperative" ? "Team up" : "Compete"),
          h("span", {}, players.min === players.max ? `${players.min} player${players.min === 1 ? "" : "s"}` : `${players.min}–${players.max} players`),
          warning ? h("span", { class: "badge warn" }, warning) : null,
        ),
      ),
    ),
    () => void chooseGame(entry),
    "tile",
    { "data-first": index === 0 },
  );
}

function smallTile(glyph: string, label: string, hint: string, onclick: () => void): HTMLButtonElement {
  return button(h("span", { style: "display:contents" }, h("span", { class: "glyph" }, glyph), h("span", {}, label, h("small", { class: "note", style: "background:none;padding:0" }, hint))), onclick, "tile small");
}

function renderHome(): void {
  const alert =
    tracking.state === "error"
      ? h(
          "div",
          { class: "alert", role: "alert" },
          h("p", {}, tracking.error?.camera ? `${tracking.error.message} Check that the camera is plugged in and not being used by another program.` : `Tracking could not start: ${tracking.error?.message ?? "unknown problem"}`),
          button("Try again", () => void restartTracking()),
          button("Practise without a camera", () => setMode("practice")),
        )
      : null;
  screenEl.replaceChildren(
    h(
      "div",
      { class: "top" },
      h("div", { class: "brand" }, "Play", h("span", {}, "loom")),
      h("div", { class: "tagline" }, "Play together. Create anything."),
      h("div", { class: "spacer" }),
      h("span", { class: "chip", id: "mode-chip" }),
      h("span", { class: "chip p1", id: "chip-1" }, h("i"), "Player 1"),
      h("span", { class: "chip p2", id: "chip-2" }, h("i"), "Player 2"),
    ),
    ...(alert ? [alert] : []),
    h("h2", {}, "Games"),
    h("div", { class: "tiles" }, ...library.map(gameTile)),
    h("h2", {}, "More"),
    h(
      "div",
      { class: "tiles" },
      smallTile("P", "Player setup", "Stand side by side and get recognised", () => openSetup(null)),
      smallTile("+", "Add a game", "Install a .playloom file", () => fileInput.click()),
      smallTile("⚙", "Settings", "For grown-ups", () => show("settings")),
    ),
    h("div", { class: "foot" }, "Your camera picture stays on this device. Playloom has no accounts, no adverts and no internet connection."),
  );
  updateChips();
}

function updateChips(): void {
  for (const id of [1, 2]) document.getElementById(`chip-${id}`)?.classList.toggle("on", !!api.players.get(id)?.present);
  const chip = document.getElementById("mode-chip");
  if (chip) {
    chip.textContent =
      tracking.state === "starting" ? "Starting camera…" : tracking.state === "error" ? "No tracking" : tracking.practice ? "Practice mode" : api.status.capabilities?.skeleton ? "Camera on" : "Camera on · Lite";
  }
}

async function chooseGame(entry: LibraryEntry): Promise<void> {
  if (tracking.state !== "running") {
    const answer = await ask(
      "The camera is not ready",
      [h("p", {}, tracking.state === "starting" ? "Give it a moment and try again." : "Playloom cannot see anyone yet. You can try the camera again, or practise with the keyboard.")],
      [{ id: "retry", label: "Try the camera again", cls: "go" }, { id: "practice", label: "Practise without a camera" }, { id: "no", label: "Back", cls: "quiet" }],
      "no",
    );
    if (answer === "retry") await restartTracking();
    if (answer === "practice") setMode("practice");
    return;
  }
  const warning = canPlay(entry.game);
  if (warning) {
    const answer = await ask(
      "This game may not work here",
      [h("p", {}, `${entry.game.meta.name} needs full body tracking, and this device is using Lite tracking, which only follows movement. Jumps, ducks and leans will not be noticed.`)],
      [{ id: "no", label: "Choose another game", cls: "go" }, { id: "yes", label: "Play anyway" }],
      "no",
    );
    if (answer !== "yes") return;
  }
  if (!calibrated && api.status.capabilities?.skeleton && !tracking.practice) return openSetup(entry);
  launch(entry);
}

function launch(entry: LibraryEntry): void {
  const { images, release } = loadImages(entry);
  const runtime = new GameRuntime(entry.game, api, { audio });
  playing = { entry, runtime, images, release };
  show("play");
  runtime.start();
}

// ---- Player setup ---------------------------------------------------------------------------------

function openSetup(then: LibraryEntry | null): void {
  if (tracking.state !== "running" || tracking.practice || !api.status.capabilities?.skeleton) {
    void ask(
      "Player setup is not needed",
      [h("p", {}, tracking.practice ? "In practice mode the players are pretend, so there is nobody to recognise." : tracking.state !== "running" ? "The camera is not running yet." : "Lite tracking tells players apart by side: Player 1 stands on the left, Player 2 on the right.")],
      [{ id: "ok", label: "OK", cls: "go" }],
      "ok",
    ).then(() => then && tracking.state === "running" && launch(then));
    return;
  }
  pendingGame = then;
  show("setup");
}

function renderSetup(): void {
  const run = ++setupRun;
  const title = h("h1", {}, "Player setup");
  const text = h("p", {}, "Stand side by side where the camera can see you. Player 1 on the left, Player 2 on the right. Then stand still.");
  const fill = h("i");
  const actions = h("div", { class: "row" });
  const finish = (): void => {
    const next = pendingGame;
    pendingGame = null;
    if (next) launch(next);
    else show("home");
  };
  const begin = (): void => {
    title.textContent = "Player setup";
    actions.replaceChildren(button(pendingGame ? "Skip" : "Back", () => (pendingGame ? finish() : show("home")), "quiet", { "data-first": true }));
    focusFirst();
    const off = api.events.on("calibration-progress", (e) => {
      if (run !== setupRun) return;
      fill.style.width = `${Math.round(e.progress * 100)}%`;
      text.textContent =
        e.playersSeen < 2
          ? `I can see ${e.playersSeen === 0 ? "nobody" : "one player"} so far. Two players, side by side — Player 1 on the left, Player 2 on the right.`
          : e.progress > 0
            ? "Perfect. Stand still…"
            : "I can see you both. Now stand still.";
    });
    tracking.engine
      .calibrate({ players: 2, durationMs: 2000, timeoutMs: 45_000 })
      .then(() => {
        off();
        if (run !== setupRun) return;
        calibrated = true;
        title.textContent = "All set!";
        text.textContent = "Orange is Player 1. Blue is Player 2.";
        fill.style.width = "100%";
        audio.play("ding");
        setTimeout(() => run === setupRun && finish(), 1400);
      })
      .catch((err: Error) => {
        off();
        if (run !== setupRun || /cancelled|restarted/i.test(err.message)) return;
        title.textContent = "I could not see two players";
        text.textContent = "Make sure both of you fit in the picture from head to waist, with some light on you, and try again.";
        fill.style.width = "0%";
        actions.replaceChildren(button("Try again", begin, "go", { "data-first": true }), button(pendingGame ? "Play anyway" : "Back", () => (pendingGame ? finish() : show("home")), "quiet"));
        focusFirst();
      });
  };
  screenEl.replaceChildren(h("div", { class: "hud" }, title, text, h("div", { class: "bar" }, fill), actions));
  begin();
}

const BONES: Array<[KeypointName, KeypointName]> = [
  ["leftShoulder", "rightShoulder"], ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"], ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"], ["leftShoulder", "leftHip"], ["rightShoulder", "rightHip"], ["leftHip", "rightHip"],
];

/** The setup picture: the camera as a mirror, with each recognised player outlined in their colour. */
function drawSetup(): void {
  const W = stage.width;
  const H = stage.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b0e1c";
  ctx.fillRect(0, 0, W, H);
  const video = tracking.video();
  if (video && video.readyState >= 2) {
    ctx.save();
    if (settings.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.setLineDash([14, 16]);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of api.players.all()) if (p.present) drawPlayer(p, W, H);
}

function drawPlayer(p: PlayerState, W: number, H: number): void {
  const color = PLAYER_COLORS[p.id] ?? "#fff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    const ka = p.skeleton?.[a];
    const kb = p.skeleton?.[b];
    if (!ka || !kb) continue;
    ctx.beginPath();
    ctx.moveTo(ka.x * W, ka.y * H);
    ctx.lineTo(kb.x * W, kb.y * H);
    ctx.stroke();
  }
  for (const hand of [p.leftHand, p.rightHand]) {
    if (!hand) continue;
    ctx.beginPath();
    ctx.arc(hand.x * W, hand.y * H, 22, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (p.bodyPosition) {
    const label = `Player ${p.id}`;
    ctx.font = "bold 34px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 36;
    const x = p.bodyPosition.x * W;
    const y = Math.max(40, p.bodyPosition.y * H - 170);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 26, w, 52, 26);
    ctx.fill();
    ctx.fillStyle = "#10131c";
    ctx.fillText(label, x, y + 2);
  }
}

// ---- Playing --------------------------------------------------------------------------------------

function quitGame(): void {
  show("home");
}

/** Show the right message over the game for its current state, replacing it only when the state changes. */
function syncPlayOverlay(): void {
  if (!playing) return;
  const { runtime, entry } = playing;
  const key = runtime.state === "ended" ? "ended" : runtime.state === "paused" ? (runtime.pauseReason ?? "") : "";
  if (key === playOverlay) return;
  playOverlay = key;
  if (!key) return hideOverlay();

  const row = (...buttons: HTMLButtonElement[]): HTMLElement => h("div", { class: "row" }, ...buttons);
  const quit = button("Choose another game", quitGame, "quiet");
  let content: HTMLElement;
  if (key === "ended") {
    const r = runtime.result!;
    const title = r.kind === "winner" ? `Player ${r.player} wins!` : r.kind === "tie" ? "It's a tie!" : r.won ? "You did it together!" : "Out of time — so close!";
    content = h(
      "div",
      { class: "dialog", role: "dialog" },
      h("h1", {}, title),
      h("div", { class: "scores" }, ...[...runtime.scores].map(([player, score]) => h("span", { class: `s${player}` }, `Player ${player}: ${Math.round(score)}`))),
      row(button("Play again", () => runtime.start(), "go", { "data-first": true }), quit),
    );
  } else if (key === "user") {
    content = h("div", { class: "dialog", role: "dialog" }, h("h1", {}, "Paused"), h("p", {}, entry.game.meta.name), row(button("Keep playing", () => runtime.resume(), "go", { "data-first": true }), button("Start again", () => runtime.start()), quit));
  } else if (key === "players") {
    const n = entry.game.requires.players.min;
    content = h("div", { class: "dialog", role: "dialog" }, h("h1", {}, "Where did you go?"), h("p", {}, `This game needs ${n} player${n === 1 ? "" : "s"} in front of the camera. It will carry on as soon as it can see you.`), row(quit));
  } else {
    content = h(
      "div",
      { class: "dialog", role: "dialog" },
      h("h1", {}, "Who is who?"),
      h("p", {}, "I lost track of which player is which. Step back to your own side — Player 1 on the left, Player 2 on the right."),
      row(button("We swapped places on purpose", () => tracking.engine.confirmIdentities(), "", { "data-first": true }), quit),
    );
  }
  showOverlay(content, key === "user" ? () => runtime.resume() : key === "ended" ? quitGame : null);
}

// ---- Installing games -----------------------------------------------------------------------------

const megabytes = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  if (file.size > PACKAGE_LIMITS.packageBytes) return void ask("That file is too big", [h("p", {}, `Playloom games are at most ${megabytes(PACKAGE_LIMITS.packageBytes)}.`)], [{ id: "ok", label: "OK", cls: "go" }], "ok");
  const result = unpackGame(new Uint8Array(await file.arrayBuffer()));
  if (!result.ok) {
    const problems = result.issues.slice(0, 4).map((i) => h("p", {}, `${i.path} ${i.message}`));
    return void ask("This is not a game Playloom can use", [h("p", {}, "The file was checked and nothing was installed."), ...problems], [{ id: "ok", label: "OK", cls: "go" }], "ok");
  }
  const { game, assets } = result.package;
  const existing = library.find((e) => e.game.meta.id === game.meta.id);
  if (existing?.source === "bundled") {
    return void ask("This game comes with Playloom", [h("p", {}, `${existing.game.meta.name} is built in and cannot be replaced.`)], [{ id: "ok", label: "OK", cls: "go" }], "ok");
  }
  const size = [...assets.values()].reduce((sum, a) => sum + a.length, 0);
  const answer = await ask(
    existing ? "Replace this game?" : "Install this game?",
    [
      h(
        "dl",
        {},
        h("dt", {}, "Game"), h("dd", {}, `${game.meta.name} ${game.meta.version}`),
        h("dt", {}, "Made by"), h("dd", {}, game.meta.author ?? "Not stated"),
        h("dt", {}, "Licence"), h("dd", {}, game.meta.license ?? "Not stated"),
        h("dt", {}, "Size"), h("dd", {}, `${megabytes(size + 1)} · ${assets.size} picture${assets.size === 1 ? "" : "s"}`),
        existing ? h("dt", {}, "Installed") : null, existing ? h("dd", {}, `version ${existing.game.meta.version}`) : null,
      ),
      h("p", {}, "Playloom games are made of pictures and rules. They cannot run programs, read your files or use the internet. Still, only install games from people you trust, as you would any game for children."),
    ],
    [{ id: "yes", label: existing ? "Replace" : "Install", cls: "go" }, { id: "no", label: "Cancel", cls: "quiet" }],
    "no",
  );
  if (answer !== "yes") return;
  try {
    await installGame(result.package);
    await refreshLibrary();
    toast(`${game.meta.name} is installed.`);
    show(screen === "settings" ? "settings" : "home");
  } catch (err) {
    void ask("The game could not be saved", [h("p", {}, (err as Error).message)], [{ id: "ok", label: "OK", cls: "go" }], "ok");
  }
});

async function refreshLibrary(): Promise<void> {
  const bundled = bundledGames();
  const ids = new Set(bundled.map((e) => e.game.meta.id));
  library = [...bundled, ...(await installedGames()).filter((e) => !ids.has(e.game.meta.id))];
}

function download(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([typeof data === "string" ? data : data.slice().buffer], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- Settings -------------------------------------------------------------------------------------

async function restartTracking(): Promise<void> {
  calibrated = false;
  const starting = tracking.start();
  if (screen === "home") renderHome();
  await starting;
  if (screen === "home") {
    renderHome();
    focusFirst();
  }
  if (screen === "settings") renderSettings();
}

function setMode(mode: TrackingMode): void {
  settings.backend = mode;
  persist();
  void restartTracking();
}

function describeCheck(check: StoredCheck | null): string {
  if (!check) return "This device has not been checked yet. The check takes about 20 seconds and works best with two people in front of the camera.";
  const r = check.recommendation;
  const names = { enhanced: "Enhanced — smooth full body tracking", standard: "Standard — full body tracking", lite: "Lite — movement only; games that need jumps or leans will not work", unsupported: "Not supported — no working camera tracking was found" };
  const lines = check.report.backends.map((b) => `  ${MODE_LABELS[b.backend as TrackingMode] ?? b.backend}: ${b.error ? `could not start (${b.error})` : `${b.trackingHz.toFixed(0)} updates a second, ${b.latencyMs.toFixed(0)} ms delay`}`);
  return `Result: ${names[r.profile]}\nPlayers supported: ${r.supportedPlayers}\nChecked ${new Date(check.report.createdAt).toLocaleDateString()}\n${lines.join("\n")}`;
}

let cameraList: Array<{ deviceId: string; label: string }> = [];
let checking = false;

function renderSettings(): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
  const option = (key: string, label: string, hint: string, value: string, onclick: () => void): HTMLButtonElement =>
    button(h("span", { style: "display:contents" }, h("span", {}, label, h("small", {}, hint)), h("span", { class: "value" }, value)), onclick, "option", { "data-key": key });
  const cycle = <T,>(list: T[], current: T): T => list[(list.indexOf(current) + 1) % list.length]!;

  const sensitivities: Array<[number, string]> = [[0.7, "Low"], [1, "Normal"], [1.4, "High"], [1.8, "Very high"]];
  const volumes: Array<[number, string]> = [[0, "Off"], [0.35, "Quiet"], [0.8, "Normal"], [1, "Loud"]];
  const nearest = (list: Array<[number, string]>, v: number): [number, string] => list.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a));
  const sens = nearest(sensitivities, settings.sensitivity);
  const vol = nearest(volumes, prefs.volume);
  const camera = cameraList.find((c) => c.deviceId === settings.cameraId);
  const modes = Object.keys(MODE_LABELS) as TrackingMode[];
  const report = h("div", { class: "note", id: "check-note" }, describeCheck(loadCheck()));

  screenEl.replaceChildren(
    h("div", { class: "top" }, button("‹ Back", () => show("home"), "quiet", { "data-first": true, "data-key": "back" }), h("div", { class: "brand" }, "Settings")),
    h(
      "div",
      { class: "settings" },
      h("h2", {}, "Camera and tracking"),
      option("mode", "Tracking", `Now using: ${tracking.state === "running" ? (MODE_LABELS[tracking.active === "simulator" ? "practice" : (tracking.active as TrackingMode)] ?? tracking.active) : tracking.state === "starting" ? "starting…" : "nothing — " + (tracking.error?.message ?? "not started")}`, MODE_LABELS[tracking.mode], () => setMode(cycle(modes, tracking.mode))),
      option("camera", "Camera", cameraList.length > 1 ? `${cameraList.length} cameras found` : "Choose which camera to use", camera?.label ?? "Default", () => {
        const ids = [undefined, ...cameraList.map((c) => c.deviceId)];
        settings.cameraId = cycle(ids, settings.cameraId && ids.includes(settings.cameraId) ? settings.cameraId : undefined);
        persist();
        void restartTracking();
      }),
      option("mirror", "Mirror picture", "On: the screen works like a mirror, which most people find natural", settings.mirror ? "On" : "Off", () => {
        tracking.apply({ mirror: !settings.mirror });
        calibrated = false;
        persist();
        renderSettings();
      }),
      option("sens", "Gesture sensitivity", "Higher makes jumps, ducks and swipes easier — useful for small children", sens[1], () => {
        tracking.apply({ sensitivity: cycle(sensitivities, sens)[0] });
        persist();
        renderSettings();
      }),
      option("check", "Check this device", "Measures how well this computer and camera can track two players", checking ? "Checking…" : "Start", () => void runCheck()),
      report,
      loadCheck() ? button("Save the report as a file", () => download("playloom-compatibility.json", JSON.stringify(loadCheck(), null, 2), "application/json"), "quiet", { "data-key": "save-report" }) : null,

      h("h2", {}, "Sound and screen"),
      option("volume", "Sound", "Game sound effects", vol[1], () => {
        prefs.volume = audio.volume = cycle(volumes, vol)[0];
        savePrefs();
        audio.play("pop");
        renderSettings();
      }),
      option("fullscreen", "Full screen", "Hide everything except Playloom", document.fullscreenElement ? "On" : "Off", () => {
        const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
        void change.catch(() => toast("Full screen is not available here.")).then(() => renderSettings());
      }),

      h("h2", {}, "Games"),
      button("Add a game from a .playloom file", () => fileInput.click(), "", { "data-key": "add" }),
      ...library.map((entry) =>
        h(
          "div",
          { class: "game-row" },
          h("span", {}, entry.game.meta.name, " ", h("small", {}, `${entry.game.meta.version} · ${entry.source === "bundled" ? "comes with Playloom" : megabytes(entry.bytes + 1)}`)),
          button("Save a copy", async () => download(packageFileName(entry.game), await exportGame(entry), "application/zip"), "quiet", { "data-key": `export-${entry.game.meta.id}` }),
          entry.source === "installed"
            ? button("Remove", async () => {
                const answer = await ask(`Remove ${entry.game.meta.name}?`, [h("p", {}, "The game will be deleted from this device.")], [{ id: "no", label: "Keep it", cls: "go" }, { id: "yes", label: "Remove" }], "no");
                if (answer !== "yes") return;
                await removeGame(entry.game.meta.id);
                await refreshLibrary();
                renderSettings();
                focusFirst();
              }, "quiet", { "data-key": `remove-${entry.game.meta.id}` })
            : null,
        ),
      ),

      // The desktop application runs full screen with no window frame, so it needs its own way out.
      /Electron/.test(navigator.userAgent) ? button("Close Playloom", () => window.close(), "", { "data-key": "close" }) : null,

      h("h2", {}, "About"),
      h("div", { class: "note" }, "Playloom is free, open-source software (GNU GPL version 3 or later).\nThe camera picture is analysed on this device and never stored or sent anywhere. Playloom makes no network connections.\nPose tracking uses MediaPipe (Apache License 2.0)."),
    ),
  );
  const again = focused && screenEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`);
  if (again) again.focus();
  else focusFirst();
}

async function runCheck(): Promise<void> {
  if (checking) return;
  if (tracking.error?.camera) return void toast("No camera was found, so there is nothing to check yet.");
  checking = true;
  calibrated = false;
  renderSettings();
  try {
    await tracking.check((message) => {
      const note = document.getElementById("check-note");
      if (note) note.textContent = `${message}\nStand in front of the camera — two people if you can.`;
    });
  } finally {
    checking = false;
    if (screen === "settings") renderSettings();
  }
}

// ---- Main loop ------------------------------------------------------------------------------------

const renderRate = new RateMeter(2000);
tracking.renderFps = () => renderRate.rate();
let last = 0;
let lastChips = 0;

function frame(now: number): void {
  renderRate.tick(now);
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  if (screen === "play" && playing) {
    playing.runtime.update(dt);
    renderToCanvas(ctx, playing.runtime, { video: tracking.video(), mirror: settings.mirror, images: playing.images });
    syncPlayOverlay();
  } else if (screen === "setup") {
    drawSetup();
  } else if (now - lastChips > 300) {
    lastChips = now;
    updateChips();
  }
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  startNavigation();
  await refreshLibrary();
  show("home");
  requestAnimationFrame(frame);
  await tracking.start();
  cameraList = await tracking.cameras().catch(() => []);
  if (screen === "home") {
    renderHome();
    focusFirst();
  }
  // First run with a working camera: offer to measure the device once.
  if (tracking.state === "running" && !tracking.practice && !loadCheck() && !prefs.welcomed) {
    prefs.welcomed = true;
    savePrefs();
    const answer = await ask(
      "Welcome to Playloom!",
      [h("p", {}, "Before the first game, Playloom can check how well this computer and camera work together. It takes about 20 seconds, and it helps to have two people standing in front of the camera.")],
      [{ id: "yes", label: "Check now", cls: "go" }, { id: "no", label: "Later", cls: "quiet" }],
      "no",
    );
    if (answer === "yes") {
      show("settings");
      await runCheck();
    }
  }
}

// Exposed for automated browser tests.
(window as unknown as { playloom: unknown }).playloom = { tracking, api, getRuntime: () => playing?.runtime ?? null, getScreen: () => screen, getLibrary: () => library };

void boot();
