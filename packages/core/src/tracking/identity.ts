import { dist } from "../geometry";
import type { PlayerId, Point, RawPerson } from "../types";

/**
 * Identity tracking: turns the unordered list of people a pose model reports each frame into
 * stable player numbers.
 *
 * Pose models do not say who is who. This tracker follows each person by position, speed and body
 * size, and — importantly — knows when it cannot be sure. When two players overlap, hide one
 * another, or come back into view in a doubtful arrangement, the affected players are marked
 * `uncertain` rather than being silently swapped.
 *
 * What it can and cannot resolve on its own:
 *   - If the players' calibrated body sizes clearly differ (an adult and a child), size is used to
 *     tell them apart after an overlap.
 *   - Otherwise identity is defined by side: after an overlap, the players are expected to be in
 *     the same left-to-right order as before it. If they are not, the tracker stays `uncertain`
 *     and asks for action until they step back to their sides or the host calls `confirm()` /
 *     `swap()`.
 *
 * All distances are in whatever units the caller uses for `anchor` and `scale`; the engine passes
 * aspect-corrected coordinates so that horizontal and vertical distances are comparable.
 */

export interface Detection {
  person: RawPerson;
  /** Point used to follow this person (shoulder centre). */
  anchor: Point;
  /** Body size, or null when it could not be measured this frame. */
  scale: number | null;
}

export interface TrackerOptions {
  maxPlayers: number;
  /** Detections below this confidence are ignored. */
  minPersonScore: number;
  /** A new person must be seen this many times before becoming a player (rejects flicker). */
  confirmFrames: number;
  /** How long a player may go unseen before being reported as lost. */
  coastMs: number;
  /** How long a lost player's number stays reserved for their return. */
  retainMs: number;
  /** Largest jump between frames, in body sizes, that can still be the same person. */
  gateDistance: number;
  /** Weight of body-size mismatch relative to distance when matching. */
  scaleWeight: number;
  /** If the best match beats the next-best by less than this, identity is uncertain. */
  ambiguityMargin: number;
  /** Players whose anchors are closer than this many body sizes are considered overlapping. */
  proximity: number;
  /** How long things must stay unambiguous before an uncertain episode is resolved. */
  settleMs: number;
  /** Calibrated body sizes must differ by at least this ratio before size is trusted to identify. */
  scaleDiscrimination: number;
  /** Players who join within this time of each other are numbered left to right. */
  pairingMs: number;
  /** After a player is lost mid-episode, how long the others stay uncertain waiting for them. */
  episodeLostTimeoutMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxPlayers: 2,
  minPersonScore: 0.3,
  confirmFrames: 3,
  coastMs: 400,
  retainMs: 10_000,
  gateDistance: 2,
  scaleWeight: 0.5,
  ambiguityMargin: 0.5,
  proximity: 0.5,
  settleMs: 400,
  scaleDiscrimination: 1.3,
  pairingMs: 1500,
  episodeLostTimeoutMs: 2000,
};

export type TrackState = "tracked" | "coasting" | "lost";
export type IdentityState = "locked" | "uncertain";
export type UncertainReason = "overlap" | "crossed" | "reentry";

export interface TrackView {
  id: PlayerId;
  /** Changes whenever the underlying physical track changes; use it to key per-body state. */
  uid: number;
  state: TrackState;
  identity: IdentityState;
  /** The matched detection for this frame; undefined while coasting or lost. */
  person?: RawPerson;
  anchor: Point;
  scale: number;
}

export type TrackerEvent =
  | { type: "joined"; id: PlayerId }
  | { type: "left"; id: PlayerId }
  | { type: "lost"; id: PlayerId }
  | { type: "restored"; id: PlayerId }
  | { type: "swapped"; ids: [PlayerId, PlayerId] }
  | { type: "uncertain"; ids: PlayerId[]; reason: UncertainReason; needsAction: boolean }
  | { type: "locked"; ids: PlayerId[] };

export interface TrackerOutput {
  players: TrackView[];
  events: TrackerEvent[];
}

interface Track {
  uid: number;
  id: PlayerId | null; // null while tentative
  state: "tentative" | TrackState;
  hits: number;
  anchor: Point;
  velocity: Point; // units per second
  scale: number;
  refScale: number;
  refScaleFixed: boolean;
  lastSeen: number;
  lostAt: number;
  joinedAt: number;
  person?: RawPerson;
}

