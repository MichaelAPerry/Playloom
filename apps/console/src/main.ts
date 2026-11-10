import { loadSettings, PlayerJoin, RateMeter, saveSettings, type KeypointName, type PlayerState } from "@playloom/core";
import { GameRuntime, PLAYER_COLORS, renderToCanvas, WebAudioPlayer } from "@playloom/runtime";
import { PACKAGE_LIMITS, packageFileName, unpackGame, type GameDefinition } from "@playloom/sdk";
import { bundledGames, exportGame, installedGames, installGame, loadImages, removeGame, type LibraryEntry } from "./library";
import { focusables, focusFirst, setNavigation, startNavigation } from "./nav";
import { clearTrial, loadCheck, loadTrial, MODE_LABELS, Tracking, type StoredCheck, type TrackingMode } from "./tracking";
import { button, h, icon, logo, type Child, type IconName } from "./ui";

const stage = document.getElementById("stage") as HTMLCanvasElement;
const ctx = stage.getContext("2d")!;
const screenEl = document.getElementById("screen")!;
const overlayEl = document.getElementById("overlay")!;
const fileInput = document.getElementById("package-file") as HTMLInputElement;

// ---- App state ------------------------------------------------------------------------------------

type Backdrop = "off" | "faint" | "strong";
interface Prefs {
  volume: number;
  welcomed: boolean;
  /**
   * How much of the camera picture shows behind a game. Off by default: the hand cursors are large and
   * clear on their own, a picture of yourself behind the targets competes with them, and it costs the
   * computer extra work on every frame.
   */
  backdrop: Backdrop;
}
const PREFS_KEY = "playloom.console";
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      volume: typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : 0.8,
      welcomed: p.welcomed === true,
      backdrop: p.backdrop === "faint" || p.backdrop === "strong" ? p.backdrop : "off",
    };
  } catch {
    return { volume: 0.8, welcomed: false, backdrop: "off" };
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

// ---- Dialogs ----------------------------------------------------------------------------------------
// Nothing in the Console disappears by itself. Anything that needs to be said is either written into the
// screen where it matters, or shown in a dialog that stays until someone presses a button.

interface DialogButton {
  id: string;
  label: string;
  cls?: string;
  icon?: IconName;
}
let dialogCancel: (() => void) | null = null;
let returnFocus: HTMLElement | null = null;

function showOverlay(content: HTMLElement, cancel: (() => void) | null): void {
  if (overlayEl.hidden) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayEl.replaceChildren(content);
  overlayEl.hidden = false;
  // Nothing behind a dialog can be reached with Tab, a remote or the pointer.
  (screenEl as HTMLElement & { inert: boolean }).inert = true;
  dialogCancel = cancel;
  focusFirst();
}
function hideOverlay(): void {
  overlayEl.hidden = true;
  overlayEl.replaceChildren();
  (screenEl as HTMLElement & { inert: boolean }).inert = false;
  dialogCancel = null;
  const back = returnFocus;
  returnFocus = null;
  if (back?.isConnected && focusables().includes(back)) back.focus();
  else focusFirst();
}

/** Ask a question. Resolves with the id of the chosen button; going back chooses `cancel`. */
function ask(title: string, body: Child[], buttons: DialogButton[], cancel: string): Promise<string> {
  return new Promise((resolve) => {
    const done = (id: string): void => {
      hideOverlay();
      resolve(id);
    };
    showOverlay(
      h(
        "div",
        { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h1", {}, title),
        h("div", { class: "body" }, ...body),
        h("div", { class: "row" }, ...buttons.map((b, i) => button([b.icon ? icon(b.icon) : null, b.label], () => done(b.id), b.cls ?? "", { "data-first": i === 0 }))),
      ),
      () => done(cancel),
    );
  });
}

/** Say something and wait for OK. */
const tell = (title: string, body: Child[] | string): Promise<string> =>
  ask(title, typeof body === "string" ? [h("p", {}, body)] : body, [{ id: "ok", label: "OK", cls: "go" }], "ok");

/** Pick one of several. Resolves with the chosen id, or null if the person goes back. */
function choose(title: string, items: Array<{ id: string; label: string; hint?: string }>, current: string, hint?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (id: string | null): void => {
      hideOverlay();
      resolve(id);
    };
    showOverlay(
      h(
        "div",
        { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h1", {}, title),
        h(
          "div",
          { class: "body" },
          hint ? h("p", {}, hint) : null,
          h(
            "div",
            { class: "choices", role: "radiogroup" },
            ...items.map((item) =>
              button(
                [item.id === current ? icon("check") : h("span", { class: "tick" }), h("span", {}, item.label, item.hint ? h("small", {}, item.hint) : null)],
                () => done(item.id),
                "",
                { role: "radio", "aria-checked": String(item.id === current), "data-first": item.id === current },
              ),
            ),
          ),
        ),
        h("div", { class: "row" }, button([icon("back"), "Back"], () => done(null), "quiet")),
      ),
      () => done(null),
    );
  });
}

/** A progress dialog for a job the computer is doing. It closes itself when the job is finished. */
function showProgress(title: string): { set(step: string, fraction: number, note?: string): void; close(): void } {
  const stepEl = h("p", { class: "step" });
  const fill = h("i");
  const noteEl = h("p", {});
  showOverlay(
    h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h1", {}, title), h("div", { class: "body" }, stepEl, h("div", { class: "meter" }, fill), noteEl)),
    null,
  );
  return {
    set(step, fraction, note = "") {
      stepEl.textContent = step;
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      noteEl.textContent = note;
    },
    close: hideOverlay,
  };
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
  screenEl.scrollTop = 0;
  if (next === "home") renderHome();
  else if (next === "settings") renderSettings();
  else if (next === "setup") renderSetup();
  else {
    screenEl.replaceChildren(
      h(
        "div",
        { class: "playbar" },
        h("span", { class: "hint" }, "Esc or B to pause"),
        button([icon("pause"), "Pause"], togglePause, "", { "data-key": "pause" }),
      ),
    );
    // No focus ring over the game until someone asks for one with an arrow key.
    return;
  }
  focusFirst();
}

// ---- Shared pieces --------------------------------------------------------------------------------

function statusChips(): HTMLElement {
  return h(
    "div",
    { class: "chips" },
    h("span", { class: "chip js-mode" }),
    h("span", { class: "chip p1 js-p1" }, h("i"), "Player 1"),
    h("span", { class: "chip p2 js-p2" }, h("i"), "Player 2"),
  );
}

/** The header every screen has: a way back (or the name, on the home screen), a title, and who the camera sees. */
function header(title: string | null, options: { back?: boolean; over?: boolean } = {}): HTMLElement {
  return h(
    "header",
    { class: `bar${options.over ? " over" : ""}` },
    options.back ? button([icon("back"), "Back"], () => show("home"), "quiet", { "data-key": "back", "aria-label": "Back to the games" }) : null,
    title ? h("h1", {}, title) : h("div", { class: "brand" }, logo(), h("b", {}, "Play", h("span", {}, "loom"))),
    !title ? h("div", { class: "tagline" }, "Play together. Create anything.") : null,
    h("div", { class: "spacer" }),
    statusChips(),
  );
}

const legend = (): HTMLElement =>
  h(
    "div",
    { class: "legend" },
    h("span", {}, h("kbd", {}, "Arrows"), "or D-pad to move"),
    h("span", {}, h("kbd", {}, "Enter"), "or A to choose"),
    h("span", {}, h("kbd", {}, "Esc"), "or B to go back"),
    h("span", {}, "Mouse works too"),
  );

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
  art.append(h("span", { class: "go-badge" }, icon("play")));
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
    { "data-first": index === 0, "aria-label": `Play ${game.meta.name}` },
  );
}

