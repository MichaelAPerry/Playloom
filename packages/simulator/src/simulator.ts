import type { FrameSink, Keypoint, KeypointName, Point, PoseFrame, PoseSource, RawPerson, Skeleton, SourceCapabilities } from "@playloom/core";

/**
 * Simulated players.
 *
 * The simulator is an ordinary PoseSource: it produces whole skeletons for virtual people and
 * feeds them through the same identity tracker, smoothing and gesture recognition as a camera
 * would. A simulated jump is a body that actually moves up and down — nothing is injected
 * above the motion API — so anything that works here exercises the real pipeline.
 *
 * Coordinates given to and produced by the simulator are screen coordinates (already mirrored).
 */

export type Side = "left" | "right";
export type OccludedPart = "all" | "hands" | "lower";

export interface SimulatorOptions {
  players: number;
  /** Frames per second of simulated tracking. */
  hz: number;
  aspect: number;
  /** Standard deviation of keypoint noise, as a fraction of picture height. */
  noise: number;
  seed: number;
  /**
   * `manual`: time only advances when `step()` is called (tests, deterministic playback).
   * `realtime`: frames are produced on a timer using `performance.now()`.
   */
  clock: "manual" | "realtime";
}

export const DEFAULT_SIMULATOR_OPTIONS: SimulatorOptions = {
  players: 2,
  hz: 30,
  aspect: 16 / 9,
  noise: 0.0015,
  seed: 1,
  clock: "realtime",
};

interface SimPlayer {
  x: number;
  targetX: number;
  moveDir: number;
  /** Standing height as a fraction of picture height. */
  height: number;
  feetY: number;
  present: boolean;
  hands: Record<Side, Point | null>;
  handsUp: boolean;
  duckTarget: number;
  duck: number;
  leanTarget: number;
  lean: number;
  jumpStart: number | null;
  swipe: { side: Side; from: Point; to: Point; start: number } | null;
  occluded: { until: number; part: OccludedPart } | null;
}

const JUMP_MS = 450;
const JUMP_HEIGHT = 0.14; // of body height
const SWIPE_MS = 140;
const WALK_SPEED = 0.45; // picture widths per second