interface Episode {
  /** Player ids in left-to-right order at the last moment identity was certain. */
  order: PlayerId[];
  reason: UncertainReason;
  clearSince: number | null;
  needsAction: boolean;
}

const DEFAULT_SCALE = 0.2;
const MIN_SCALE = 0.02;
const MAX_PREDICT_S = 0.25;

interface Assignment {
  /** For each row, the chosen column or -1. */
  cols: number[];
  count: number;
  cost: number;
}

/**
 * Exhaustive assignment of rows to columns for the tiny matrices involved (players × people).
 * Maximises the number of matches, then minimises total cost. `margin` is how much worse the best
 * alternative with the same number of matches is, counting only alternatives that change the
 * column of a row flagged in `important`.
 */
export function bestAssignment(
  cost: number[][],
  important: boolean[] = cost.map(() => true),
): Assignment & { margin: number } {
  const rows = cost.length;
  const cols = cost[0]?.length ?? 0;
  const all: Assignment[] = [];
  const current: number[] = [];
  const used = new Array<boolean>(cols).fill(false);

  const walk = (r: number, count: number, total: number): void => {
    if (r === rows) {
      all.push({ cols: [...current], count, cost: total });
      return;
    }
    for (let c = 0; c < cols; c++) {
      const v = cost[r]![c]!;
      if (used[c] || !Number.isFinite(v)) continue;
      used[c] = true;
      current.push(c);
      walk(r + 1, count + 1, total + v);
      current.pop();
      used[c] = false;
    }
    current.push(-1);
    walk(r + 1, count, total);
    current.pop();
  };
  walk(0, 0, 0);

  all.sort((a, b) => b.count - a.count || a.cost - b.cost);
  const best = all[0]!;
  let margin = Infinity;
  for (let i = 1; i < all.length; i++) {
    const alt = all[i]!;
    if (alt.count !== best.count) break;
    const differs = alt.cols.some((c, r) => important[r] && c !== best.cols[r]);
    if (differs) {
      margin = alt.cost - best.cost;
      break;
    }
  }
  return { ...best, margin };
}

