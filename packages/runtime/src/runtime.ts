import type { GestureEvent, MotionApi, Unsubscribe } from "@playloom/core";
import {
  LIMITS,
  type Action,
  type Condition,
  type GameDefinition,
  type ObjectDef,
  type ObjectRef,
  type PlayerRef,
  type PropertyName,
  type Rule,
  type SceneDef,
  type SoundId,
  type Trigger,
  type Value,
} from "@playloom/sdk";

/**
 * The Playloom game runtime: an interpreter for game definitions.
 *
 * It knows nothing about any particular game. Everything a game does is expressed in its
 * definition, and the same interpreter runs bundled games, community games and Studio previews.
 * Input comes only through the motion API, so a game behaves identically with a camera, the
 * simulator or a recording.
 *
 * The runtime is advanced explicitly with `update(seconds)`, never by its own timers, which keeps
 * it deterministic and testable.
 */

export interface LiveObject {
  id: string;
  type: "sprite" | "text" | "timer";
  /** Set for objects created by a `spawn` action. */
  template?: string;
  x: number;
  y: number;
  layer: number;
  visible: boolean;
  tags: Set<string>;
  // sprite
  width: number;
  height: number;
  shape: "circle" | "rect" | "star" | "diamond";
  color: string;
  /** Asset id of the picture drawn for this sprite, or "" for the plain shape. */
  image: string;
  glyph: string;
  rotation: number;
  vx: number;
  vy: number;
  gravity: number;
  spin: number;
  collider: { shape: "circle"; radius: number } | { shape: "rect"; width: number; height: number };
  // text
  text: string;
  size: number;
  align: "left" | "center" | "right";
  // timer
  seconds: number;
  remaining: number;
  running: boolean;
  /** Scene time at which a temporarily shown object hides again. */
  hideAt: number | null;
  /** Has been inside the scene at least once (so spawning off-screen is not "leaving"). */
  entered: boolean;
}

export interface Effect {
  kind: "burst";
  x: number;
  y: number;
  color: string;
  radius: number;
  /** Seconds since it began. */
  age: number;
  seed: number;
}

export interface HandCursor {
  player: number;
  hand: "left" | "right";
  x: number;
  y: number;
}

export type GameResult =
  | { kind: "winner"; player: number }
  | { kind: "tie"; players: number[] }
  | { kind: "team"; won: boolean };

export type RuntimeState = "ready" | "playing" | "paused" | "ended";
export type PauseReason = "user" | "identity" | "players";

export interface AudioPlayer {
  play(sound: SoundId): void;
}

export interface RuntimeOptions {
  /** Returns a number in [0, 1). Supply a seeded generator for repeatable runs. */
  random?: () => number;
  audio?: AudioPlayer;
}

interface Scope {
  player?: number;
  object?: LiveObject;
  other?: LiveObject;
}

interface HandState {
  x: number;
  y: number;
  speed: number;
  touching: Set<string>;
}

export const EFFECT_SECONDS = 0.45;
const HAND_RADIUS = 0.035; // of scene height
const MAX_DT = 0.1;

const num = (v: number): number => (Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : 0);

export class GameRuntime {
  readonly game: GameDefinition;
  state: RuntimeState = "ready";
  pauseReason: PauseReason | null = null;
  result: GameResult | null = null;
  /** Seconds of play in the current scene. */
  time = 0;
  scene!: SceneDef;
  objects: LiveObject[] = [];
  effects: Effect[] = [];
  readonly scores = new Map<number, number>();
  readonly variables = new Map<string, number>();

  private motion: MotionApi;
  private random: () => number;
  private audio: AudioPlayer | null;
  private unsubscribe: Unsubscribe | null = null;
  private gestureQueue: GestureEvent[] = [];
  private hands = new Map<string, HandState>();
  private nextEvery = new Map<Rule, number>();
  private wasTrue = new Map<Rule, boolean>();
  private colliding = new Set<string>();
  private spawnCount = 0;
  private userPaused = false;
  private sceneChanged = false;
  private listeners = new Set<(state: RuntimeState) => void>();

