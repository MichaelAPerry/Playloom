/**
 * Navigation without a mouse: arrow keys, a TV remote's direction pad, or a gamepad.
 *
 * Focus moves to the nearest button in the direction pressed. Only buttons inside the top-most
 * layer are considered, so an open dialog keeps focus to itself. Escape, Backspace or a
 * gamepad's B button goes back.
 */

type Direction = "up" | "down" | "left" | "right";

let layer: () => HTMLElement = () => document.body;
let onBack: () => void = () => {};
let onMenu: () => void = () => {};

export function setNavigation(options: { layer: () => HTMLElement; back: () => void; menu: () => void }): void {
  layer = options.layer;
  onBack = options.back;
  onMenu = options.menu;
}

function candidates(): HTMLElement[] {
  return [...layer().querySelectorAll<HTMLElement>("button:not(:disabled)")].filter((el) => el.offsetParent !== null);
}

/** Everything that can be focused in the current layer, in reading order. Used by tests and checks. */
export function focusables(): HTMLElement[] {
  return candidates();
}

/** Focus the element marked `data-first`, or else the first button, in the current layer. */
export function focusFirst(): void {
  const all = candidates();
  (all.find((el) => el.dataset.first !== undefined) ?? all[0])?.focus({ preventScroll: false });
}

export function move(direction: Direction): void {
  const all = candidates();
  const current = document.activeElement as HTMLElement | null;
  if (!current || !all.includes(current)) return focusFirst();
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    // Prefer things straight ahead: sideways distance counts double.
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  // Nothing lies that way (a ragged grid, or a control hidden behind a corner): fall back to the
  // next or previous control in reading order, so every control can always be reached.
  if (!best) {
    const i = all.indexOf(current);
    best = (direction === "down" || direction === "right" ? all[i + 1] : all[i - 1]) ?? null;
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

const KEYS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

export function startNavigation(): void {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const direction = KEYS[e.key];
    if (direction) {
      e.preventDefault();
      move(direction);
    } else if (e.key === "Escape" || e.key === "Backspace" || e.key === "BrowserBack" || e.key === "GoBack") {
      e.preventDefault();
      onBack();
    } else if ((e.key === "Enter" || e.key === " ") && !(document.activeElement instanceof HTMLButtonElement)) {
      e.preventDefault();
      focusFirst();
    }
  });

  // Gamepads have no events for buttons, so they are polled.
  const held = new Map<string, number>();
  const press = (name: string, down: boolean, now: number, action: () => void, repeat = false): void => {
    const since = held.get(name);
    if (!down) return void held.delete(name);
    if (since === undefined) {
      held.set(name, now);
      action();
    } else if (repeat && now - since > 450) {
      held.set(name, now - 300);
      action();
    }
  };
  const poll = (now: number): void => {
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const b = (i: number): boolean => !!pad.buttons[i]?.pressed;
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      const id = pad.index;
      press(`${id}u`, b(12) || y < -0.6, now, () => move("up"), true);
      press(`${id}d`, b(13) || y > 0.6, now, () => move("down"), true);
      press(`${id}l`, b(14) || x < -0.6, now, () => move("left"), true);
      press(`${id}r`, b(15) || x > 0.6, now, () => move("right"), true);
      press(`${id}a`, b(0), now, () => {
        const el = document.activeElement;
        if (el instanceof HTMLButtonElement && candidates().includes(el)) el.click();
        else focusFirst();
      });
      press(`${id}b`, b(1), now, () => onBack());
      press(`${id}s`, b(9), now, () => onMenu());
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
