/** Small DOM helpers and the Console's hand-drawn icons. Everything here is plain DOM; nothing is loaded. */

export type Child = Node | string | null | false | undefined | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "onclick") el.addEventListener("click", value as EventListener);
    else if (key === "style") el.setAttribute("style", String(value));
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") el.setAttribute(key, value === true ? "" : String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  const add = (child: Child): void => {
    if (Array.isArray(child)) child.forEach(add);
    else if (child) el.append(child);
  };
  children.forEach(add);
  return el;
}

export const button = (label: Child, onclick: () => void, cls = "", extra: Record<string, unknown> = {}): HTMLButtonElement =>
  h("button", { class: cls, onclick, type: "button", ...extra }, label);

// ---- Icons ----------------------------------------------------------------------------------------
// Simple 24 x 24 line drawings. A path starting with "f:" is filled instead of stroked.

const ICONS = {
  back: ["M15 5l-7 7 7 7"],
  sliders: ["M4 7h8 M18 7h2 M4 12h2 M12 12h8 M4 17h9 M19 17h1", "M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M16 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"],
  plus: ["M12 5v14 M5 12h14"],
  players: ["M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M2.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5", "M17 10a2.5 2.5 0 1 0 0-5", "M16.5 14.6c2.8.2 5 2.2 5 5.4"],
  pause: ["f:M6.5 4.5h3.5v15H6.5z M14 4.5h3.5v15H14z"],
  play: ["f:M7.5 4.8v14.4L19.5 12z"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  close: ["M6 6l12 12 M18 6L6 18"],
  camera: ["M3 8h4l1.5-2h7L17 8h4v11H3z", "M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"],
  hand: ["M9 12V5.5a1.5 1.5 0 0 1 3 0V11 M12 10V4a1.5 1.5 0 0 1 3 0v7 M15 10.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 6-6 6-2.5 0-4-1-5.5-3L4 13.5a1.5 1.5 0 0 1 2.4-1.8L9 14"],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8 M20 4v5h-5"],
  download: ["M12 4v11 M7.5 11l4.5 4.5 4.5-4.5 M5 20h14"],
  trash: ["M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13"],
  fullscreen: ["M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"],
  home: ["M4 11l8-7 8 7 M6 10v10h12V10"],
  power: ["M12 3v9 M6.5 6.5a8 8 0 1 0 11 0"],
  pulse: ["M3 12h4l2-6 4 12 2-6h6"],
  warn: ["M12 4l9 16H3z M12 10v4 M12 17v.5"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;

const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const filled = d.startsWith("f:");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", filled ? d.slice(2) : d);
    if (filled) path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}

/** The Playloom mark: two overlapping circles, one for each player. */
export function logo(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 28");
  svg.setAttribute("class", "logo");
  svg.setAttribute("aria-hidden", "true");
  const circle = (cx: number, color: string): void => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", "14");
    c.setAttribute("r", "12");
    c.setAttribute("fill", color);
    c.setAttribute("fill-opacity", "0.92");
    svg.append(c);
  };
  circle(14, "#ff9f1c");
  circle(26, "#3ec5ff");
  return svg;
}