  constructor(game: GameDefinition, motion: MotionApi, options: RuntimeOptions = {}) {
    this.game = game;
    this.motion = motion;
    this.random = options.random ?? Math.random;
    this.audio = options.audio ?? null;
    this.reset();
  }

  // ---- Lifecycle ------------------------------------------------------------------------------

  /** Begin (or restart) the game from its first scene. */
  start(): void {
    this.reset();
    this.unsubscribe?.();
    this.unsubscribe = this.motion.events.on("gesture", (e) => {
      if (this.state === "playing" && this.gestureQueue.length < 100) this.gestureQueue.push(e);
    });
    this.setState("playing");
    this.loadScene(this.game.startScene);
  }

  pause(): void {
    this.userPaused = true;
  }

  resume(): void {
    this.userPaused = false;
  }

  /** Stop listening to motion events. Call when leaving the game. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.state !== "ended") this.setState("ready");
  }

  onStateChange(fn: (state: RuntimeState) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Advance the game. Call once per rendered frame with the elapsed time in seconds. */
  update(seconds: number): void {
    if (this.state !== "playing" && this.state !== "paused") return;

    // The game pauses itself rather than let the wrong person score.
    const present = this.motion.players.all().filter((p) => p.present && p.id <= this.game.requires.players.max).length;
    const reason: PauseReason | null = this.userPaused
      ? "user"
      : this.motion.status.needsAction
        ? "identity"
        : present < this.game.requires.players.min
          ? "players"
          : null;
    this.pauseReason = reason;
    if (reason) {
      this.setState("paused");
      this.gestureQueue = [];
      this.hands.clear();
      return;
    }
    this.setState("playing");

    const dt = Math.min(Math.max(seconds, 0), MAX_DT);
    this.time += dt;
    this.sceneChanged = false;
    const rules = this.scene.rules;
    const each = (type: Trigger["type"], fn: (rule: Rule) => void): void => {
      for (const rule of rules) {
        if (this.sceneChanged || this.state !== "playing") return;
        if (rule.when.type === type) fn(rule);
      }
    };

    // Gestures
    const gestures = this.gestureQueue;
    this.gestureQueue = [];
    for (const e of gestures) {
      if (e.phase !== "start" || e.player > this.game.requires.players.max) continue;
      each("gesture", (rule) => {
        const w = rule.when as Extract<Trigger, { type: "gesture" }>;
        if (w.gesture === e.gesture && (w.player === "any" || w.player === e.player)) this.fire(rule, { player: e.player });
      });
    }

    // Timers
    for (const o of [...this.objects]) {
      if (o.type !== "timer" || !o.running) continue;
      o.remaining -= dt;
      if (o.remaining <= 0) {
        o.remaining = 0;
        o.running = false;
        each("timer-ends", (rule) => {
          if ((rule.when as Extract<Trigger, { type: "timer-ends" }>).timer === o.id) this.fire(rule, {});
        });
      }
    }

    // Repeating triggers
    each("every", (rule) => {
      const w = rule.when as Extract<Trigger, { type: "every" }>;
      let next = this.nextEvery.get(rule) ?? w.seconds;
      let guard = 0;
      while (this.time >= next && guard++ < 5 && !this.sceneChanged) {
        this.fire(rule, {});
        next += Math.max(0.05, w.seconds + (w.jitter ? (this.random() * 2 - 1) * w.jitter : 0));
      }
      this.nextEvery.set(rule, next);
    });
    if (this.sceneChanged || this.state !== "playing") return;

    // Temporary visibility and movement
    const [W, H] = this.scene.size;
    for (const o of this.objects) {
      if (o.hideAt !== null && this.time >= o.hideAt) {
        o.visible = false;
        o.hideAt = null;
      }
      if (o.type !== "sprite") continue;
      o.vy += o.gravity * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.rotation += o.spin * dt;
    }

    // Leaving the scene
    for (const o of [...this.objects]) {
      if (o.type !== "sprite") continue;
      const mx = o.width / 2;
      const my = o.height / 2;
      const outside = o.x < -mx || o.x > W + mx || o.y < -my || o.y > H + my;
      if (!outside) {
        o.entered = true;
        continue;
      }
      // Something thrown up from below the scene has not "left" until it has been in.
      const movingAway = (o.x < -mx && o.vx <= 0) || (o.x > W + mx && o.vx >= 0) || (o.y < -my && o.vy <= 0) || (o.y > H + my && o.vy >= 0);
      if (!o.entered && !movingAway) continue;
      if (!o.entered && !o.template) continue;
      each("leaves-scene", (rule) => {
        if (this.matches((rule.when as Extract<Trigger, { type: "leaves-scene" }>).object, o)) this.fire(rule, { object: o });
      });
      if (o.template) this.remove(o);
      else o.entered = false;
    }
    if (this.sceneChanged || this.state !== "playing") return;

    this.updateHands(dt, W, H, each);
    if (this.sceneChanged || this.state !== "playing") return;

    // Collisions between objects
    if (rules.some((r) => r.when.type === "collision")) {
      const sprites = this.objects.filter((o) => o.type === "sprite" && o.visible);
      const now = new Set<string>();
      for (const rule of rules) {
        if (rule.when.type !== "collision") continue;
        const w = rule.when;
        for (const a of sprites) {
          if (!this.matches(w.a, a)) continue;
          for (const b of sprites) {
            if (a === b || !this.matches(w.b, b) || !overlaps(a, b)) continue;
            const key = `${rules.indexOf(rule)}|${a.id}|${b.id}`;
            now.add(key);
            if (!this.colliding.has(key)) this.fire(rule, { object: a, other: b });
            if (this.sceneChanged || this.state !== "playing") return;
          }
        }
      }
      this.colliding = now;
    }

    // Conditions that have just become true
    each("when-true", (rule) => {
      const value = this.test((rule.when as Extract<Trigger, { type: "when-true" }>).condition, {});
      if (value && !this.wasTrue.get(rule)) this.fire(rule, {});
      this.wasTrue.set(rule, value);
    });

    for (const e of this.effects) e.age += dt;
    this.effects = this.effects.filter((e) => e.age < EFFECT_SECONDS);
  }

