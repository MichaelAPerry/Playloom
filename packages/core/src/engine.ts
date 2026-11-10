import { Emitter } from "./events";
import { handPoint, mapSkeleton, measureBody, visible, type BodyMetrics } from "./geometry";
import {
  DEFAULT_THRESHOLDS,
  GestureRecognizer,
  noGestures,
  type GestureFlags,
  type GestureName,
  type GestureThresholds,
  type SwipeDirection,
} from "./gestures/recognizer";
import { Average, RateMeter } from "./performance/meters";
import {
  IdentityTracker,
  type Detection,
  type IdentityState,
  type TrackerEvent,
  type TrackerOptions,
  type TrackView,
  type UncertainReason,
} from "./tracking/identity";
import { DEFAULT_ONE_EURO, OneEuroFilter, type OneEuroOptions } from "./tracking/one-euro";
import type {
  KeypointName,
  PlayerId,
  Point,
  PoseFrame,
  PoseSource,
  RawPerson,
  Skeleton,
  SourceCapabilities,
  Unsubscribe,
} from "./types";

// ------------------------------------------------------------------------------------------------
// Game-facing motion API. Games, the rules runtime and Studio's preview see only what is declared
// in this section, whether the frames come from a camera, the simulator or a recording.
// ------------------------------------------------------------------------------------------------

export interface PlayerState {
  readonly id: PlayerId;
  /** False while the player cannot be seen. Their number stays reserved for a while. */
  readonly present: boolean;
  /** 0..1: how well the player's upper body is currently seen. */
  readonly confidence: number;
  /** `uncertain` means the engine is not sure this is still the same person; `lost` means not visible. */
  readonly identity: IdentityState | "lost";
  /** Hand positions on screen, 0..1 from the top-left. Undefined when the hand is not visible. */
  readonly leftHand?: Point;
  readonly rightHand?: Point;
  /** Centre of the shoulders on screen, 0..1. */
  readonly bodyPosition?: Point;
  /** −1 (leaning fully left on screen) to 1 (fully right). */
  readonly lean: number;
  readonly gestures: Readonly<GestureFlags>;
  /** Amount of movement, 0..1 (Lite mode only). */
  readonly activity?: number;
  /** Smoothed keypoints on screen, 0..1. Absent in Lite mode — games that need it must declare so. */
  readonly skeleton?: Skeleton;
}

export interface GestureEvent {
  player: PlayerId;
  gesture: GestureName;
  phase: "start" | "end";
  hand?: "left" | "right";
  direction?: SwipeDirection;
  speed?: number;
  timestamp: number;
}

export interface MotionEvents {
  gesture: GestureEvent;
  "player-joined": { player: PlayerId; timestamp: number };
  "player-left": { player: PlayerId; timestamp: number };
  "tracking-lost": { player: PlayerId; timestamp: number };
  "tracking-restored": { player: PlayerId; timestamp: number };
  /** `needsAction` is true when players must step back to their sides (or the host must confirm). */
  "identity-uncertain": { players: PlayerId[]; reason: UncertainReason; needsAction: boolean; timestamp: number };
  "identity-restored": { players: PlayerId[]; timestamp: number };
  "identity-swapped": { players: [PlayerId, PlayerId]; timestamp: number };
  "calibration-progress": { progress: number; playersSeen: number; timestamp: number };
  /** Fired after every processed tracking frame, once all player states are up to date. */
  frame: { timestamp: number };
}

export interface TrackingStatus {
  running: boolean;
  source: string | null;
  capabilities: SourceCapabilities | null;
  /** Pose frames per second delivered by the source. */
  trackingHz: number;
  /** Mean time from capture to availability in this API, milliseconds. */
  latencyMs: number;
  /** Mean engine time per frame, milliseconds. */
  processingMs: number;
  identity: IdentityState;
  /** True while players must act to restore identity. */
  needsAction: boolean;
  /** People the source reported in the latest frame, including bystanders. */
  peopleInView: number;
}

export interface MotionApi {
  readonly players: {
    get(id: PlayerId): PlayerState | undefined;
    all(): PlayerState[];
  };
  readonly events: {
    on<E extends keyof MotionEvents>(type: E, fn: (e: MotionEvents[E]) => void): Unsubscribe;
  };
  readonly status: TrackingStatus;
}

// ------------------------------------------------------------------------------------------------

