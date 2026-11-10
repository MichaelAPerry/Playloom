/**
 * Playloom game format, version 1.
 *
 * A game is plain data: scenes containing objects, and rules of the form
 * WHEN trigger [IF conditions] THEN actions. The runtime interprets this data; nothing in a game
 * definition is ever executed as code. Studio edits the same structure, and the Console plays it.
 */

export const FORMAT_VERSION = 1;

export const GESTURES = ["jump", "duck", "handsUp", "leftHandRaised", "rightHandRaised", "leanLeft", "leanRight", "swipe"] as const;
export type GestureId = (typeof GESTURES)[number];

/** Sounds built into the runtime (synthesised, so games need no audio files to make noise). */
export const BUILTIN_SOUNDS = ["pop", "bonk", "ding", "buzz", "whoosh", "win", "lose", "tick"] as const;
export type SoundId = (typeof BUILTIN_SOUNDS)[number];

export const SHAPES = ["circle", "rect", "star", "diamond"] as const;
export type Shape = (typeof SHAPES)[number];

export interface GameDefinition {
  formatVersion: 1;
  meta: GameMeta;
  requires: Requirements;
  variables?: VariableDef[];
  startScene: string;
  scenes: SceneDef[];
}

export interface GameMeta {
  /** Reverse-domain style identifier, e.g. `org.playloom.mole-mayhem`. */
  id: string;
  name: string;
  /** The game's own version, `major.minor.patch`. */
  version: string;
  description?: string;
  author?: string;
  /** SPDX identifier or short license name for the game and its assets. */
  license?: string;
  mode: "competitive" | "cooperative";
}

/** What the game needs from the device. The launcher compares this with the compatibility report. */
export interface Requirements {
  players: { min: number; max: number };
  /** `hands`: hand positions are enough (works in Lite mode). `skeleton`: needs full pose tracking. */
  tracking: "hands" | "skeleton";
  gestures?: GestureId[];
}

export interface VariableDef {
  id: string;
  initial: number;
}

export interface SceneDef {
  id: string;
  /** Design size in scene units; the runtime scales it to the screen. */
  size: [width: number, height: number];
  /** CSS hex colour, e.g. `#1d2233`. */
  background: string;
  objects: ObjectDef[];
  /** Objects that do not exist until a `spawn` action creates copies of them. */
  templates?: ObjectDef[];
  rules: Rule[];
}

// ---- Objects --------------------------------------------------------------------------------------

interface ObjectBase {
  id: string;
  x: number;
  y: number;
  /** Higher layers draw on top. Default 0. */
  layer?: number;
  /** Default true. Hidden objects cannot be touched. */
  visible?: boolean;
  tags?: string[];
}

export interface SpriteDef extends ObjectBase {
  type: "sprite";
  width: number;
  height: number;
  shape: Shape;
  color: string;
  /** A short piece of text drawn in the middle of the shape (a letter, number or symbol). */
  glyph?: string;
  /** Touch area. Defaults to a circle fitting the sprite. */
  collider?: { shape: "circle"; radius: number } | { shape: "rect"; width: number; height: number };
  /** Scene units per second. */
  vx?: number;
  vy?: number;
  /** Downward acceleration in scene units per second squared. */
  gravity?: number;
  /** Degrees per second. */
  spin?: number;
  rotation?: number;
}

export interface TextDef extends ObjectBase {
  type: "text";
  /** May contain `{score:1}`, `{score:2}`, `{score:total}`, `{var:name}` and `{timer:id}`. */
  text: string;
  size: number;
  color: string;
  align?: "left" | "center" | "right";
}

export interface TimerDef extends ObjectBase {
  type: "timer";
  seconds: number;
  /** Start counting when the scene starts. Default true. */
  autostart?: boolean;
}

export type ObjectDef = SpriteDef | TextDef | TimerDef;

// ---- References and values ------------------------------------------------------------------------

/**
 * Which object an action or trigger refers to:
 *   - `"mole-1"`            an object id
 *   - `"$object"`           the object that set off the rule
 *   - `"$other"`            the second object in a collision
 *   - `{ tag }`             every object with that tag
 *   - `{ random: { tag } }` one object with that tag chosen at random, optionally only hidden or visible ones
 */
export type ObjectRef = string | { tag: string } | { random: { tag: string; state?: "visible" | "hidden" } };

/** In actions, `"$player"` is the player who set off the rule. */
export type PlayerRef = number | "$player";

export const OPERATORS = ["+", "-", "*", "/", "min", "max"] as const;
export const COMPARATORS = ["==", "!=", "<", "<=", ">", ">="] as const;

export type Value =
  | number
  | { var: string }
  | { score: PlayerRef | "total" }
  | { timer: string }
  | { random: [min: number, max: number] }
  | { prop: [object: string, property: PropertyName] }
  | { op: (typeof OPERATORS)[number]; args: [Value, Value] };

export const PROPERTIES = ["x", "y", "width", "height", "rotation", "vx", "vy", "gravity", "spin", "size"] as const;
export type PropertyName = (typeof PROPERTIES)[number];

// ---- Rules ----------------------------------------------------------------------------------------

export interface Rule {
  /** Optional label shown in Studio. */
  name?: string;
  when: Trigger;
  if?: Condition[];
  then: Action[];
}

export type Trigger =
  | { type: "scene-start" }
  | { type: "every"; seconds: number; jitter?: number }
  | { type: "hand-touches"; player: number | "any"; hand?: "left" | "right" | "any"; object: ObjectRef; minSpeed?: number }
  | { type: "gesture"; player: number | "any"; gesture: GestureId }
  | { type: "timer-ends"; timer: string }
  | { type: "collision"; a: ObjectRef; b: ObjectRef }
  | { type: "leaves-scene"; object: ObjectRef }
  | { type: "when-true"; condition: Condition };

export type Condition =
  | { type: "compare"; left: Value; op: (typeof COMPARATORS)[number]; right: Value }
  | { type: "all"; of: Condition[] }
  | { type: "any"; of: Condition[] }
  | { type: "not"; condition: Condition };

export type Action =
  | { do: "add-score"; player: PlayerRef | "all"; amount: Value }
  | { do: "set-variable"; variable: string; value: Value }
  | { do: "change-variable"; variable: string; by: Value }
  | { do: "play-sound"; sound: SoundId }
  | { do: "spawn"; template: string; x: Value; y: Value; vx?: Value; vy?: Value }
  | { do: "destroy"; object: ObjectRef }
  | { do: "show"; object: ObjectRef; forSeconds?: number }
  | { do: "hide"; object: ObjectRef }
  | { do: "set-property"; object: ObjectRef; property: PropertyName; value: Value }
  | { do: "set-text"; object: ObjectRef; text: string }
  | { do: "effect"; object: ObjectRef; effect: "burst" }
  | { do: "start-timer"; timer: string }
  | { do: "stop-timer"; timer: string }
  | { do: "go-to-scene"; scene: string }
  | { do: "end-game"; result: "highest-score" | "team-win" | "team-lose" };

/** Hard limits. A game exceeding any of them is rejected on import. */
export const LIMITS = {
  scenes: 50,
  objectsPerScene: 500,
  templatesPerScene: 100,
  rulesPerScene: 500,
  actionsPerRule: 50,
  conditionsPerRule: 20,
  variables: 200,
  nesting: 8,
  stringLength: 500,
  /** Objects alive at once, including spawned ones (enforced by the runtime). */
  liveObjects: 300,
  maxPlayers: 4,
  jsonBytes: 2 * 1024 * 1024,
} as const;
