import type { MotionApi, PlayerState } from "../engine";
import type { PlayerId } from "../types";

/**
 * Join-by-gesture for player setup. Nothing here waits on a clock: a person standing in a half of the
 * picture is "detected"; raising a hand (seen on a few consecutive frames, only to ignore one-frame
 * glitches) makes them "joined". Once both have joined, both raising both hands starts the game.
 *
 * Feed it with `update()` after every tracking frame (`events.on("frame", ...)`).
 */

export type Slot = 1 | 2;

export interface SlotState {
  /** Someone is standing in this half of the picture. */
  detected: boolean;
  joined: boolean;
  /** The engine's current number for the person in this slot (what `calibrateNow({ ids })` expects). */
  playerId?: PlayerId;
}

export interface JoinOptions {
  /** Consecutive frames a hand must be seen raised before it counts. */
  raiseFrames: number;
  /** Consecutive frames both players must hold both hands up to start. */
  startFrames: number;
  /** A joined player not seen for this many frames gives up their slot. */
  lostFrames: number;
}

const DEFAULTS: JoinOptions = { raiseFrames: 3, startFrames: 6, lostFrames: 45 };

export type JoinEvent = { type: "joined"; slot: Slot } | { type: "left"; slot: Slot } | { type: "start" };

export class PlayerJoin {
  readonly slots: [SlotState, SlotState] = [{ detected: false, joined: false }, { detected: false, joined: false }];
  /** True once both joined players have held both hands up. */
  startRequested = false;

  private opts: JoinOptions;
  private raise: [{ id: PlayerId | null; n: number }, { id: PlayerId | null; n: number }] = [{ id: null, n: 0 }, { id: null, n: 0 }];
  private missing: [number, number] = [0, 0];
  /** Joined players must lower their hands once before holding them up can start the game. */
  private armed: [boolean, boolean] = [false, false];
  private both = 0;
  private listeners: Array<(e: JoinEvent) => void> = [];

  constructor(
    private api: MotionApi,
    options: Partial<JoinOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  on(fn: (e: JoinEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Ids of everyone who has joined, for `engine.calibrateNow({ ids })`. */
  get joinedIds(): PlayerId[] {
    return this.slots.flatMap((s) => (s.joined && s.playerId !== undefined ? [s.playerId] : []));
  }

  get joinedCount(): number {
    return this.slots.filter((s) => s.joined).length;
  }

  /** Confirm whoever is detected in a slot without raising a hand (keyboard or remote). False if nobody is there. */
  confirm(slot: Slot): boolean {
    const s = this.slots[slot - 1]!;
    if (s.joined) return true;
    if (!s.detected || s.playerId === undefined) return false;
    this.join(slot);
    return true;
  }

  update(): void {
    const present = this.api.players.all().filter((p) => p.present && p.bodyPosition);
    const taken = new Set<PlayerId>();
    // Joined players stay bound to the person who joined, wherever they now stand.
    for (const slot of [1, 2] as Slot[]) {
      const s = this.slots[slot - 1]!;
      if (!s.joined) continue;
      const person = present.find((p) => p.id === s.playerId);
      if (person) {
        taken.add(person.id);
        this.missing[slot - 1] = 0;
        if (!person.gestures.handsUp) this.armed[slot - 1] = true;
      } else if (++this.missing[slot - 1]! > this.opts.lostFrames) {
        this.slots[slot - 1] = { detected: false, joined: false };
        this.armed[slot - 1] = false;
        this.emit({ type: "left", slot });
      }
    }
    // Everyone else is offered to the slot for the half they stand in (nearest to its centre).
    for (const slot of [1, 2] as Slot[]) {
      const s = this.slots[slot - 1]!;
      if (s.joined) continue;
      const centre = slot === 1 ? 0.25 : 0.75;
      const inHalf = present.filter((p) => !taken.has(p.id) && (slot === 1 ? p.bodyPosition!.x < 0.5 : p.bodyPosition!.x >= 0.5));
      const person = inHalf.sort((a, b) => Math.abs(a.bodyPosition!.x - centre) - Math.abs(b.bodyPosition!.x - centre))[0];
      this.slots[slot - 1] = { detected: !!person, joined: false, playerId: person?.id };
      this.trackRaise(slot, person);
    }
    // Both hands from both players, held for a few frames, starts the game.
    const [a, b] = this.slots;
    const players = [a, b].map((s) => (s.joined ? present.find((p) => p.id === s.playerId) : undefined));
    if (a.joined && b.joined && this.armed[0] && this.armed[1] && players.every((p) => p?.gestures.handsUp)) {
      if (++this.both >= this.opts.startFrames && !this.startRequested) {
        this.startRequested = true;
        this.emit({ type: "start" });
      }
    } else this.both = 0;
  }

  private trackRaise(slot: Slot, person: PlayerState | undefined): void {
    const r = this.raise[slot - 1]!;
    const raised = !!person && (person.gestures.leftHandRaised || person.gestures.rightHandRaised || person.gestures.handsUp);
    if (!person || !raised) {
      r.id = null;
      r.n = 0;
    } else if (r.id !== person.id) {
      r.id = person.id;
      r.n = 1;
    } else r.n++;
    if (raised && r.n >= this.opts.raiseFrames) this.join(slot);
  }

  private join(slot: Slot): void {
    const s = this.slots[slot - 1]!;
    s.joined = true;
    s.detected = true;
    this.armed[slot - 1] = false;
    this.missing[slot - 1] = 0;
    this.raise[slot - 1] = { id: null, n: 0 };
    this.emit({ type: "joined", slot });
  }

  private emit(e: JoinEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}