  // ---- Read-only views for renderers and hosts ---------------------------------------------------

  /** Hand positions in scene units, for drawing cursors. */
  cursors(): HandCursor[] {
    const [W, H] = this.scene.size;
    const out: HandCursor[] = [];
    for (const p of this.motion.players.all()) {
      if (!p.present || p.id > this.game.requires.players.max) continue;
      if (p.leftHand) out.push({ player: p.id, hand: "left", x: p.leftHand.x * W, y: p.leftHand.y * H });
      if (p.rightHand) out.push({ player: p.id, hand: "right", x: p.rightHand.x * W, y: p.rightHand.y * H });
    }
    return out;
  }

  score(player: number): number {
    return this.scores.get(player) ?? 0;
  }

  totalScore(): number {
    let total = 0;
    for (const v of this.scores.values()) total += v;
    return total;
  }

  /** Fill in `{score:1}`, `{score:total}`, `{var:name}` and `{timer:id}` in a text object's text. */
  formatText(text: string): string {
    return text.replace(/\{(score|var|timer):([A-Za-z0-9_.-]+)\}/g, (whole, kind: string, key: string) => {
      if (kind === "score") return String(Math.round(key === "total" ? this.totalScore() : this.score(Number(key))));
      if (kind === "var") return this.variables.has(key) ? String(Math.round(this.variables.get(key)!)) : whole;
      const timer = this.objects.find((o) => o.id === key && o.type === "timer");
      return timer ? String(Math.ceil(timer.remaining)) : whole;
    });
  }

  // ---- Internals --------------------------------------------------------------------------------