function smallTile(glyph: IconName, label: string, hint: string, onclick: () => void, key: string): HTMLButtonElement {
  return button(h("span", { style: "display:contents" }, h("span", { class: "glyph" }, icon(glyph)), h("span", { class: "label" }, label, h("small", {}, hint))), onclick, "tile small", { "data-key": key });
}

let statusSig = "";

function renderHome(): void {
  statusSig = "";
  screenEl.replaceChildren(
    header(null),
    h(
      "main",
      { class: "page" },
      h("div", { id: "status" }),
      h("h2", {}, "Games"),
      h("div", { class: "tiles" }, ...library.map(gameTile)),
      h("h2", {}, "More"),
      h(
        "div",
        { class: "tiles" },
        smallTile("players", "Player setup", "Get ready to play together", () => openSetup(null), "setup"),
        smallTile("plus", "Add a game", "Open a .playloom file", () => fileInput.click(), "add"),
        smallTile("sliders", "Settings", "For grown-ups", () => show("settings"), "settings"),
        /Electron/.test(navigator.userAgent) ? smallTile("power", "Close Playloom", "Quit the app", () => window.close(), "close") : null,
      ),
      h("p", { class: "privacy" }, "Your camera picture stays on this device. Playloom has no accounts, no adverts and no internet connection."),
    ),
    legend(),
  );
  updateChips();
}

/** Keep the camera chips, and the status card at the top of Home, in step with what the engine is doing. */
function updateChips(): void {
  for (const id of [1, 2]) screenEl.querySelector(`.js-p${id}`)?.classList.toggle("on", !!api.players.get(id)?.present);
  const chip = screenEl.querySelector(".js-mode");
  if (chip) {
    const text =
      tracking.state === "starting" ? "Starting camera…" : tracking.state === "tuning" ? "Getting ready…" : tracking.state === "error" ? "No camera" : tracking.practice ? "Practice mode" : api.status.capabilities?.skeleton ? "Camera on" : "Camera on · Lite";
    if (chip.textContent !== text) chip.replaceChildren(icon("camera"), text);
  }
  if (screen === "home") syncStatus();
}