export interface EngineOptions {
  maxPlayers: number;
  /** Show the picture like a mirror: moving your right hand moves the right-hand side of the screen. */
  mirror: boolean;
  /** Above 1 makes gestures easier to trigger. */
  sensitivity: number;
  thresholds: GestureThresholds;
  /** Keypoints below this confidence are treated as not visible. */
  minKeypointScore: number;
  smoothing: OneEuroOptions;
  tracker: Partial<TrackerOptions>;
  /** Clock used for latency measurement; must share a time base with frame timestamps. */
  now: () => number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  maxPlayers: 2,
  mirror: true,
  sensitivity: 1,
  thresholds: DEFAULT_THRESHOLDS,
  minKeypointScore: 0.3,
  smoothing: DEFAULT_ONE_EURO,
  tracker: {},
  now: () => performance.now(),
};

export interface PlayerCalibration {
  /** Body size as a fraction of the picture height. */
  scale: number;
  /** Standing shoulder height, 0..1. */
  shoulderY: number;
  /** Horizontal standing position on screen, 0..1. */
  x: number;
}

export interface CalibrationResult {
  players: Record<PlayerId, PlayerCalibration>;
  timestamp: number;
}

export interface CalibrationOptions {
  players: number;
  /** How long everyone must stand still. */
  durationMs: number;
  timeoutMs: number;
}

interface CalibrationRun {
  opts: CalibrationOptions;
  startedAt: number | null;
  steadySince: number | null;
  origin: Map<number, Point>;
  samples: Map<number, { scale: number[]; y: number[]; x: number[] }>;
  resolve: (r: CalibrationResult) => void;
  reject: (e: Error) => void;
}

/** Per-body state. Keyed by track uid so that it follows the physical person, not the number. */
interface Body {
  filters: Map<string, OneEuroFilter>;
  gestures: GestureRecognizer;
  last?: PlayerState;
}

const DEFAULT_ASPECT = 16 / 9;
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/**
 * The motion engine: pose frames in, stable player states and gesture events out.
 *
 *   PoseSource → mirror/aspect → identity tracker → smoothing → gestures → MotionApi
 */
export class MotionEngine {
  readonly options: EngineOptions;
  readonly api: MotionApi;

  private emitter = new Emitter<MotionEvents>();
  private tracker: IdentityTracker;
  private source: PoseSource | null = null;
  private running = false;
  private bodies = new Map<number, Body>();
  private states = new Map<PlayerId, PlayerState>();
  private regionSeen = new Map<PlayerId, number>();
  private needsAction = false;
  private peopleInView = 0;
  private aspect = DEFAULT_ASPECT;
  private rate = new RateMeter();
  private latency = new Average();
  private processing = new Average();
  private calibration: CalibrationRun | null = null;
  private lastCalibration: CalibrationResult | null = null;