const sameOrder = (a: PlayerId[], b: PlayerId[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export class IdentityTracker {
  readonly options: TrackerOptions;
  private tracks: Track[] = [];
  private nextUid = 1;
  private episode: Episode | null = null;
  private stableOrder: PlayerId[] = [];
  /** Order to verify when a player lost during an uncertain episode comes back. */
  private pendingOrder: PlayerId[] | null = null;
  private sideAssigned = false;
  private events: TrackerEvent[] = [];

  constructor(options: Partial<TrackerOptions> = {}) {
    this.options = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  /** Feed one frame of detections. `t` is in milliseconds and must not go backwards. */
  update(detections: Detection[], t: number): TrackerOutput {
    const o = this.options;
    this.events = [];
    const dets = this.dedupe(detections.filter((d) => d.person.score >= o.minPersonScore));

    // 1. Match live tracks (players and candidates) to detections.
    const live = this.tracks.filter((tr) => tr.state !== "lost");
    const cost = live.map((tr) => dets.map((d) => this.matchCost(tr, d, t)));
    const assignment = bestAssignment(
      cost,
      live.map((tr) => tr.id !== null),
    );
    const takenDet = new Set<number>();
    const unmatchedPlayers: Track[] = [];
    live.forEach((tr, r) => {
      const c = assignment.cols[r]!;
      if (c >= 0) {
        takenDet.add(c);
        this.applyMatch(tr, dets[c]!, t);
      } else if (tr.id !== null) {
        unmatchedPlayers.push(tr);
      }
    });

    let ambiguous = false;
    let reason: UncertainReason = "overlap";
    const playersAlive = live.filter((tr) => tr.id !== null);
    if (playersAlive.length >= 1 && assignment.count > 0 && assignment.margin < o.ambiguityMargin) ambiguous = true;

    // 2. Players that were not seen: coast, then lose.
    for (const tr of unmatchedPlayers) {
      tr.person = undefined;
      if (tr.state === "tracked") {
        tr.state = "coasting";
        // Vanishing right next to another player usually means one is hiding the other,
        // and then nothing says which of the two the remaining detection is.
        for (const other of playersAlive) {
          if (other !== tr && dist(other.anchor, tr.anchor) < 1.2 * Math.max(other.scale, tr.scale)) ambiguous = true;
        }
      }
      if (tr.state === "coasting" && t - tr.lastSeen > o.coastMs) {
        tr.state = "lost";
        tr.lostAt = t;
        tr.velocity = { x: 0, y: 0 };
        this.events.push({ type: "lost", id: tr.id! });
      }
    }

    // 3. Forget candidates that went away and lost players whose reservation ran out.
    this.tracks = this.tracks.filter((tr) => {
      if (tr.state === "tentative") return t - tr.lastSeen <= o.coastMs;
      if (tr.state === "lost" && t - tr.lostAt > o.retainMs) {
        this.events.push({ type: "left", id: tr.id! });
        return false;
      }
      return true;
    });

    // 4. Unmatched detections become candidates.
    dets.forEach((d, i) => {
      if (takenDet.has(i)) return;
      if (this.tracks.filter((tr) => tr.state === "tentative").length >= o.maxPlayers + 2) return;
      this.tracks.push({
        uid: this.nextUid++,
        id: null,
        state: "tentative",
        hits: 1,
        anchor: { ...d.anchor },
        velocity: { x: 0, y: 0 },
        scale: d.scale ?? DEFAULT_SCALE,
        refScale: d.scale ?? DEFAULT_SCALE,
        refScaleFixed: false,
        lastSeen: t,
        lostAt: 0,
        joinedAt: 0,
        person: d.person,
      });
    });

    // 5. Candidates seen often enough become (or return as) players.
    if (this.promote(t)) {
      ambiguous = true;
      reason = "reentry";
    }

    // 6. Overlapping players.
    const players = this.tracks.filter((tr) => tr.id !== null);
    const seen = players.filter((tr) => tr.state !== "lost");
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        const a = seen[i]!;
        const b = seen[j]!;
        if (dist(a.anchor, b.anchor) < o.proximity * Math.max(a.scale, b.scale)) ambiguous = true;
      }
    }

    this.updateEpisode(ambiguous, reason, t);

    return { players: this.view(), events: this.events };
  }

  /** Accept the current numbering as correct and end any uncertain episode. */
  confirm(): TrackerEvent[] {
    this.events = [];
    this.pendingOrder = null;
    if (this.episode) this.lock();
    return this.events;
  }

  /** Exchange the numbers of two players (for a "that's not me" control), then lock. */
  swap(a: PlayerId, b: PlayerId): TrackerEvent[] {
    this.events = [];
    const ta = this.tracks.find((tr) => tr.id === a);
    const tb = this.tracks.find((tr) => tr.id === b);
    if (ta && tb) this.swapTracks(ta, tb);
    this.pendingOrder = null;
    if (this.episode) this.lock();
    return this.events;
  }

  /**
   * Number the visible players left to right (smallest x = Player 1). Used by player setup.
   * Players who are currently lost give up their reservation.
   */
  assignBySide(): TrackerEvent[] {
    this.events = [];
    this.renumberBySide();
    this.sideAssigned = true;
    this.pendingOrder = null;
    this.episode = null;
    return this.events;
  }

  /** Fix a player's reference body size from calibration so it no longer drifts. */
  setReferenceScale(id: PlayerId, scale: number): void {
    const tr = this.tracks.find((x) => x.id === id);
    if (tr && scale > MIN_SCALE) {
      tr.refScale = scale;
      tr.refScaleFixed = true;
    }
  }

  get identityState(): IdentityState {
    return this.episode ? "uncertain" : "locked";
  }

  reset(): void {
    this.tracks = [];
    this.episode = null;
    this.stableOrder = [];
    this.pendingOrder = null;
    this.sideAssigned = false;
  }

  // ---------------------------------------------------------------------------------------------

  private dedupe(dets: Detection[]): Detection[] {
    // Pose models sometimes report the same person twice; keep the more confident one.
    const sorted = [...dets].sort((a, b) => b.person.score - a.person.score);
    const kept: Detection[] = [];
    for (const d of sorted) {
      const unit = Math.max(d.scale ?? DEFAULT_SCALE, MIN_SCALE);
      if (!kept.some((k) => dist(k.anchor, d.anchor) < 0.35 * unit)) kept.push(d);
    }
    return kept;
  }

  private matchCost(tr: Track, d: Detection, t: number): number {
    const o = this.options;
    const dt = Math.min(Math.max(t - tr.lastSeen, 0) / 1000, MAX_PREDICT_S);
    const predicted = { x: tr.anchor.x + tr.velocity.x * dt, y: tr.anchor.y + tr.velocity.y * dt };
    const unit = Math.max(tr.scale, d.scale ?? 0, MIN_SCALE);
    const distance = dist(predicted, d.anchor) / unit;
    if (distance > o.gateDistance) return Infinity;
    const size = d.scale ? Math.abs(Math.log(d.scale / tr.scale)) : 0;
    return distance + o.scaleWeight * size;
  }

  private applyMatch(tr: Track, d: Detection, t: number): void {
    const dt = (t - tr.lastSeen) / 1000;
    if (dt > 0) {
      const vx = (d.anchor.x - tr.anchor.x) / dt;
      const vy = (d.anchor.y - tr.anchor.y) / dt;
      tr.velocity = { x: tr.velocity.x + 0.5 * (vx - tr.velocity.x), y: tr.velocity.y + 0.5 * (vy - tr.velocity.y) };
    }
    tr.anchor = { ...d.anchor };
    if (d.scale) {
      tr.scale += 0.3 * (d.scale - tr.scale);
      // The long-term size is not updated while identity is in doubt: it is the evidence used to settle it.
      if (!tr.refScaleFixed && !this.episode) tr.refScale += 0.02 * (d.scale - tr.refScale);
    }
    tr.lastSeen = t;
    tr.person = d.person;
    if (tr.state === "tentative") tr.hits++;
    else tr.state = "tracked";
  }

  /** @returns true when a returning player could not be identified with confidence. */
  private promote(t: number): boolean {
    const o = this.options;
    let ambiguous = false;
    let ready = this.tracks.filter((tr) => tr.state === "tentative" && tr.hits >= o.confirmFrames && tr.lastSeen === t);
    if (ready.length === 0) return false;

    // Returning players first.
    const lost = this.tracks.filter((tr) => tr.state === "lost");
    if (lost.length > 0) {
      const cost = lost.map((l) =>
        ready.map((c) => {
          const unit = Math.max(l.refScale, MIN_SCALE);
          return dist(l.anchor, c.anchor) / unit + o.scaleWeight * Math.abs(Math.log(c.scale / l.refScale));
        }),
      );
      const a = bestAssignment(cost);
      if (lost.length >= 2 && a.margin < o.ambiguityMargin) ambiguous = true;
      const reattached = new Set<Track>();
      lost.forEach((l, r) => {
        const c = a.cols[r]!;
        if (c < 0) return;
        const cand = ready[c]!;
        cand.id = l.id;
        cand.state = "tracked";
        cand.refScale = l.refScale;
        cand.refScaleFixed = l.refScaleFixed;
        cand.joinedAt = l.joinedAt;
        reattached.add(cand);
        this.tracks.splice(this.tracks.indexOf(l), 1);
        this.events.push({ type: "restored", id: cand.id! });
      });
      ready = ready.filter((c) => !reattached.has(c));
      if (reattached.size > 0 && this.pendingOrder && !this.episode) {
        // Someone lost during an overlap is back: verify the order once things settle.
        this.episode = { order: this.pendingOrder, reason: "reentry", clearSince: null, needsAction: false };
        this.pendingOrder = null;
      }
    }

    // New players take free numbers, left to right.
    const usedIds = new Set(this.tracks.filter((tr) => tr.id !== null).map((tr) => tr.id!));
    const freeIds: PlayerId[] = [];
    for (let id = 1; id <= o.maxPlayers; id++) if (!usedIds.has(id)) freeIds.push(id);
    ready.sort((a, b) => a.anchor.x - b.anchor.x);
    let joined = false;
    for (const cand of ready) {
      const id = freeIds.shift();
      if (id === undefined) break; // No room: stays a bystander.
      cand.id = id;
      cand.state = "tracked";
      cand.joinedAt = t;
      joined = true;
      this.events.push({ type: "joined", id });
    }

    // Players who walk up together are numbered by side even if the model saw one a moment earlier.
    if (joined && !this.sideAssigned && !this.episode) {
      const players = this.tracks.filter((tr) => tr.id !== null);
      const together = players.every((p) => p.state === "tracked" && t - p.joinedAt <= o.pairingMs);
      if (together && players.length > 1) this.renumberBySide();
    }
    return ambiguous;
  }

  private renumberBySide(): void {
    for (const tr of this.tracks.filter((x) => x.state === "lost")) {
      this.events.push({ type: "left", id: tr.id! });
    }
    this.tracks = this.tracks.filter((tr) => tr.state !== "lost");
    const players = this.tracks.filter((tr) => tr.id !== null).sort((a, b) => a.anchor.x - b.anchor.x);
    const before = players.map((p) => p.id!);
    // Reference sizes describe bodies, so they stay with the track while the numbers change.
    players.forEach((p, i) => (p.id = i + 1));
    if (players.length === 2 && before[0] !== players[0]!.id) {
      this.events.push({ type: "swapped", ids: [1, 2] });
    }
    this.stableOrder = players.map((p) => p.id!);
  }

  private swapTracks(a: Track, b: Track): void {
    const id = a.id;
    a.id = b.id;
    b.id = id;
    // Calibrated sizes belong to the player number, so they change hands with it.
    const ref = a.refScale;
    const fixed = a.refScaleFixed;
    a.refScale = b.refScale;
    a.refScaleFixed = b.refScaleFixed;
    b.refScale = ref;
    b.refScaleFixed = fixed;
    this.events.push({ type: "swapped", ids: [a.id!, b.id!] });
  }

  private currentOrder(tracks: Track[]): PlayerId[] {
    return [...tracks].sort((a, b) => a.anchor.x - b.anchor.x).map((tr) => tr.id!);
  }

  private updateEpisode(ambiguous: boolean, reason: UncertainReason, t: number): void {
    const o = this.options;
    const players = this.tracks.filter((tr) => tr.id !== null);

    if (ambiguous) {
      if (!this.episode) {
        const order = this.stableOrder.length > 0 ? this.stableOrder : this.currentOrder(players);
        this.episode = { order: [...order], reason, clearSince: null, needsAction: false };
        this.events.push({ type: "uncertain", ids: [...order], reason, needsAction: false });
      }
      this.episode.clearSince = null;
      return;
    }

    if (!this.episode) {
      const tracked = players.filter((tr) => tr.state === "tracked");
      if (tracked.length === players.length) this.stableOrder = this.currentOrder(players);
      return;
    }

    const ep = this.episode;
    const alive = new Set(players.map((p) => p.id!));
    ep.order = ep.order.filter((id) => alive.has(id));
    const members = players.filter((p) => ep.order.includes(p.id!));

    const lostMembers = members.filter((m) => m.state === "lost");
    if (lostMembers.length > 0 && lostMembers.every((m) => t - m.lostAt > o.episodeLostTimeoutMs)) {
      // Stop holding up the remaining players, but check the order again when the others return.
      this.pendingOrder = [...ep.order];
      this.lock();
      return;
    }
    if (members.some((m) => m.state !== "tracked")) {
      ep.clearSince = null;
      return;
    }
    ep.clearSince ??= t;
    if (t - ep.clearSince < o.settleMs) return;

    // Things have settled. Decide who is who.
    if (members.length === 2) {
      const [a, b] = members as [Track, Track];
      const ratio = Math.max(a.refScale, b.refScale) / Math.min(a.refScale, b.refScale);
      if (ratio >= o.scaleDiscrimination) {
        const keep = Math.abs(Math.log(a.scale / a.refScale)) + Math.abs(Math.log(b.scale / b.refScale));
        const swapped = Math.abs(Math.log(a.scale / b.refScale)) + Math.abs(Math.log(b.scale / a.refScale));
        if (swapped + 0.1 < keep) this.swapTracks(a, b);
        this.lock();
        return;
      }
    }
    if (sameOrder(this.currentOrder(members), ep.order)) {
      this.lock();
    } else if (!ep.needsAction) {
      ep.needsAction = true;
      ep.reason = "crossed";
      this.events.push({ type: "uncertain", ids: [...ep.order], reason: "crossed", needsAction: true });
    }
  }

  private lock(): void {
    const players = this.tracks.filter((tr) => tr.id !== null);
    const ids = this.episode ? [...this.episode.order] : players.map((p) => p.id!);
    this.episode = null;
    this.stableOrder = this.currentOrder(players.filter((p) => p.state !== "lost"));
    this.events.push({ type: "locked", ids });
  }

  private view(): TrackView[] {
    const uncertain = new Set(this.episode?.order ?? []);
    return this.tracks
      .filter((tr) => tr.id !== null)
      .map((tr) => ({
        id: tr.id!,
        uid: tr.uid,
        state: tr.state as TrackState,
        identity: uncertain.has(tr.id!) ? ("uncertain" as const) : ("locked" as const),
        person: tr.person,
        anchor: { ...tr.anchor },
        scale: tr.scale,
      }))
      .sort((a, b) => a.id - b.id);
  }
}