function syncStatus(): void {
  const box = document.getElementById("status");
  if (!box) return;
  const sig = `${tracking.state}|${tracking.error?.message ?? ""}|${tracking.trialProgress?.step ?? 0}`;
  if (sig !== statusSig) {
    statusSig = sig;
    let content: HTMLElement | null = null;
    if (tracking.state === "error") {
      content = h(
        "div",
        { class: "status problem", role: "alert" },
        h(
          "div",
          { class: "text" },
          h("strong", {}, tracking.error?.camera ? "Playloom cannot see a camera" : "Playloom could not start"),
          h("p", {}, tracking.error?.camera ? "Check that the camera is plugged in and that no other program is using it. No camera? You can still try the games with the keyboard." : `Something went wrong: ${tracking.error?.message ?? "unknown problem"}`),
        ),
        h("div", { class: "row" }, button([icon("refresh"), "Try the camera again"], () => void restartTracking(), "go", { "data-key": "retry" }), button("Practise without a camera", () => setMode("practice"), "", { "data-key": "practice" })),
      );
    } else if (tracking.state === "tuning") {
      content = h(
        "div",
        { class: "status", role: "status" },
        h("strong", {}, "Getting your camera ready"),
        h("p", { id: "tuning-step" }),
        h("div", { class: "meter" }, h("i", { id: "tuning-fill" })),
        h("p", {}, "This only happens once. The games are ready as soon as it finishes."),
      );
    } else if (tracking.state === "starting" || tracking.state === "idle") {
      content = h("div", { class: "status", role: "status" }, h("strong", {}, "Starting the camera…"), h("div", { class: "meter busy" }, h("i")));
    }
    const hadFocus = box.contains(document.activeElement);
    box.replaceChildren(...(content ? [content] : []));
    if (hadFocus || document.activeElement === document.body || !document.activeElement) focusFirst();
  }
  if (tracking.state === "tuning") {
    const t = tracking.trialProgress;
    const step = document.getElementById("tuning-step");
    if (step && t) step.textContent = `Test ${t.step} of ${t.of}: ${t.label}`;
    const fill = document.getElementById("tuning-fill");
    if (fill) fill.style.width = `${Math.round(tracking.trialFraction() * 100)}%`;
  }
}

async function chooseGame(entry: LibraryEntry): Promise<void> {
  if (tracking.state !== "running") {
    const answer = await ask(
      "The camera is not ready yet",
      [h("p", {}, tracking.state === "tuning" ? "Playloom is still getting the camera ready. Watch the progress on the home screen, then pick a game." : tracking.state === "starting" ? "The camera is starting up. Try again in a moment." : "Playloom cannot see anyone yet. You can try the camera again, or play with the keyboard instead.")],
      tracking.state === "tuning" || tracking.state === "starting"
        ? [{ id: "no", label: "OK", cls: "go" }]
        : [{ id: "retry", label: "Try the camera again", cls: "go", icon: "refresh" }, { id: "practice", label: "Practise without a camera" }, { id: "no", label: "Back", cls: "quiet", icon: "back" }],
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
      [h("p", {}, `${entry.game.meta.name} needs full body tracking, but this computer is only following movement. Jumps, ducks and leans will not be noticed.`)],
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
    void tell(
      "Player setup is not needed",
      tracking.practice ? "In practice mode the players are pretend, so there is nobody to set up." : tracking.state !== "running" ? "The camera is not running yet." : "This computer tells players apart by side. Player 1 stands on the left, Player 2 on the right.",
    ).then(() => then && tracking.state === "running" && launch(then));
    return;
  }
  pendingGame = then;
  show("setup");
}

/** The join monitor for the setup screen that is open, read by the picture. */
let setupJoin: PlayerJoin | null = null;

function renderSetup(): void {
  const run = ++setupRun;
  const join = new PlayerJoin(api);
  setupJoin = join;
  const lead = h("p", { class: "lead" });
  const notice = h("p", { class: "notice", role: "status" });
  const cardEls = [1, 2].map((n) => h("div", { class: `pcard p${n}` }));
  const actions = h("div", { class: "row" });
  const finish = (): void => {
    const next = pendingGame;
    pendingGame = null;
    if (next) launch(next);
    else show("home");
  };
  const start = (): void => {
    if (run !== setupRun) return;
    try {
      tracking.engine.calibrateNow({ ids: join.joinedIds });
    } catch {
      notice.textContent = "I lost sight of someone. Raise a hand again to rejoin.";
      return;
    }
    calibrated = true;
    off();
    finish();
  };
  let signature = "";
  const refresh = (): void => {
    if (run !== setupRun) return;
    const sig = JSON.stringify(join.slots);
    if (sig === signature) return;
    signature = sig;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
    const count = join.joinedCount;
    join.slots.forEach((s, i) => {
      const n = (i + 1) as 1 | 2;
      const side = i === 0 ? "left" : "right";
      cardEls[i]!.classList.toggle("in", s.joined);
      cardEls[i]!.replaceChildren(
        h(
          "div",
          { class: "info" },
          h("div", { class: "who" }, h("i"), `Player ${n}`),
          h("div", { class: "state" }, s.joined ? "You are in!" : s.detected ? "I can see you. Raise a hand to join." : `Step into the ${side} half.`),
        ),
        s.joined
          ? h("div", { class: "ready" }, icon("check"), "Ready")
          : button(`Join as Player ${n}`, () => {
              if (join.confirm(n)) {
                notice.textContent = "";
                refresh();
              } else notice.textContent = `I cannot see anyone in the ${side} half yet. Step into the picture first.`;
            }, "quiet", { "data-key": `join${n}`, "data-first": n === 1 }),
      );
    });
    lead.textContent =
      count === 2
        ? "You are both in! Press Start, or both raise both hands."
        : count === 1
          ? "One player is in. Waiting for the other to raise a hand, or start with just one."
          : "Stand on your own side of the picture, then raise a hand to join.";
    const buttons: Node[] = [];
    if (pendingGame) buttons.push(button("Skip setup", finish, "quiet", { "data-key": "skip" }));
    if (count === 2) buttons.push(button([icon("play"), "Start"], start, "go big", { "data-key": "start", "data-first": true }));
    else if (count === 1) buttons.push(button([icon("play"), "Start with one player"], start, "go", { "data-key": "start" }));
    actions.replaceChildren(...buttons);
    actions.hidden = buttons.length === 0;
    const again = focused && screenEl.querySelector<HTMLElement>(`[data-key="${focused}"]`);
    if (again) again.focus();
    else focusFirst();
  };
  join.on((e) => {
    if (run !== setupRun) return;
    if (e.type === "joined") {
      notice.textContent = "";
      audio.play("ding");
    }
    if (e.type === "start") start();
  });
  const off = api.events.on("frame", () => {
    if (run !== setupRun) return off();
    join.update();
    refresh();
  });
  signature = "";
  join.update();
  screenEl.replaceChildren(
    header("Player setup", { back: true, over: true }),
    h("div", { class: "panel" }, h("h2", {}, "Who is playing?"), lead, h("div", { class: "cards" }, ...cardEls), notice, actions),
  );
  refresh();
  updateChips();
}

const BONES: Array<[KeypointName, KeypointName]> = [
  ["leftShoulder", "rightShoulder"], ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"], ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"], ["leftShoulder", "leftHip"], ["rightShoulder", "rightHip"], ["leftHip", "rightHip"],
];