  private reset(): void {
    this.result = null;
    this.pauseReason = null;
    this.userPaused = false;
    this.scores.clear();
    for (let p = 1; p <= this.game.requires.players.max; p++) this.scores.set(p, 0);
    this.variables.clear();
    for (const v of this.game.variables ?? []) this.variables.set(v.id, v.initial);
    this.scene = this.game.scenes.find((s) => s.id === this.game.startScene) ?? this.game.scenes[0]!;
    this.objects = [];
    this.effects = [];
    this.time = 0;
  }

  private setState(state: RuntimeState): void {
    if (this.state === state) return;
    this.state = state;
    for (const fn of [...this.listeners]) fn(state);
  }

  private loadScene(id: string): void {
    const scene = this.game.scenes.find((s) => s.id === id);
    if (!scene) return;
    this.scene = scene;
    this.time = 0;
    this.objects = scene.objects.map((def) => instantiate(def, def.id));
    this.effects = [];
    this.hands.clear();
    this.nextEvery.clear();
    this.wasTrue.clear();
    this.colliding.clear();
    this.gestureQueue = [];
    this.sceneChanged = true;
    for (const rule of scene.rules) {
      if (this.state !== "playing" || this.scene !== scene) break;
      if (rule.when.type === "scene-start") this.fire(rule, {});
    }
  }

  private updateHands(dt: number, W: number, H: number, each: (type: Trigger["type"], fn: (rule: Rule) => void) => void): void {
    const radius = HAND_RADIUS * H;
    const seen = new Set<string>();
    for (const cursor of this.cursors()) {
      const key = `${cursor.player}:${cursor.hand}`;
      seen.add(key);
      let hand = this.hands.get(key);
      if (!hand) {
        this.hands.set(key, (hand = { x: cursor.x, y: cursor.y, speed: 0, touching: new Set() }));
      } else {
        hand.speed = dt > 0 ? Math.hypot(cursor.x - hand.x, cursor.y - hand.y) / dt : 0;
        hand.x = cursor.x;
        hand.y = cursor.y;
      }
      const touching = new Set<string>();
      for (const o of [...this.objects]) {
        if (o.type !== "sprite" || !o.visible || !contains(o, hand.x, hand.y, radius)) continue;
        touching.add(o.id);
        if (hand.touching.has(o.id)) continue;
        const h = hand;
        each("hand-touches", (rule) => {
          const w = rule.when as Extract<Trigger, { type: "hand-touches" }>;
          if (w.player !== "any" && w.player !== cursor.player) return;
          if (w.hand && w.hand !== "any" && w.hand !== cursor.hand) return;
          if (w.minSpeed !== undefined && h.speed < w.minSpeed) return;
          if (!o.visible || !this.objects.includes(o) || !this.matches(w.object, o)) return;
          this.fire(rule, { player: cursor.player, object: o });
        });
        if (this.sceneChanged || this.state !== "playing") return;
      }
      hand.touching = touching;
    }
    for (const key of [...this.hands.keys()]) if (!seen.has(key)) this.hands.delete(key);
  }

  private matches(ref: ObjectRef, o: LiveObject): boolean {
    if (typeof ref === "string") return ref === o.id;
    if ("tag" in ref) return o.tags.has(ref.tag);
    return o.tags.has(ref.random.tag);
  }

