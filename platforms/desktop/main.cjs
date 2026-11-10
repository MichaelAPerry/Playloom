// Playloom desktop shell (Electron main process).
//
// It does three things and nothing else:
//   1. shows the Console full screen, served from files inside the application;
//   2. lets that page use the camera, and nothing else the system offers;
//   3. refuses every network request, so nothing — including third-party telemetry — can leave.
//
// The page gets no Node.js access, no preload script and no way to open other windows.

const { app, BrowserWindow, protocol, session } = require("electron");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const ROOT = path.join(__dirname, "app");
const ORIGIN = "app://playloom";

// A custom scheme that the browser engine treats like https: needed for the camera, WebAssembly and modules.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

app.on("window-all-closed", () => app.quit());
// A second launch focuses the running window instead of fighting it for the camera.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "playloom") return new Response("Not found", { status: 404 });
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(ROOT, relative));
    // Never serve anything outside the application folder.
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response("Forbidden", { status: 403 });
    try {
      // Files are read directly rather than fetched, so no file: or network request is ever made.
      const body = await readFile(file);
      return new Response(body, { headers: { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "x-content-type-options": "nosniff" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  const ses = session.defaultSession;

  // Offline by construction: only the application's own files, and in-memory blob:/data: URLs, may load.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(app:\/\/playloom\/|blob:|data:|devtools:)/.test(details.url);
    if (!allowed) console.warn(`[playloom] blocked request to ${new URL(details.url).origin}`);
    callback({ cancel: !allowed });
  });

  // The camera is the only device permission Playloom needs.
  const isOurs = (url) => typeof url === "string" && url.startsWith(ORIGIN);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isOurs(contents.getURL())) return callback(false);
    if (permission === "fullscreen") return callback(true);
    if (permission === "media") return callback(!(details.mediaTypes ?? []).includes("audio"));
    callback(false);
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => isOurs(origin) && (permission === "media" || permission === "fullscreen"));

  const windowed = process.argv.includes("--windowed");
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: !windowed,
    autoHideMenuBar: true,
    backgroundColor: "#141a33",
    title: "Playloom",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, spellcheck: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isOurs(url)) event.preventDefault();
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  win.loadURL(`${ORIGIN}/index.html`);
});