/** Keep the drawing surface the size of the window, so the picture is never stretched. */
function fitStage(): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = window.innerWidth;
  const ch = window.innerHeight;
  // Never ask a modest computer to paint a 4K canvas every frame: cap at about full-HD worth of pixels.
  const scale = Math.min(dpr, Math.sqrt(2_100_000 / Math.max(1, cw * ch)));
  const w = Math.max(320, Math.round(cw * scale));
  const hh = Math.max(180, Math.round(ch * scale));
  if (stage.width !== w) stage.width = w;
  if (stage.height !== hh) stage.height = hh;
}

/** The setup picture: the camera as a mirror, with each recognised player outlined in their colour. */
function drawSetup(): void {
  const W = stage.width;
  const H = stage.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b0e1c";
  ctx.fillRect(0, 0, W, H);
  // The camera picture keeps its own proportions and sits in the middle; everything below is drawn in
  // the same rectangle so outlines land exactly on the people.
  const video = tracking.video();
  const aspect = video && video.videoWidth > 0 ? video.videoWidth / video.videoHeight : 4 / 3;
  let vw = Math.min(W, H * aspect);
  let vh = vw / aspect;
  if (vh > H) {
    vh = H;
    vw = vh * aspect;
  }
  const vx = (W - vw) / 2;
  const vy = (H - vh) / 2;
  const u = vh / 720;
  if (video && video.readyState >= 2) {
    ctx.save();
    if (settings.mirror) {
      ctx.translate(vx + vw, vy);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, vw, vh);
    } else ctx.drawImage(video, vx, vy, vw, vh);
    ctx.restore();
  }
  // Two big slots: Player 1 on the left half, Player 2 on the right.
  const slots = setupJoin?.slots;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [1, 2].forEach((n, i) => {
    const color = PLAYER_COLORS[n] ?? "#fff";
    const joined = !!slots?.[i]?.joined;
    ctx.globalAlpha = joined ? 0.3 : 0.12;
    ctx.fillStyle = color;
    ctx.fillRect(vx + (i * vw) / 2, vy, vw / 2, vh);
    ctx.globalAlpha = joined ? 0.9 : 0.5;
    ctx.font = `800 ${220 * u}px system-ui, "Segoe UI", sans-serif`;
    ctx.lineWidth = 10 * u;
    ctx.strokeStyle = "rgba(8,10,28,0.7)";
    const cx = vx + ((i + 0.5) * vw) / 2;
    const cy = vy + vh * 0.38;
    const mark = joined ? "✓" : String(n);
    ctx.strokeText(mark, cx, cy);
    ctx.fillStyle = color;
    ctx.fillText(mark, cx, cy);
    ctx.globalAlpha = 1;
  });
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.setLineDash([14 * u, 16 * u]);
  ctx.lineWidth = 3 * u;
  ctx.beginPath();
  ctx.moveTo(vx + vw / 2, vy);
  ctx.lineTo(vx + vw / 2, vy + vh);
  ctx.stroke();
  ctx.setLineDash([]);
  // Before anyone has joined, outline people by the half they stand in rather than by a provisional number.
  for (const p of api.players.all()) if (p.present) drawPlayer(p, vx, vy, vw, vh, u, (p.bodyPosition?.x ?? 0) < 0.5 ? 1 : 2);
}

