import type { MotionEngine } from "../engine";
import {
  buildDiagnostics,
  currentEnvironment,
  detectGraphicsRenderer,
  diagnosticsRows,
  formatDiagnostics,
  type DiagnosticsReport,
  type GraphicsInfo,
} from "./diagnostics";
import { FramePacingMeter } from "./frame-pacing";

/**
 * The performance panel: a small box in a corner of the screen that shows what the camera, the
 * model and the screen are doing, with a "Copy details" button that puts the same information on the
 * clipboard as plain text. It brings its own styles so it can be dropped into any page.
 *
 * Toggle it with F3 or `setVisible`. The choice is remembered in local storage.
 */
export interface DiagnosticsPanelOptions {
  engine: MotionEngine;
  /** The drawing canvas, for its size. */
  canvas?: () => HTMLCanvasElement | null;
  /** Where to mount the panel. Defaults to the page body. */
  parent?: HTMLElement;
  /** Called when the panel is shown or hidden (by the key or the close button). */
  onChange?: (visible: boolean) => void;
  /** Key that toggles the panel. Default F3; pass "" for none. */
  hotkey?: string;
  refreshMs?: number;
}

const STORAGE_KEY = "playloom.diagnostics";
const STYLE_ID = "playloom-diagnostics-style";
const CSS = `
.plv-diag{position:fixed;top:8px;right:8px;z-index:2147483000;width:min(380px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;
  box-sizing:border-box;padding:8px 10px;border-radius:8px;background:rgba(10,12,20,.88);color:#e9edf7;
  font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;box-shadow:0 2px 12px rgba(0,0,0,.45);text-align:left}
.plv-diag[hidden]{display:none}
.plv-diag h2{margin:0 0 4px;font:600 12px/1.3 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#9fb0d0;display:flex;justify-content:space-between;align-items:center}
.plv-diag dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:1px 10px}
.plv-diag dt{color:#8ea0c2;white-space:nowrap}
.plv-diag dd{margin:0;overflow-wrap:anywhere}
.plv-diag .plv-hints{margin:6px 0 0;padding:6px 0 0;border-top:1px solid rgba(255,255,255,.15);color:#ffd27a;list-style:none}
.plv-diag .plv-hints li{margin:2px 0}
.plv-diag .plv-row{display:flex;gap:6px;margin-top:8px}
.plv-diag button{font:600 12px system-ui,sans-serif;padding:4px 10px;border-radius:6px;border:1px solid #4a5a7a;background:#243049;color:#fff;cursor:pointer}
.plv-diag button:hover{background:#2f4062}
.plv-diag textarea{width:100%;height:120px;margin-top:6px;box-sizing:border-box;font:11px/1.3 ui-monospace,monospace;background:#0b0e16;color:#e9edf7;border:1px solid #4a5a7a}
`;

export class DiagnosticsPanel {
  readonly pacing = new FramePacingMeter();
  private root: HTMLElement;
  private body: HTMLElement;
  private hints: HTMLElement;
  private status: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private graphics: GraphicsInfo | null = null;
  private shown = false;
  private latest: DiagnosticsReport | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private options: DiagnosticsPanelOptions) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const el = (tag: string, cls?: string): HTMLElement => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    this.root = el("div", "plv-diag");
    this.root.hidden = true;
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Performance details");
    const title = el("h2");
    title.textContent = "Performance details";
    this.body = el("dl");
    this.hints = el("ul", "plv-hints");
    this.status = el("span");
    const row = el("div", "plv-row");
    const copy = el("button");
    copy.setAttribute("type", "button");
    copy.textContent = "Copy details";
    copy.addEventListener("click", () => void this.copy());
    const close = el("button");
    close.setAttribute("type", "button");
    close.textContent = "Close";
    close.addEventListener("click", () => this.setVisible(false));
    row.append(copy, close, this.status);
    this.root.append(title, this.body, this.hints, row);
    (options.parent ?? document.body).appendChild(this.root);

    const hotkey = options.hotkey ?? "F3";
    if (hotkey) {
      this.keyHandler = (e) => {
        if (e.key !== hotkey || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        this.setVisible(!this.shown);
      };
      window.addEventListener("keydown", this.keyHandler);
    }
    let stored = false;
    try {
      stored = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* storage can be blocked; the panel then simply starts hidden */
    }
    if (stored) this.setVisible(true, false);
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(visible: boolean, notify = true): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.root.hidden = !visible;
    try {
      localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (visible) {
      this.graphics ??= detectGraphicsRenderer();
      this.refresh();
      this.timer = setInterval(() => this.refresh(), this.options.refreshMs ?? 500);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (notify) this.options.onChange?.(visible);
  }

  /** Call once per rendered frame with the frame time (milliseconds). */
  frame(now: number): void {
    this.pacing.tick(now);
  }

  /** The current measurements. */
  report(): DiagnosticsReport {
    this.graphics ??= detectGraphicsRenderer();
    const engine = this.options.engine;
    return buildDiagnostics({
      status: engine.api.status,
      source: engine.sourceDiagnostics(),
      pacing: this.pacing.stats(),
      env: currentEnvironment(this.options.canvas?.() ?? null, this.graphics),
    });
  }

  /** Put the details on the clipboard; if the browser refuses, show them selected so they can be copied by hand. */
  async copy(): Promise<void> {
    const text = formatDiagnostics(this.latest ?? this.report());
    try {
      await navigator.clipboard.writeText(text);
      this.say("Copied");
      return;
    } catch {
      /* fall through to the manual way */
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    this.root.appendChild(area);
    area.focus();
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* ignore */
    }
    this.say(ok ? "Copied" : "Select the text and copy it");
    if (ok) area.remove();
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    this.root.remove();
  }

  private say(text: string): void {
    this.status.textContent = text;
    setTimeout(() => (this.status.textContent = ""), 2500);
  }

  private refresh(): void {
    const report = (this.latest = this.report());
    const rows = diagnosticsRows(report);
    this.body.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    this.hints.replaceChildren(
      ...report.hints.map((h) => {
        const li = document.createElement("li");
        li.textContent = h;
        return li;
      }),
    );
    this.hints.hidden = report.hints.length === 0;
  }
}
