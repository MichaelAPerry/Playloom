import type { Side, SimulatorSource } from "./simulator";

/**
 * Keyboard and mouse control of the simulator, for the playground and Studio's preview.
 *
 *   Mouse            move the selected player's right hand (hold Shift: left hand)
 *   1 / 2            select which player the mouse controls
 *
 *                    Player 1     Player 2
 *   walk             A / D        J / L
 *   jump             W            I
 *   duck (hold)      S            K
 *   lean (hold)      Q / E        U / O
 *   hands up (hold)  F            H
 *   swipe            R            P
 *
 *   X  selected player leaves / returns      Z  tracking dropout (1 s)
 *   C  hide selected player (1.5 s)          V  players swap places
 *   B  toggle random detection order         Esc  relax the selected player's arms
 */

export interface SimulatorControls {
  readonly selectedPlayer: number;
  detach(): void;
}

interface KeyMap {
  left: string;
  right: string;
  jump: string;
  duck: string;
  leanLeft: string;
  leanRight: string;
  handsUp: string;
  swipe: string;
}

const KEYS: KeyMap[] = [
  { left: "a", right: "d", jump: "w", duck: "s", leanLeft: "q", leanRight: "e", handsUp: "f", swipe: "r" },
  { left: "j", right: "l", jump: "i", duck: "k", leanLeft: "u", leanRight: "o", handsUp: "h", swipe: "p" },
];

export const SIMULATOR_HELP: ReadonlyArray<readonly [string, string]> = [
  ["Mouse", "Move selected player's right hand (Shift: left hand)"],
  ["1 / 2", "Select the player the mouse controls"],
  ["A D · J L", "Walk (Player 1 · Player 2)"],
  ["W · I", "Jump"],
  ["S · K", "Duck (hold)"],
  ["Q E · U O", "Lean (hold)"],
  ["F · H", "Hands up (hold)"],
  ["R · P", "Swipe"],
  ["X", "Selected player leaves / returns"],
  ["Z", "Tracking dropout for 1 s"],
  ["C", "Hide selected player for 1.5 s"],
  ["V", "Players swap places"],
  ["B", "Toggle random detection order"],
  ["Esc", "Relax selected player's arms"],
];

/**
 * @param surface element whose box represents the screen; mouse positions are relative to it
 */
export function attachSimulatorControls(
  sim: SimulatorSource,
  surface: HTMLElement,
  onChange?: (controls: SimulatorControls) => void,
): SimulatorControls {
  let selected = 1;
  let shuffle = false;
  const held = new Set<string>();
  const playerCount = Math.min(sim.options.players, KEYS.length);

  const controls: SimulatorControls = {
    get selectedPlayer() {
      return selected;
    },
    detach() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      surface.removeEventListener("pointermove", onMove);
    },
  };

  const applyHeld = (): void => {
    for (let i = 0; i < playerCount; i++) {
      const k = KEYS[i]!;
      const player = i + 1;
      sim.setWalking(player, (held.has(k.right) ? 1 : 0) - (held.has(k.left) ? 1 : 0));
      sim.setDuck(player, held.has(k.duck));
      sim.setLean(player, (held.has(k.leanRight) ? 1 : 0) - (held.has(k.leanLeft) ? 1 : 0));
      sim.setHandsUp(player, held.has(k.handsUp));
    }
  };

  const isTyping = (e: KeyboardEvent): boolean => {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (e.repeat) return;
    held.add(key);
    applyHeld();
    for (let i = 0; i < playerCount; i++) {
      const k = KEYS[i]!;
      if (key === k.jump) sim.jump(i + 1);
      if (key === k.swipe) sim.swipe(i + 1, "right", i === 0 ? "right" : "left");
    }
    if (key === "1" || key === "2") {
      const n = Number(key);
      if (n <= sim.options.players) selected = n;
    } else if (key === "x") sim.setPresent(selected, !sim.isPresent(selected));
    else if (key === "z") sim.dropout(1000);
    else if (key === "c") sim.occlude(selected, 1500);
    else if (key === "v") sim.cross();
    else if (key === "b") sim.setShuffle((shuffle = !shuffle));
    else if (key === "escape") {
      sim.setHand(selected, "left", null);
      sim.setHand(selected, "right", null);
    }
    onChange?.(controls);
  }

  function onKeyUp(e: KeyboardEvent): void {
    held.delete(e.key.toLowerCase());
    applyHeld();
  }

  function onMove(e: PointerEvent): void {
    const box = surface.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const side: Side = e.shiftKey ? "left" : "right";
    sim.setHand(selected, side, { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  surface.addEventListener("pointermove", onMove);
  return controls;
}