function drawPlayer(p: PlayerState, vx: number, vy: number, vw: number, vh: number, u: number, id: number = p.id): void {
  const color = PLAYER_COLORS[id] ?? "#fff";
  const X = (x: number): number => vx + x * vw;
  const Y = (y: number): number => vy + y * vh;
  ctx.lineCap = "round";
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? "rgba(8,10,28,0.8)" : color;
    ctx.lineWidth = (pass === 0 ? 14 : 8) * u;
    for (const [a, b] of BONES) {
      const ka = p.skeleton?.[a];
      const kb = p.skeleton?.[b];
      if (!ka || !kb) continue;
      ctx.beginPath();
      ctx.moveTo(X(ka.x), Y(ka.y));
      ctx.lineTo(X(kb.x), Y(kb.y));
      ctx.stroke();
    }
  }
  for (const hand of [p.leftHand, p.rightHand]) {
    if (!hand) continue;
    ctx.beginPath();
    ctx.arc(X(hand.x), Y(hand.y), 24 * u, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 5 * u;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  if (p.bodyPosition) {
    const label = `Player ${id}`;
    ctx.font = `800 ${34 * u}px system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 36 * u;
    const x = X(p.bodyPosition.x);
    const y = Math.max(vy + 80 * u, Y(p.bodyPosition.y) - 170 * u);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 26 * u, w, 52 * u, 26 * u);
    ctx.fill();
    ctx.fillStyle = "#10131c";
    ctx.fillText(label, x, y + 2 * u);
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
  const quit = (): HTMLButtonElement => button([icon("home"), "Choose another game"], quitGame, "quiet", { "data-key": "quit" });
  const dialog = (...children: Child[]): HTMLElement => h("div", { class: "dialog", role: "dialog", "aria-modal": "true" }, ...children);
  let content: HTMLElement;
  if (key === "ended") {
    const r = runtime.result!;
    const title = r.kind === "winner" ? `Player ${r.player} wins!` : r.kind === "tie" ? "It's a tie!" : r.won ? "You did it together!" : "Out of time. So close!";
    content = dialog(
      h("h1", {}, title),
      h("div", { class: "scores" }, ...[...runtime.scores].map(([player, score]) => h("div", { class: `score s${player}` }, h("small", {}, `Player ${player}`), h("b", {}, String(Math.round(score)))))),
      row(button([icon("refresh"), "Play again"], () => runtime.start(), "go big", { "data-first": true, "data-key": "again" }), quit()),
    );
  } else if (key === "user") {
    content = dialog(
      h("h1", {}, "Paused"),
      h("div", { class: "body" }, h("p", {}, entry.game.meta.name)),
      row(button([icon("play"), "Keep playing"], () => runtime.resume(), "go big", { "data-first": true, "data-key": "resume" }), button([icon("refresh"), "Start again"], () => runtime.start(), "", { "data-key": "restart" }), quit()),
    );
  } else if (key === "players") {
    const n = entry.game.requires.players.min;
    content = dialog(h("h1", {}, "Where did everyone go?"), h("div", { class: "body" }, h("p", {}, `This game needs ${n} player${n === 1 ? "" : "s"} in front of the camera. It carries on as soon as it can see ${n === 1 ? "you" : "everyone"} again.`)), row(quit()));
  } else {
    content = dialog(
      h("h1", {}, "Who is who?"),
      h("div", { class: "body" }, h("p", {}, "I lost track of which player is which. Step back to your own side: Player 1 on the left, Player 2 on the right.")),
      row(button("We swapped on purpose", () => tracking.engine.confirmIdentities(), "", { "data-first": true, "data-key": "swapped" }), quit()),
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
  if (file.size > PACKAGE_LIMITS.packageBytes) return void tell("That file is too big", `Playloom games can be at most ${megabytes(PACKAGE_LIMITS.packageBytes)}.`);
  const result = unpackGame(new Uint8Array(await file.arrayBuffer()));
  if (!result.ok) {
    const problems = result.issues.slice(0, 3).map((i) => h("p", { class: "note" }, `${i.path} ${i.message}`));
    return void tell("That is not a game Playloom can use", [h("p", {}, "Playloom looked inside the file and did not add anything."), ...problems]);
  }
  const { game, assets } = result.package;
  const existing = library.find((e) => e.game.meta.id === game.meta.id);
  if (existing?.source === "bundled") return void tell("This game comes with Playloom", `${existing.game.meta.name} is built in, so it cannot be replaced.`);
  const size = [...assets.values()].reduce((sum, a) => sum + a.length, 0);
  const answer = await ask(
    existing ? "Replace this game?" : "Add this game?",
    [
      h(
        "dl",
        {},
        h("dt", {}, "Game"), h("dd", {}, `${game.meta.name} ${game.meta.version}`),
        h("dt", {}, "Made by"), h("dd", {}, game.meta.author ?? "Not stated"),
        h("dt", {}, "Licence"), h("dd", {}, game.meta.license ?? "Not stated"),
        h("dt", {}, "Size"), h("dd", {}, `${megabytes(size + 1)} · ${assets.size} picture${assets.size === 1 ? "" : "s"}`),
        existing ? h("dt", {}, "Now installed") : null, existing ? h("dd", {}, `version ${existing.game.meta.version}`) : null,
      ),
      h("p", {}, "Playloom games are made of pictures and rules. They cannot run programs, read your files or use the internet. Still, only add games from people you trust, as you would any game for children."),
    ],
    [{ id: "yes", label: existing ? "Replace it" : "Add it", cls: "go" }, { id: "no", label: "Cancel", cls: "quiet" }],
    "no",
  );
  if (answer !== "yes") return;
  try {
    await installGame(result.package);
    await refreshLibrary();
    if (screen === "home") renderHome();
    if (screen === "settings") renderSettings();
    await tell("Game added", `${game.meta.name} is ready to play.`);
  } catch (err) {
    void tell("The game could not be saved", (err as Error).message);
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

const PROFILE_NAMES = {
  enhanced: "Enhanced: smooth full body tracking",
  standard: "Standard: full body tracking",
  lite: "Lite: follows movement only, so games that need jumps or leans will not work",
  unsupported: "Not supported: no working camera tracking was found",
} as const;

function describeCheck(check: StoredCheck | null): string {
  if (!check) return "This computer has not been checked yet. The check runs three short tests, one after another. Two people standing in front of the camera gives the best result.";
  const r = check.recommendation;
  return `Result: ${PROFILE_NAMES[r.profile]}.\nPlayers it can follow: ${r.supportedPlayers}.\nChecked on ${new Date(check.report.createdAt).toLocaleDateString()}. The saved report has all the details.`;
}

let cameraList: Array<{ deviceId: string; label: string }> = [];
let checking = false;

function nowUsing(): string {
  if (tracking.state === "tuning") return "Getting ready…";
  if (tracking.state === "starting") return "Starting…";
  if (tracking.state !== "running") return `Not running. ${tracking.error?.message ?? ""}`.trim();
  const name = MODE_LABELS[tracking.active === "simulator" ? "practice" : (tracking.active as TrackingMode)] ?? tracking.active;
  const hz = api.status.trackingHz;
  return `Now using: ${name}${tracking.practice ? "" : ` · ${hz > 0 ? `${hz.toFixed(0)} updates a second` : "measuring…"}`}`;
}

function renderSettings(): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
  const scrolled = screenEl.scrollTop;
  const sensitivities: Array<[number, string]> = [[0.7, "Low"], [1, "Normal"], [1.4, "High"], [1.8, "Very high"]];
  const volumes: Array<[number, string]> = [[0, "Off"], [0.35, "Quiet"], [0.8, "Normal"], [1, "Loud"]];
  const nearest = (list: Array<[number, string]>, v: number): number => list.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a))[0];
  const camera = cameraList.find((c) => c.deviceId === settings.cameraId);
  const modes = Object.keys(MODE_LABELS) as TrackingMode[];

  /** A row with a name, a plain-words hint, and something to press on the right. */
  const row = (label: string, hint: string, control: Node, key?: string): HTMLElement =>
    h("div", { class: "setting", "data-row": key }, h("div", { class: "label" }, label, h("small", { class: "hint-text" }, hint)), h("div", { class: "control" }, control));
  /** A short list of choices where the one in use is filled in and ticked. */
  const seg = <T,>(key: string, label: string, options: Array<[T, string]>, current: T, pick: (value: T) => void): HTMLElement =>
    h(
      "div",
      { class: "seg", role: "radiogroup", "aria-label": label },
      ...options.map(([value, text], i) =>
        button([value === current ? icon("check") : null, text], () => pick(value), "", { role: "radio", "aria-checked": String(value === current), "data-key": `${key}-${i}` }),
      ),
    );
  const onOff = (key: string, label: string, current: boolean, pick: (value: boolean) => void): HTMLElement =>
    seg<boolean>(key, label, [[true, "On"], [false, "Off"]], current, pick);

  const report = h("div", { class: "note", id: "check-note" }, describeCheck(loadCheck()));
  const gameRows = library.map((entry) =>
    h(
      "div",
      { class: "game-row" },
      h("div", { class: "label" }, entry.game.meta.name, h("small", {}, `Version ${entry.game.meta.version} · ${entry.source === "bundled" ? "comes with Playloom" : megabytes(entry.bytes + 1)}`)),
      button([icon("download"), "Save a copy"], async () => download(packageFileName(entry.game), await exportGame(entry), "application/zip"), "quiet", { "data-key": `export-${entry.game.meta.id}` }),
      entry.source === "installed"
        ? button([icon("trash"), "Remove"], async () => {
            const answer = await ask(`Remove ${entry.game.meta.name}?`, [h("p", {}, "The game will be deleted from this computer. You can add it again from its file.")], [{ id: "no", label: "Keep it", cls: "go" }, { id: "yes", label: "Remove it", cls: "danger" }], "no");
            if (answer !== "yes") return;
            await removeGame(entry.game.meta.id);
            await refreshLibrary();
            renderSettings();
            focusFirst();
          }, "quiet danger", { "data-key": `remove-${entry.game.meta.id}` })
        : null,
    ),
  );

  screenEl.replaceChildren(
    header("Settings", { back: true }),
    h(
      "main",
      { class: "page settings" },
      h("h2", {}, "Camera and tracking"),
      h(
        "div",
        { class: "card" },
        row("Tracking", nowUsing(), button(MODE_LABELS[tracking.mode], async () => {
          const pick = await choose("How should Playloom follow you?", modes.map((m) => ({ id: m, label: MODE_LABELS[m], hint: m === "auto" ? "Playloom picks what works best on this computer." : m === "practice" ? "No camera needed. Two pretend players, moved with the keyboard and mouse." : undefined })), tracking.mode);
          if (pick && pick !== tracking.mode) setMode(pick as TrackingMode);
        }, "", { "data-key": "mode", "aria-haspopup": "dialog" }), "mode"),
        row("Camera", cameraList.length > 1 ? `${cameraList.length} cameras found` : "Which camera to use", button(camera?.label ?? "Default camera", async () => {
          const ids = ["", ...cameraList.map((c) => c.deviceId)];
          const pick = await choose("Which camera?", [{ id: "", label: "Default camera" }, ...cameraList.map((c) => ({ id: c.deviceId, label: c.label || "Camera" }))], settings.cameraId && ids.includes(settings.cameraId) ? settings.cameraId : "");
          if (pick === null || pick === (settings.cameraId ?? "")) return;
          settings.cameraId = pick || undefined;
          clearTrial(); // a different camera may track at a different speed
          persist();
          void restartTracking();
        }, "", { "data-key": "camera", "aria-haspopup": "dialog" })),
        row("Mirror picture", "On works like a mirror, which most people find natural.", onOff("mirror", "Mirror picture", settings.mirror, (value) => {
          tracking.apply({ mirror: value });
          calibrated = false;
          persist();
          renderSettings();
        })),
        row("Gesture sensitivity", "Higher makes jumps, ducks and swipes easier. Handy for little ones.", seg("sens", "Gesture sensitivity", sensitivities, nearest(sensitivities, settings.sensitivity), (value) => {
          tracking.apply({ sensitivity: value });
          persist();
          renderSettings();
        })),
      ),

      h("h2", {}, "In the game"),
      h(
        "div",
        { class: "card" },
        row("Camera picture behind the game", "Shows you faintly behind the targets. Off keeps the picture clear and the game lighter.", seg<Backdrop>("backdrop", "Camera picture behind the game", [["off", "Off"], ["faint", "Faint"], ["strong", "Strong"]], prefs.backdrop, (value) => {
          prefs.backdrop = value;
          savePrefs();
          renderSettings();
        })),
        row("Sound", "Game sound effects.", seg("volume", "Sound", volumes, nearest(volumes, prefs.volume), (value) => {
          prefs.volume = audio.volume = value;
          savePrefs();
          audio.play("pop");
          renderSettings();
        })),
        row("Full screen", "Hides everything except Playloom.", onOff("fullscreen", "Full screen", !!document.fullscreenElement, (value) => {
          if (value === !!document.fullscreenElement) return;
          const change = value ? document.documentElement.requestFullscreen() : document.exitFullscreen();
          void change.then(() => renderSettings(), () => void tell("Full screen is not available", "This window cannot go full screen. In the desktop app, press F11."));
        })),
      ),

      h("h2", {}, "Check this computer"),
      h(
        "div",
        { class: "card" },
        row("Check this computer", "Tries each kind of tracking and keeps the best one. Takes three short tests.", button([icon("pulse"), checking ? "Checking…" : "Start the check"], () => void runCheck(), "", { "data-key": "check" })),
        row("Re-test tracking speed", "Automatic mode times each kind of tracking and keeps the fastest.", button([icon("refresh"), loadTrial() ? "Test again" : "Not tested yet"], () => {
          if (tracking.mode !== "auto") return void tell("Set Tracking to Automatic first", "Speed testing only runs in Automatic mode. Change Tracking above, then try again.");
          if (loadCheck()) return void tell("A full check is already saved", "Playloom is using the result of the full check. Run the check again above to refresh it.");
          clearTrial();
          void restartTracking();
        }, "", { "data-key": "retest" })),
        report,
        loadCheck() ? h("div", { class: "row", style: "justify-content:flex-start;padding-bottom:0.8em" }, button([icon("download"), "Save the report as a file"], () => download("playloom-compatibility.json", JSON.stringify(loadCheck(), null, 2), "application/json"), "quiet", { "data-key": "save-report" })) : null,
      ),

      h("h2", {}, "Games"),
      h("div", { class: "card" }, h("div", { class: "game-row" }, h("div", { class: "label" }, "Add a game", h("small", {}, "Open a .playloom file from someone you trust.")), button([icon("plus"), "Add a game"], () => fileInput.click(), "", { "data-key": "add" })), ...gameRows),

      h("h2", {}, "About"),
      h(
        "div",
        { class: "card" },
        h("div", { class: "note" }, "Playloom is free, open-source software (GNU GPL version 3 or later).\nThe camera picture is looked at on this computer and is never stored or sent anywhere. Playloom makes no network connections.\nBody tracking uses MediaPipe (Apache License 2.0)."),
        // The desktop application runs full screen with no window frame, so it needs its own way out.
        /Electron/.test(navigator.userAgent) ? h("div", { class: "row", style: "justify-content:flex-start;padding-bottom:0.8em" }, button([icon("power"), "Close Playloom"], () => window.close(), "", { "data-key": "close" })) : null,
      ),
    ),
    legend(),
  );
  screenEl.scrollTop = scrolled;
  const again = focused && screenEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`);
  if (again) again.focus({ preventScroll: true });
  else focusFirst();
}

/** The device check, with a dialog that says which test is running and how far along it is. */
async function runCheck(): Promise<void> {
  if (checking) return;
  if (tracking.error?.camera) return void tell("No camera found", "There is no camera to check yet. Plug one in and try the camera again from the home screen.");
  checking = true;
  calibrated = false;
  const progress = showProgress("Checking this computer");
  const STEP_MS = 5500;
  let step = { index: 1, of: 3, label: "", since: Date.now() };
  const paint = (): void =>
    progress.set(`Test ${step.index} of ${step.of}${step.label ? `: ${step.label}` : ""}`, (step.index - 1 + Math.min(1, (Date.now() - step.since) / STEP_MS)) / step.of, "Stand in front of the camera, two people if you can. You do not need to hold still.");
  paint();
  const ticker = window.setInterval(paint, 200);
  try {
    const result = await tracking.check((s) => {
      step = { ...s, since: Date.now() };
      paint();
    });
    window.clearInterval(ticker);
    progress.close();
    checking = false;
    if (screen === "settings") renderSettings();
    await tell("The check is finished", describeCheck(result).split("\n").slice(0, 2).map((line) => h("p", {}, line)));
  } catch (err) {
    window.clearInterval(ticker);
    progress.close();
    checking = false;
    await tell("The check could not finish", (err as Error).message);
  } finally {
    window.clearInterval(ticker);
    checking = false;
    if (screen === "settings") renderSettings();
  }
}

// ---- Main loop ------------------------------------------------------------------------------------

const renderRate = new RateMeter(2000);
tracking.renderFps = () => renderRate.rate();
let last = 0;
let lastChips = 0;
let lastSettingsState = tracking.state;

function frame(now: number): void {
  renderRate.tick(now);
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  if (screen === "play" && playing) {
    fitStage();
    playing.runtime.update(dt);
    renderToCanvas(ctx, playing.runtime, { video: tracking.video(), mirror: settings.mirror, backdrop: prefs.backdrop, images: playing.images });
    syncPlayOverlay();
  } else if (screen === "setup") {
    fitStage();
    drawSetup();
    if (now - lastChips > 300) {
      lastChips = now;
      updateChips();
    }
  } else if (screen === "settings" && now - lastChips > 500) {
    lastChips = now;
    updateChips();
    const hint = screenEl.querySelector('[data-row="mode"] .hint-text');
    if (hint) hint.textContent = nowUsing();
    if (tracking.state !== lastSettingsState) {
      lastSettingsState = tracking.state;
      if (overlayEl.hidden) renderSettings();
    }
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
    if (overlayEl.hidden) focusFirst();
  }
  // First run with a working camera: offer to measure the device once.
  if (tracking.state === "running" && !tracking.practice && !loadCheck() && !prefs.welcomed) {
    prefs.welcomed = true;
    savePrefs();
    const answer = await ask(
      "Welcome to Playloom!",
      [h("p", {}, "Playloom can test how well this computer and your camera work together. It runs three short tests, one after another, and shows each one as it goes. Two people standing in front of the camera gives the best result."), h("p", {}, "You can also skip this and do it later in Settings.")],
      [{ id: "yes", label: "Start the check", cls: "go", icon: "pulse" }, { id: "no", label: "Skip for now", cls: "quiet" }],
      "no",
    );
    if (answer === "yes") await runCheck();
  }
}

// Exposed for automated browser tests.
(window as unknown as { playloom: unknown }).playloom = { tracking, api, getRuntime: () => playing?.runtime ?? null, getScreen: () => screen, getLibrary: () => library };

void boot();
