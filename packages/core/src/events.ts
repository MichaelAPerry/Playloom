import type { Unsubscribe } from "./types";

/** Minimal typed event emitter. A failing listener never stops the tracking pipeline. */
export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<(e: never) => void>>();

  on<E extends keyof Events>(type: E, fn: (e: Events[E]) => void): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (e: never) => void);
    return () => set.delete(fn as (e: never) => void);
  }

  emit<E extends keyof Events>(type: E, event: Events[E]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (e: Events[E]) => void)(event);
      } catch (err) {
        console.error(`[playloom] listener for "${String(type)}" threw`, err);
      }
    }
  }
}