/** Small deterministic random generator so simulated noise is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatorSource implements PoseSource {
  readonly id = "simulator";
  readonly capabilities: SourceCapabilities;
  readonly options: SimulatorOptions;

  private players: SimPlayer[] = [];
  private sink: FrameSink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private time = 0;
  private sinceFrame = 0;
  private dropoutUntil = -Infinity;
  private shuffle = false;
  private random: () => number;

  constructor(options: Partial<SimulatorOptions> = {}) {
    this.options = { ...DEFAULT_SIMULATOR_OPTIONS, ...options };
    this.capabilities = { skeleton: true, hands: "precise", fixedRegions: false, maxPeople: this.options.players };
    this.random = mulberry32(this.options.seed);
    const n = this.options.players;
    for (let i = 0; i < n; i++) {
      const x = (i + 1) / (n + 1) + (n === 2 ? (i === 0 ? -0.03 : 0.03) : 0);
      this.players.push({
        x,
        targetX: x,
        moveDir: 0,
        height: 0.72,
        feetY: 0.96,
        present: true,
        hands: { left: null, right: null },
        handsUp: false,
        duckTarget: 0,
        duck: 0,
        leanTarget: 0,
        lean: 0,
        jumpStart: null,
        swipe: null,
        occluded: null,
      });
    }
  }

  // ---- PoseSource ---------------------------------------------------------------------------

  async start(sink: FrameSink): Promise<void> {
    this.sink = sink;
    if (this.options.clock === "realtime") {
      this.time = performance.now();
      const interval = 1000 / this.options.hz;
      this.timer = setInterval(() => {
        const now = performance.now();
        this.advance(Math.min(now - this.time, 250));
        this.time = now;
        this.emit();
      }, interval);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sink = null;
  }

  /** Manual clock only: advance simulated time, emitting frames at the configured rate. */
  step(ms: number): void {
    if (this.options.clock !== "manual") throw new Error("step() requires the manual clock");
    const interval = 1000 / this.options.hz;
    let remaining = ms;
    while (remaining > 1e-9) {
      const dt = Math.min(remaining, interval - this.sinceFrame);
      this.advance(dt);
      this.time += dt;
      this.sinceFrame += dt;
      remaining -= dt;
      if (this.sinceFrame >= interval - 1e-9) {
        this.sinceFrame = 0;
        this.emit();
      }
    }
  }

  /** Current simulated time in milliseconds. */
  get now(): number {
    return this.time;
  }

  // ---- Controls (player numbers are 1-based and refer to simulated people, not tracked ids) ---

  /** Put a hand at a screen position (0..1), or pass null to let the arm hang. */
  setHand(player: number, side: Side, position: Point | null): void {
    this.p(player).hands[side] = position ? { ...position } : null;
  }

  setHandsUp(player: number, up: boolean): void {
    this.p(player).handsUp = up;
  }

  jump(player: number): void {
    const p = this.p(player);
    if (p.jumpStart === null) p.jumpStart = this.time;
  }

  setDuck(player: number, ducking: boolean): void {
    this.p(player).duckTarget = ducking ? 1 : 0;
  }

  /** −1 = lean fully left on screen, 1 = fully right. */
  setLean(player: number, lean: number): void {
    this.p(player).leanTarget = Math.max(-1, Math.min(1, lean));
  }

  /** Walk to a horizontal screen position. */
  moveTo(player: number, x: number): void {
    this.p(player).targetX = x;
  }

  /** Keep walking left (−1) or right (1) until set back to 0. */
  setWalking(player: number, direction: number): void {
    this.p(player).moveDir = Math.sign(direction);
  }

  /** Jump instantly to a position (no walking). */
  teleport(player: number, x: number): void {
    const p = this.p(player);
    p.x = p.targetX = x;
  }

  setHeight(player: number, height: number): void {
    this.p(player).height = height;
  }

  /** A quick hand movement across about half a body height. */
  swipe(player: number, side: Side, direction: "left" | "right" | "up" | "down"): void {
    const p = this.p(player);
    const from = p.hands[side] ?? this.restHand(p, side);
    const reach = p.height * 0.45;
    const delta = {
      left: { x: -reach / this.options.aspect, y: 0 },
      right: { x: reach / this.options.aspect, y: 0 },
      up: { x: 0, y: -reach },
      down: { x: 0, y: reach },
    }[direction];
    p.swipe = { side, from, to: { x: from.x + delta.x, y: from.y + delta.y }, start: this.time };
  }

  /** Player walks out of (false) or into (true) view. */
  setPresent(player: number, present: boolean): void {
    this.p(player).present = present;
  }

  isPresent(player: number): boolean {
    return this.p(player).present;
  }

  /** Both players walk to each other's position, passing through one another. */
  cross(): void {
    const [a, b] = this.players;
    if (!a || !b) return;
    const ax = a.x;
    a.targetX = b.x;
    b.targetX = ax;
  }

  // ---- Fault injection ----------------------------------------------------------------------

  /** The backend sees nobody for a while (camera covered, model failure). */
  dropout(ms: number): void {
    this.dropoutUntil = this.time + ms;
  }

  /** Hide a player, or part of one, for a while. */
  occlude(player: number, ms: number, part: OccludedPart = "all"): void {
    this.p(player).occluded = { until: this.time + ms, part };
  }

  /** Report people in random order each frame, as real pose models may. */
  setShuffle(on: boolean): void {
    this.shuffle = on;
  }

  // ---- Internals ----------------------------------------------------------------------------

  private p(player: number): SimPlayer {
    const p = this.players[player - 1];
    if (!p) throw new Error(`Simulator has no player ${player}`);
    return p;
  }

  private advance(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.players) {
      if (p.moveDir !== 0) p.targetX = Math.max(0.05, Math.min(0.95, p.x + p.moveDir * 0.1));
      const dx = p.targetX - p.x;
      const stepX = WALK_SPEED * dt;
      p.x = Math.abs(dx) <= stepX ? p.targetX : p.x + Math.sign(dx) * stepX;
      p.duck += (p.duckTarget - p.duck) * Math.min(1, dt * 12);
      p.lean += (p.leanTarget - p.lean) * Math.min(1, dt * 10);
      if (p.jumpStart !== null && this.time + dtMs - p.jumpStart >= JUMP_MS) p.jumpStart = null;
      if (p.swipe && this.time + dtMs - p.swipe.start >= SWIPE_MS) {
        p.hands[p.swipe.side] = p.swipe.to;
        p.swipe = null;
      }
      if (p.occluded && this.time + dtMs >= p.occluded.until) p.occluded = null;
    }
  }

  private restHand(p: SimPlayer, side: Side): Point {
    const sign = side === "right" ? 1 : -1;
    const H = p.height;
    const shoulderY = p.feetY - 0.82 * H;
    return { x: p.x + (sign * 0.145 * H) / this.options.aspect, y: shoulderY + 0.36 * H };
  }

  /** Build the skeleton for one simulated person at the current time. */
  private skeleton(p: SimPlayer): Skeleton {
    const H = p.height;
    const ax = (metric: number): number => metric / this.options.aspect;
    const jumpPhase = p.jumpStart === null ? 0 : Math.min(1, (this.time - p.jumpStart) / JUMP_MS);
    const lift = 4 * jumpPhase * (1 - jumpPhase) * JUMP_HEIGHT * H;
    const up = (fraction: number, drop = 0): number => p.feetY - fraction * H - lift + drop * p.duck * H;
    const leanX = p.lean * 0.14 * H;

    const shoulderY = up(0.82, 0.22);
    const hipY = up(0.48, 0.14);
    const shoulderX = p.x + ax(leanX);
    const k: Skeleton = {};
    const put = (name: KeypointName, x: number, y: number): void => {
      k[name] = { x, y, score: 0.95 };
    };
    // Screen coordinates are mirrored, so the person's right side is on the right.
    for (const [side, sign] of [["left", -1], ["right", 1]] as const) {
      const cap = side === "left" ? "left" : "right";
      const name = (part: string): KeypointName => `${cap}${part}` as KeypointName;
      const sx = shoulderX + sign * ax(0.115 * H);
      put(name("Shoulder"), sx, shoulderY);
      put(name("Hip"), p.x + sign * ax(0.075 * H), hipY);
      put(name("Knee"), p.x + sign * ax(0.075 * H + 0.05 * H * p.duck), up(0.26, 0.04));
      put(name("Ankle"), p.x + sign * ax(0.07 * H), p.feetY - 0.04 * H - lift);
      put(name("Eye"), p.x + ax(leanX * 1.2) + sign * ax(0.02 * H), up(0.95, 0.22));
      put(name("Ear"), p.x + ax(leanX * 1.2) + sign * ax(0.04 * H), up(0.94, 0.22));

      let hand: Point;
      if (p.swipe && p.swipe.side === side) {
        const f = Math.min(1, (this.time - p.swipe.start) / SWIPE_MS);
        hand = { x: p.swipe.from.x + (p.swipe.to.x - p.swipe.from.x) * f, y: p.swipe.from.y + (p.swipe.to.y - p.swipe.from.y) * f };
      } else if (p.hands[side]) {
        hand = p.hands[side]!;
      } else if (p.handsUp) {
        hand = { x: sx + sign * ax(0.04 * H), y: shoulderY - 0.4 * H };
      } else {
        hand = { x: sx + sign * ax(0.03 * H), y: shoulderY + 0.36 * H };
      }
      const elbow = { x: (sx + hand.x) / 2 + sign * ax(0.03 * H), y: (shoulderY + hand.y) / 2 + 0.04 * H };
      put(name("Elbow"), elbow.x, elbow.y);
      put(name("Wrist"), elbow.x + (hand.x - elbow.x) * 0.8, elbow.y + (hand.y - elbow.y) * 0.8);
      put(name("Index"), hand.x, hand.y);
    }
    put("nose", p.x + ax(leanX * 1.2), up(0.93, 0.22));
    return k;
  }

  private gaussian(): number {
    // Box–Muller.
    const u = Math.max(this.random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
  }

  private emit(): void {
    if (!this.sink) return;
    const people: RawPerson[] = [];
    if (this.time >= this.dropoutUntil) {
      for (const p of this.players) {
        if (!p.present) continue;
        if (p.occluded?.part === "all") continue;
        const skeleton = this.skeleton(p);
        const noise = this.options.noise;
        for (const name in skeleton) {
          const kp = skeleton[name as KeypointName] as Keypoint;
          kp.x += (this.gaussian() * noise) / this.options.aspect;
          kp.y += this.gaussian() * noise;
          const hidden =
            (p.occluded?.part === "hands" && /Wrist|Index|Elbow/.test(name)) ||
            (p.occluded?.part === "lower" && /Hip|Knee|Ankle/.test(name));
          if (hidden) kp.score = 0.05;
        }
        people.push({ keypoints: skeleton, score: 0.9 });
      }
      if (this.shuffle && people.length > 1 && this.random() < 0.5) people.reverse();
    }
    const frame: PoseFrame = { timestamp: this.time, aspect: this.options.aspect, mirrored: true, people };
    this.sink(frame);
  }
}