  constructor(options: Partial<EngineOptions> = {}) {
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...options };
    this.tracker = new IdentityTracker({ maxPlayers: this.options.maxPlayers, ...this.options.tracker });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    this.api = {
      players: {
        get: (id) => this.states.get(id),
        all: () => [...this.states.values()].sort((a, b) => a.id - b.id),
      },
      events: { on: (type, fn) => this.emitter.on(type, fn) },
      get status(): TrackingStatus {
        return engine.status();
      },
    };
  }

  /** Choose where frames come from. Stops the previous source if one was running. */
  async attach(source: PoseSource): Promise<void> {
    const wasRunning = this.running;
    await this.stop();
    this.source = source;
    this.resetTracking();
    if (wasRunning) await this.start();
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.source) throw new Error("MotionEngine.start: no pose source attached");
    this.running = true;
    try {
      await this.source.start((frame) => this.process(frame));
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.source) return;
    this.running = false;
    await this.source.stop();
  }

  /** Change mirror, sensitivity or gesture thresholds while running. */
  configure(patch: Partial<Pick<EngineOptions, "mirror" | "sensitivity" | "thresholds">>): void {
    const mirrorChanged = patch.mirror !== undefined && patch.mirror !== this.options.mirror;
    Object.assign(this.options, patch);
    for (const body of this.bodies.values()) {
      body.gestures.sensitivity = this.options.sensitivity;
      body.gestures.thresholds = this.options.thresholds;
    }
    // Flipping the picture moves everyone to the other side, so previous tracking no longer applies.
    if (mirrorChanged) this.resetTracking();
  }

  /**
   * Player setup. Resolves once the requested number of players have stood still for
   * `durationMs`; they are then numbered left to right and their size and standing height
   * recorded. Rejects if that does not happen within `timeoutMs`.
   */
  calibrate(options: Partial<CalibrationOptions> = {}): Promise<CalibrationResult> {
    this.calibration?.reject(new Error("Calibration restarted"));
    const opts: CalibrationOptions = { players: this.options.maxPlayers, durationMs: 1500, timeoutMs: 30_000, ...options };
    return new Promise((resolve, reject) => {
      this.calibration = { opts, startedAt: null, steadySince: null, origin: new Map(), samples: new Map(), resolve, reject };
    });
  }

  cancelCalibration(): void {
    this.calibration?.reject(new Error("Calibration cancelled"));
    this.calibration = null;
  }

  get calibrationResult(): CalibrationResult | null {
    return this.lastCalibration;
  }

  /** Accept the current player numbering and clear an identity warning. */
  confirmIdentities(): void {
    this.handleTrackerEvents(this.tracker.confirm(), this.options.now());
  }

  /** Exchange Player 1 and Player 2 (or any two players). */
  swapPlayers(a: PlayerId = 1, b: PlayerId = 2): void {
    this.handleTrackerEvents(this.tracker.swap(a, b), this.options.now());
    const sa = this.states.get(a);
    const sb = this.states.get(b);
    if (sa) this.states.set(b, { ...sa, id: b });
    else this.states.delete(b);
    if (sb) this.states.set(a, { ...sb, id: a });
    else this.states.delete(a);
  }

  /** Feed a frame directly. Sources call this through the sink given to `start`; tests may call it too. */
  process(frame: PoseFrame): void {
    const began = this.options.now();
    const t = frame.timestamp;
    this.aspect = frame.aspect ?? DEFAULT_ASPECT;
    const flip = this.options.mirror !== (frame.mirrored ?? false);
    this.peopleInView = frame.people.length;

    // Work in aspect-corrected units (x in 0..aspect) so distances mean the same in both directions.
    const toMetric = (p: Point): Point => ({ x: (flip ? 1 - p.x : p.x) * this.aspect, y: p.y });
    const people: RawPerson[] = frame.people.map((person) => ({
      ...person,
      keypoints: mapSkeleton(person.keypoints, (k) => ({ ...toMetric(k), score: k.score })),
      anchor: person.anchor ? toMetric(person.anchor) : undefined,
    }));

    const fixed = this.source?.capabilities.fixedRegions ?? false;
    const views = fixed ? this.assignByRegion(people, t) : this.assignByTracking(people, t);

    const gestureEvents: GestureEvent[] = [];
    const liveUids = new Set<number>();
    const liveIds = new Set<PlayerId>();
    for (const view of views) {
      liveUids.add(view.uid);
      liveIds.add(view.id);
      this.states.set(view.id, this.updatePlayer(view, t, gestureEvents));
    }
    for (const uid of [...this.bodies.keys()]) if (!liveUids.has(uid)) this.bodies.delete(uid);
    for (const id of [...this.states.keys()]) if (!liveIds.has(id)) this.states.delete(id);

    this.stepCalibration(views, t);

    for (const e of gestureEvents) this.emitter.emit("gesture", e);

    this.rate.tick(t);
    const now = this.options.now();
    this.latency.add(Math.max(0, now - t));
    this.processing.add(now - began);
    this.emitter.emit("frame", { timestamp: t });
  }

  // ---------------------------------------------------------------------------------------------

  private status(): TrackingStatus {
    return {
      running: this.running,
      source: this.source?.id ?? null,
      capabilities: this.source?.capabilities ?? null,
      trackingHz: this.rate.rate(),
      latencyMs: this.latency.get(),
      processingMs: this.processing.get(),
      identity: this.tracker.identityState,
      needsAction: this.needsAction,
      peopleInView: this.peopleInView,
    };
  }

  private resetTracking(): void {
    this.tracker.reset();
    this.bodies.clear();
    this.states.clear();
    this.regionSeen.clear();
    this.needsAction = false;
    this.rate.reset();
    this.latency.reset();
    this.processing.reset();
  }

  private assignByTracking(people: RawPerson[], t: number): TrackView[] {
    const detections: Detection[] = [];
    for (const person of people) {
      const body = measureBody(person, this.options.minKeypointScore);
      if (body) detections.push({ person, anchor: body.anchor, scale: body.scale });
    }
    const out = this.tracker.update(detections, t);
    this.handleTrackerEvents(out.events, t);
    return out.players;
  }

  /**
   * Lite mode: the backend cannot tell people apart, so the player is whoever is in that half of
   * the screen. Player 1 is the left half.
   */
  private assignByRegion(people: RawPerson[], t: number): TrackView[] {
    const coastMs = this.tracker.options.coastMs;
    const best = new Map<PlayerId, RawPerson>();
    for (const person of people) {
      if (!person.anchor) continue;
      const id = Math.min(this.options.maxPlayers, 1 + Math.floor((person.anchor.x / this.aspect) * this.options.maxPlayers));
      const current = best.get(id);
      if (!current || person.score > current.score) best.set(id, person);
    }
    const views: TrackView[] = [];
    for (let id = 1; id <= this.options.maxPlayers; id++) {
      const person = best.get(id);
      const lastSeen = this.regionSeen.get(id);
      if (person) {
        if (lastSeen === undefined) this.emitter.emit("player-joined", { player: id, timestamp: t });
        this.regionSeen.set(id, t);
        views.push({ id, uid: id, state: "tracked", identity: "locked", person, anchor: person.anchor!, scale: 0.2 });
      } else if (lastSeen !== undefined) {
        if (t - lastSeen > coastMs) {
          this.regionSeen.delete(id);
          this.emitter.emit("player-left", { player: id, timestamp: t });
        } else {
          const previous = this.states.get(id);
          const anchor = previous?.bodyPosition
            ? { x: previous.bodyPosition.x * this.aspect, y: previous.bodyPosition.y }
            : { x: 0, y: 0 };
          views.push({ id, uid: id, state: "coasting", identity: "locked", anchor, scale: 0.2 });
        }
      }
    }
    return views;
  }

  private handleTrackerEvents(events: TrackerEvent[], t: number): void {
    for (const e of events) {
      switch (e.type) {
        case "joined":
          this.emitter.emit("player-joined", { player: e.id, timestamp: t });
          break;
        case "left":
          this.emitter.emit("player-left", { player: e.id, timestamp: t });
          break;
        case "lost":
          this.emitter.emit("tracking-lost", { player: e.id, timestamp: t });
          break;
        case "restored":
          this.emitter.emit("tracking-restored", { player: e.id, timestamp: t });
          break;
        case "swapped":
          this.emitter.emit("identity-swapped", { players: e.ids, timestamp: t });
          break;
        case "uncertain":
          this.needsAction = e.needsAction;
          this.emitter.emit("identity-uncertain", {
            players: e.ids,
            reason: e.reason,
            needsAction: e.needsAction,
            timestamp: t,
          });
          break;
        case "locked":
          this.needsAction = false;
          this.emitter.emit("identity-restored", { players: e.ids, timestamp: t });
          break;
      }
    }
  }

  private body(uid: number): Body {
    let body = this.bodies.get(uid);
    if (!body) {
      body = {
        filters: new Map(),
        gestures: new GestureRecognizer(this.options.thresholds, this.options.sensitivity, this.options.minKeypointScore),
      };
      this.bodies.set(uid, body);
    }
    return body;
  }

  private smooth(body: Body, skeleton: Skeleton, t: number): Skeleton {
    const out: Skeleton = {};
    const present = new Set<string>();
    for (const name in skeleton) {
      const k = skeleton[name as KeypointName]!;
      if (k.score < this.options.minKeypointScore) continue;
      present.add(name);
      let fx = body.filters.get(name + ".x");
      let fy = body.filters.get(name + ".y");
      if (!fx || !fy) {
        fx = new OneEuroFilter(this.options.smoothing);
        fy = new OneEuroFilter(this.options.smoothing);
        body.filters.set(name + ".x", fx);
        body.filters.set(name + ".y", fy);
      }
      // Filter in units of picture height so the tuning does not depend on resolution.
      out[name as KeypointName] = { x: fx.filter(k.x, t), y: fy.filter(k.y, t), score: k.score };
    }
    return out;
  }

  private updatePlayer(view: TrackView, t: number, gestureEvents: GestureEvent[]): PlayerState {
    const body = this.body(view.uid);
    const toScreen = (p: Point): Point => ({ x: p.x / this.aspect, y: p.y });
    const pushGestures = (occ: ReturnType<GestureRecognizer["release"]>): void => {
      for (const o of occ) gestureEvents.push({ player: view.id, timestamp: t, ...o });
    };

    if (view.state === "lost") {
      pushGestures(body.gestures.release());
      body.filters.clear();
      const state: PlayerState = { id: view.id, present: false, confidence: 0, identity: "lost", lean: 0, gestures: noGestures() };
      body.last = state;
      return state;
    }

    if (!view.person) {
      // Briefly unseen: hold the last known pose rather than flickering.
      const last = body.last;
      const state: PlayerState = last
        ? { ...last, id: view.id, identity: view.identity, confidence: last.confidence * 0.8 }
        : { id: view.id, present: true, confidence: 0, identity: view.identity, lean: 0, gestures: noGestures() };
      body.last = state;
      return state;
    }

    const min = this.options.minKeypointScore;
    const skeleton = this.smooth(body, view.person.keypoints, t);
    const metrics: BodyMetrics = measureBody({ ...view.person, keypoints: skeleton }, min) ?? { anchor: view.anchor, scale: null };
    const result = body.gestures.update(skeleton, metrics, t);
    pushGestures(result.occurrences);

    const left = handPoint(skeleton, "left", min);
    const right = handPoint(skeleton, "right", min);
    const hasSkeleton = this.source?.capabilities.skeleton ?? true;
    const confidenceParts = (["leftShoulder", "rightShoulder", "leftWrist", "rightWrist"] as const).map(
      (n) => visible(skeleton, n, min)?.score ?? 0,
    );
    const confidence = hasSkeleton
      ? confidenceParts.reduce((a, b) => a + b, 0) / confidenceParts.length
      : view.person.score;

    const state: PlayerState = {
      id: view.id,
      present: true,
      confidence,
      identity: view.identity,
      leftHand: left ? toScreen(left) : undefined,
      rightHand: right ? toScreen(right) : undefined,
      bodyPosition: toScreen(metrics.anchor),
      lean: result.lean,
      gestures: result.flags,
      activity: view.person.activity,
      skeleton: hasSkeleton ? mapSkeleton(skeleton, (k) => ({ ...toScreen(k), score: k.score })) : undefined,
    };
    body.last = state;
    return state;
  }

  private stepCalibration(views: TrackView[], t: number): void {
    const run = this.calibration;
    if (!run) return;
    run.startedAt ??= t;
    if (t - run.startedAt > run.opts.timeoutMs) {
      this.calibration = null;
      run.reject(new Error(`Calibration timed out: ${run.opts.players} player(s) were not seen standing still`));
      return;
    }
    const tracked = views.filter((v) => v.state === "tracked" && v.person);
    const restart = (): void => {
      run.steadySince = null;
      run.origin.clear();
      run.samples.clear();
    };

    if (tracked.length !== run.opts.players) {
      restart();
    } else {
      for (const v of tracked) {
        const origin = run.origin.get(v.uid);
        if (run.steadySince !== null && !origin) {
          restart();
          break;
        }
        if (origin && Math.hypot(v.anchor.x - origin.x, v.anchor.y - origin.y) > 0.25 * v.scale) {
          restart();
          break;
        }
      }
      if (run.steadySince === null) {
        run.steadySince = t;
        for (const v of tracked) run.origin.set(v.uid, { ...v.anchor });
      }
      for (const v of tracked) {
        let s = run.samples.get(v.uid);
        if (!s) run.samples.set(v.uid, (s = { scale: [], y: [], x: [] }));
        s.scale.push(v.scale);
        s.y.push(v.anchor.y);
        s.x.push(v.anchor.x / this.aspect);
      }
    }

    const progress = run.steadySince === null ? 0 : Math.min(1, (t - run.steadySince) / run.opts.durationMs);
    this.emitter.emit("calibration-progress", { progress, playersSeen: tracked.length, timestamp: t });
    if (progress < 1) return;

    // Everyone stood still long enough: number left to right and record sizes.
    this.calibration = null;
    const fixed = this.source?.capabilities.fixedRegions ?? false;
    if (!fixed) this.handleTrackerEvents(this.tracker.assignBySide(), t);
    const ordered = [...tracked].sort((a, b) => a.anchor.x - b.anchor.x);
    const result: CalibrationResult = { players: {}, timestamp: t };
    ordered.forEach((v, i) => {
      const id = fixed ? v.id : i + 1;
      const s = run.samples.get(v.uid)!;
      const calibration: PlayerCalibration = { scale: median(s.scale), shoulderY: median(s.y), x: median(s.x) };
      result.players[id] = calibration;
      if (!fixed) this.tracker.setReferenceScale(id, calibration.scale);
      this.body(v.uid).gestures.setBaseline(calibration.shoulderY);
      const previous = this.states.get(v.id);
      if (previous && previous.id !== id) this.states.delete(v.id);
    });
    // Player numbers may have changed; rebuild the public states under their new numbers.
    if (!fixed) {
      const byUid = new Map(ordered.map((v, i) => [v.uid, i + 1]));
      const rebuilt = new Map<PlayerId, PlayerState>();
      for (const [uid, id] of byUid) {
        const last = this.bodies.get(uid)?.last;
        if (last) rebuilt.set(id, { ...last, id, identity: "locked" });
      }
      this.states = rebuilt;
    }
    this.lastCalibration = result;
    run.resolve(result);
  }
}