  private resolve(ref: ObjectRef, scope: Scope): LiveObject[] {
    if (typeof ref === "string") {
      if (ref === "$object") return scope.object && this.objects.includes(scope.object) ? [scope.object] : [];
      if (ref === "$other") return scope.other && this.objects.includes(scope.other) ? [scope.other] : [];
      const found = this.objects.find((o) => o.id === ref);
      return found ? [found] : [];
    }
    if ("tag" in ref) return this.objects.filter((o) => o.tags.has(ref.tag));
    const { tag, state } = ref.random;
    const pool = this.objects.filter((o) => o.tags.has(tag) && (!state || o.visible === (state === "visible")));
    if (pool.length === 0) return [];
    return [pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]!];
  }

  private player(ref: PlayerRef, scope: Scope): number | null {
    if (ref === "$player") return scope.player ?? null;
    return ref;
  }

  private value(v: Value, scope: Scope): number {
    if (typeof v === "number") return v;
    if ("var" in v) return this.variables.get(v.var) ?? 0;
    if ("score" in v) {
      if (v.score === "total") return this.totalScore();
      const p = this.player(v.score, scope);
      return p === null ? 0 : this.score(p);
    }
    if ("timer" in v) return this.objects.find((o) => o.id === v.timer && o.type === "timer")?.remaining ?? 0;
    if ("random" in v) return v.random[0] + this.random() * (v.random[1] - v.random[0]);
    if ("prop" in v) {
      const target = this.resolve(v.prop[0], scope)[0];
      return target ? num(target[v.prop[1]]) : 0;
    }
    const a = this.value(v.args[0], scope);
    const b = this.value(v.args[1], scope);
    switch (v.op) {
      case "+": return num(a + b);
      case "-": return num(a - b);
      case "*": return num(a * b);
      case "/": return b === 0 ? 0 : num(a / b);
      case "min": return Math.min(a, b);
      case "max": return Math.max(a, b);
    }
  }

  private test(c: Condition, scope: Scope): boolean {
    switch (c.type) {
      case "all": return c.of.every((x) => this.test(x, scope));
      case "any": return c.of.some((x) => this.test(x, scope));
      case "not": return !this.test(c.condition, scope);
      case "compare": {
        const a = this.value(c.left, scope);
        const b = this.value(c.right, scope);
        switch (c.op) {
          case "==": return a === b;
          case "!=": return a !== b;
          case "<": return a < b;
          case "<=": return a <= b;
          case ">": return a > b;
          case ">=": return a >= b;
        }
      }
    }
  }

  private fire(rule: Rule, scope: Scope): void {
    if (rule.if && !rule.if.every((c) => this.test(c, scope))) return;
    const scene = this.scene;
    for (const action of rule.then) {
      if (this.state !== "playing" || this.scene !== scene) return;
      this.run(action, scope);
    }
  }

  private remove(o: LiveObject): void {
    const i = this.objects.indexOf(o);
    if (i >= 0) this.objects.splice(i, 1);
  }

  private run(a: Action, scope: Scope): void {
    switch (a.do) {
      case "add-score": {
        const amount = this.value(a.amount, scope);
        const targets = a.player === "all" ? [...this.scores.keys()] : [this.player(a.player, scope)];
        for (const p of targets) if (p !== null && this.scores.has(p)) this.scores.set(p, num(this.score(p) + amount));
        break;
      }
      case "set-variable":
        if (this.variables.has(a.variable)) this.variables.set(a.variable, this.value(a.value, scope));
        break;
      case "change-variable":
        if (this.variables.has(a.variable)) this.variables.set(a.variable, num(this.variables.get(a.variable)! + this.value(a.by, scope)));
        break;
      case "play-sound":
        this.audio?.play(a.sound);
        break;
      case "spawn": {
        if (this.objects.length >= LIMITS.liveObjects) break;
        const template = this.scene.templates?.find((t) => t.id === a.template);
        if (!template) break;
        const o = instantiate(template, `${template.id}#${++this.spawnCount}`);
        o.template = template.id;
        o.x = this.value(a.x, scope);
        o.y = this.value(a.y, scope);
        if (a.vx !== undefined) o.vx = this.value(a.vx, scope);
        if (a.vy !== undefined) o.vy = this.value(a.vy, scope);
        this.objects.push(o);
        break;
      }
      case "destroy":
        for (const o of this.resolve(a.object, scope)) {
          // Objects placed in the scene are hidden rather than deleted, so rules can still refer to them.
          if (o.template) this.remove(o);
          else o.visible = false;
        }
        break;
      case "show":
        for (const o of this.resolve(a.object, scope)) {
          o.visible = true;
          o.hideAt = a.forSeconds === undefined ? null : this.time + a.forSeconds;
        }
        break;
      case "hide":
        for (const o of this.resolve(a.object, scope)) {
          o.visible = false;
          o.hideAt = null;
        }
        break;
      case "set-property": {
        const value = this.value(a.value, scope);
        for (const o of this.resolve(a.object, scope)) (o as Record<PropertyName, number>)[a.property] = value;
        break;
      }
      case "set-text":
        for (const o of this.resolve(a.object, scope)) if (o.type === "text") o.text = a.text;
        break;
      case "effect":
        for (const o of this.resolve(a.object, scope)) {
          if (this.effects.length >= 60) break;
          this.effects.push({ kind: "burst", x: o.x, y: o.y, color: o.color, radius: Math.max(o.width, o.height) / 2, age: 0, seed: this.random() });
        }
        break;
      case "start-timer":
      case "stop-timer": {
        const timer = this.objects.find((o) => o.id === a.timer && o.type === "timer");
        if (!timer) break;
        if (a.do === "start-timer") {
          timer.remaining = timer.seconds;
          timer.running = true;
        } else timer.running = false;
        break;
      }
      case "go-to-scene":
        this.loadScene(a.scene);
        break;
      case "end-game": {
        if (a.result === "highest-score") {
          const best = Math.max(...this.scores.values());
          const leaders = [...this.scores.entries()].filter(([, s]) => s === best).map(([p]) => p);
          this.result = leaders.length === 1 ? { kind: "winner", player: leaders[0]! } : { kind: "tie", players: leaders };
        } else {
          this.result = { kind: "team", won: a.result === "team-win" };
        }
        this.setState("ended");
        break;
      }
    }
  }
}

