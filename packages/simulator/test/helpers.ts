import { MotionEngine, type EngineOptions, type MotionEvents } from "@playloom/core";
import { SimulatorSource, type SimulatorOptions } from "../src";

export interface Rig {
  sim: SimulatorSource;
  engine: MotionEngine;
  /** Every event emitted, in order, tagged with its type. */
  log: Array<{ type: keyof MotionEvents } & Record<string, unknown>>;
  types(): string[];
  gestures(player?: number): string[];
}

const LOGGED: (keyof MotionEvents)[] = [
  "gesture",
  "player-joined",
  "player-left",
  "tracking-lost",
  "tracking-restored",
  "identity-uncertain",
  "identity-restored",
  "identity-swapped",
];

/** A simulator on a manual clock wired to an engine, already running. */
export async function rig(simOptions: Partial<SimulatorOptions> = {}, engineOptions: Partial<EngineOptions> = {}): Promise<Rig> {
  const sim = new SimulatorSource({ clock: "manual", ...simOptions });
  const engine = new MotionEngine({ now: () => sim.now, ...engineOptions });
  const log: Rig["log"] = [];
  for (const type of LOGGED) engine.api.events.on(type, (e) => log.push({ type, ...(e as object) }));
  await engine.attach(sim);
  await engine.start();
  return {
    sim,
    engine,
    log,
    types: () => log.map((e) => e.type),
    gestures: (player) =>
      log
        .filter((e) => e.type === "gesture" && (player === undefined || e.player === player))
        .map((e) => `${e.gesture}:${e.phase}`),
  };
}