function instantiate(def: ObjectDef, id: string): LiveObject {
  const sprite = def.type === "sprite" ? def : null;
  const text = def.type === "text" ? def : null;
  const timer = def.type === "timer" ? def : null;
  const width = sprite?.width ?? 0;
  const height = sprite?.height ?? 0;
  return {
    id,
    type: def.type,
    x: def.x,
    y: def.y,
    layer: def.layer ?? 0,
    visible: def.visible ?? true,
    tags: new Set(def.tags ?? []),
    width,
    height,
    shape: sprite?.shape ?? "rect",
    color: sprite?.color ?? text?.color ?? "#ffffff",
    image: sprite?.image ?? "",
    glyph: sprite?.glyph ?? "",
    rotation: sprite?.rotation ?? 0,
    vx: sprite?.vx ?? 0,
    vy: sprite?.vy ?? 0,
    gravity: sprite?.gravity ?? 0,
    spin: sprite?.spin ?? 0,
    collider: sprite?.collider ? { ...sprite.collider } : { shape: "circle", radius: Math.min(width, height) / 2 },
    text: text?.text ?? "",
    size: text?.size ?? 0,
    align: text?.align ?? "left",
    seconds: timer?.seconds ?? 0,
    remaining: timer?.seconds ?? 0,
    running: timer ? (timer.autostart ?? true) : false,
    hideAt: null,
    entered: false,
  };
}

/** Is a point (with some tolerance) inside an object's touch area? */
function contains(o: LiveObject, x: number, y: number, tolerance: number): boolean {
  if (o.collider.shape === "circle") return Math.hypot(x - o.x, y - o.y) <= o.collider.radius + tolerance;
  return Math.abs(x - o.x) <= o.collider.width / 2 + tolerance && Math.abs(y - o.y) <= o.collider.height / 2 + tolerance;
}

function overlaps(a: LiveObject, b: LiveObject): boolean {
  const half = (o: LiveObject): [number, number] =>
    o.collider.shape === "circle" ? [o.collider.radius, o.collider.radius] : [o.collider.width / 2, o.collider.height / 2];
  if (a.collider.shape === "circle" && b.collider.shape === "circle") {
    return Math.hypot(a.x - b.x, a.y - b.y) <= a.collider.radius + b.collider.radius;
  }
  const [aw, ah] = half(a);
  const [bw, bh] = half(b);
  return Math.abs(a.x - b.x) <= aw + bw && Math.abs(a.y - b.y) <= ah + bh;
}

/** Small seeded random generator for repeatable games in tests and replays. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
