import {
  BUILTIN_SOUNDS,
  COMPARATORS,
  GESTURES,
  LIMITS,
  OPERATORS,
  PROPERTIES,
  SHAPES,
  type GameDefinition,
} from "./format";

/**
 * Validation of untrusted game definitions.
 *
 * Game files come from other people. This validator is the gate: it accepts only the closed
 * vocabulary of the format, checks every cross-reference, and enforces size limits. Anything it
 * does not recognise is an error — unknown keys included — so a game cannot smuggle data past a
 * runtime that would ignore it, and typos are caught where they are made.
 */

export interface ValidationIssue {
  /** Where the problem is, e.g. `scenes[0].rules[2].then[1].amount`. */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; game: GameDefinition } | { ok: false; issues: ValidationIssue[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ASSET_FILE = /^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|webp|jpg|jpeg)$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SPECIAL_REFS = ["$object", "$other"];
const MAX_ISSUES = 50;

type Obj = Record<string, unknown>;

class Checker {
  issues: ValidationIssue[] = [];

  fail(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
  }

  /** A plain object with only the listed keys. */
  object(v: unknown, path: string, required: string[], optional: string[] = []): Obj | null {
    if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) {
      this.fail(path, "must be an object");
      return null;
    }
    const o = v as Obj;
    for (const key of Object.keys(o)) {
      if (!required.includes(key) && !optional.includes(key)) this.fail(`${path}.${key}`, "is not a known property");
    }
    for (const key of required) if (!(key in o)) this.fail(`${path}.${key}`, "is required");
    return o;
  }

  number(v: unknown, path: string, min = -1e6, max = 1e6): v is number {
    if (typeof v !== "number" || !Number.isFinite(v)) return this.fail(path, "must be a number"), false;
    if (v < min || v > max) return this.fail(path, `must be between ${min} and ${max}`), false;
    return true;
  }

  string(v: unknown, path: string, max: number = LIMITS.stringLength): v is string {
    if (typeof v !== "string") return this.fail(path, "must be text"), false;
    if (v.length > max) return this.fail(path, `must be at most ${max} characters`), false;
    return true;
  }

  id(v: unknown, path: string): v is string {
    if (typeof v !== "string" || !ID.test(v)) {
      return this.fail(path, "must be an identifier (letters, digits, '-', '_' or '.', up to 64 characters)"), false;
    }
    return true;
  }

  oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): v is T {
    if (typeof v !== "string" || !options.includes(v as T)) {
      return this.fail(path, `must be one of: ${options.join(", ")}`), false;
    }
    return true;
  }

  array(v: unknown, path: string, max: number, min = 0): unknown[] | null {
    if (!Array.isArray(v)) return this.fail(path, "must be a list"), null;
    if (v.length > max) return this.fail(path, `has ${v.length} entries; the limit is ${max}`), null;
    if (v.length < min) return this.fail(path, `needs at least ${min} entr${min === 1 ? "y" : "ies"}`), null;
    return v;
  }
}

interface SceneIndex {
  objects: Map<string, string>; // id → type
  templates: Set<string>;
  tags: Set<string>;
}

interface Context {
  c: Checker;
  assets: Set<string>;
  variables: Set<string>;
  sceneIds: Set<string>;
  scene: SceneIndex;
  maxPlayers: number;
}

export function validateGame(data: unknown): ValidationResult {
  const c = new Checker();
  const game = c.object(data, "game", ["formatVersion", "meta", "requires", "startScene", "scenes"], ["variables", "assets"]);
  if (!game) return { ok: false, issues: c.issues };

  if (game.formatVersion !== 1) {
    c.fail("game.formatVersion", `is ${JSON.stringify(game.formatVersion)}; this version of Playloom reads format 1 only`);
    return { ok: false, issues: c.issues };
  }

  const meta = c.object(game.meta, "meta", ["id", "name", "version", "mode"], ["description", "author", "license"]);
  if (meta) {
    c.id(meta.id, "meta.id");
    if (c.string(meta.name, "meta.name", 80) && meta.name.trim() === "") c.fail("meta.name", "must not be empty");
    if (typeof meta.version !== "string" || !VERSION.test(meta.version)) c.fail("meta.version", "must look like 1.0.0");
    c.oneOf(meta.mode, "meta.mode", ["competitive", "cooperative"] as const);
    if ("description" in meta) c.string(meta.description, "meta.description");
    if ("author" in meta) c.string(meta.author, "meta.author", 80);
    if ("license" in meta) c.string(meta.license, "meta.license", 80);
  }

  let maxPlayers = 2;
  const requires = c.object(game.requires, "requires", ["players", "tracking"], ["gestures"]);
  if (requires) {
    const players = c.object(requires.players, "requires.players", ["min", "max"]);
    if (players) {
      const okMin = c.number(players.min, "requires.players.min", 1, LIMITS.maxPlayers);
      const okMax = c.number(players.max, "requires.players.max", 1, LIMITS.maxPlayers);
      if (okMin && okMax) {
        if (!Number.isInteger(players.min) || !Number.isInteger(players.max)) c.fail("requires.players", "must be whole numbers");
        if ((players.min as number) > (players.max as number)) c.fail("requires.players", "min is larger than max");
        maxPlayers = players.max as number;
      }
    }
    c.oneOf(requires.tracking, "requires.tracking", ["hands", "skeleton"] as const);
    if ("gestures" in requires) {
      c.array(requires.gestures, "requires.gestures", GESTURES.length)?.forEach((g, i) => c.oneOf(g, `requires.gestures[${i}]`, GESTURES));
    }
  }

  const assets = new Set<string>();
  if ("assets" in game) {
    c.array(game.assets, "assets", LIMITS.assets)?.forEach((a, i) => {
      const o = c.object(a, `assets[${i}]`, ["id", "type", "file"]);
      if (!o) return;
      if (c.id(o.id, `assets[${i}].id`)) {
        if (assets.has(o.id)) c.fail(`assets[${i}].id`, `"${o.id}" is used twice`);
        assets.add(o.id);
      }
      c.oneOf(o.type, `assets[${i}].type`, ["image"] as const);
      // A fixed pattern, so a game can never point at a file outside its own assets folder or at a web address.
      if (typeof o.file !== "string" || !ASSET_FILE.test(o.file)) {
        c.fail(`assets[${i}].file`, "must look like assets/name.png (png, webp, jpg or jpeg; letters, digits, - and _ only)");
      }
    });
  }

  const variables = new Set<string>();
  if ("variables" in game) {
    c.array(game.variables, "variables", LIMITS.variables)?.forEach((v, i) => {
      const o = c.object(v, `variables[${i}]`, ["id", "initial"]);
      if (!o) return;
      if (c.id(o.id, `variables[${i}].id`)) {
        if (variables.has(o.id)) c.fail(`variables[${i}].id`, `"${o.id}" is used twice`);
        variables.add(o.id);
      }
      c.number(o.initial, `variables[${i}].initial`);
    });
  }

  const scenes = c.array(game.scenes, "scenes", LIMITS.scenes, 1) ?? [];
  const sceneIds = new Set<string>();
  scenes.forEach((s, i) => {
    const id = (s as Obj | null)?.id;
    if (typeof id === "string") {
      if (sceneIds.has(id)) c.fail(`scenes[${i}].id`, `"${id}" is used twice`);
      sceneIds.add(id);
    }
  });
  if (c.id(game.startScene, "startScene") && !sceneIds.has(game.startScene)) {
    c.fail("startScene", `there is no scene called "${game.startScene}"`);
  }
  scenes.forEach((s, i) => checkScene(s, `scenes[${i}]`, { c, assets, variables, sceneIds, maxPlayers, scene: { objects: new Map(), templates: new Set(), tags: new Set() } }));

  // Tracking requirement must be honest: gesture triggers other than swipe need a skeleton.
  if (requires && requires.tracking === "hands") {
    scenes.forEach((s, i) => {
      const rules = (s as Obj | null)?.rules;
      if (!Array.isArray(rules)) return;
      rules.forEach((r, j) => {
        const when = (r as Obj | null)?.when as Obj | undefined;
        if (when?.type === "gesture" && when.gesture !== "swipe") {
          c.fail(`scenes[${i}].rules[${j}].when`, `uses the "${String(when.gesture)}" gesture, which needs requires.tracking to be "skeleton"`);
        }
      });
    });
  }

  return c.issues.length === 0 ? { ok: true, game: data as GameDefinition } : { ok: false, issues: c.issues };
}

/** Parse and validate game JSON text, enforcing the size limit before parsing. */
export function parseGame(text: string): ValidationResult {
  if (text.length > LIMITS.jsonBytes) {
    return { ok: false, issues: [{ path: "game", message: `is larger than ${LIMITS.jsonBytes / 1024 / 1024} MB` }] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [{ path: "game", message: `is not valid JSON: ${(err as Error).message}` }] };
  }
  return validateGame(data);
}

// ---------------------------------------------------------------------------------------------------

function checkScene(v: unknown, path: string, ctx: Context): void {
  const { c } = ctx;
  const scene = c.object(v, path, ["id", "size", "background", "objects", "rules"], ["templates", "backgroundImage"]);
  if (!scene) return;
  c.id(scene.id, `${path}.id`);
  const size = c.array(scene.size, `${path}.size`, 2, 2);
  if (size) {
    c.number(size[0], `${path}.size[0]`, 100, 8000);
    c.number(size[1], `${path}.size[1]`, 100, 8000);
  }
  color(c, scene.background, `${path}.background`);
  if ("backgroundImage" in scene) asset(ctx, scene.backgroundImage, `${path}.backgroundImage`);

  const objects = c.array(scene.objects, `${path}.objects`, LIMITS.objectsPerScene) ?? [];
  const templates = "templates" in scene ? (c.array(scene.templates, `${path}.templates`, LIMITS.templatesPerScene) ?? []) : [];
  const seen = new Set<string>();
  const register = (list: unknown[], listPath: string, isTemplate: boolean): void => {
    list.forEach((o, i) => {
      const def = checkObject(o, `${listPath}[${i}]`, ctx);
      if (!def) return;
      if (seen.has(def.id)) c.fail(`${listPath}[${i}].id`, `"${def.id}" is used twice in this scene`);
      seen.add(def.id);
      if (isTemplate) ctx.scene.templates.add(def.id);
      else ctx.scene.objects.set(def.id, def.type);
      def.tags.forEach((t) => ctx.scene.tags.add(t));
    });
  };
  register(objects, `${path}.objects`, false);
  register(templates, `${path}.templates`, true);

  c.array(scene.rules, `${path}.rules`, LIMITS.rulesPerScene)?.forEach((r, i) => checkRule(r, `${path}.rules[${i}]`, ctx));
}

function color(c: Checker, v: unknown, path: string): void {
  if (typeof v !== "string" || !COLOR.test(v)) c.fail(path, "must be a hex colour such as #ff9f1c");
}

function asset(ctx: Context, v: unknown, path: string): void {
  if (ctx.c.id(v, path) && !ctx.assets.has(v)) ctx.c.fail(path, `there is no asset called "${v}"`);
}

function checkObject(v: unknown, path: string, ctx: Context): { id: string; type: string; tags: string[] } | null {
  const { c } = ctx;
  const type = (v as Obj | null)?.type;
  const base = ["id", "type", "x", "y"];
  const baseOptional = ["layer", "visible", "tags"];
  let o: Obj | null;
  if (type === "sprite") {
    o = c.object(v, path, [...base, "width", "height", "shape", "color"], [...baseOptional, "image", "glyph", "collider", "vx", "vy", "gravity", "spin", "rotation"]);
    if (!o) return null;
    c.number(o.width, `${path}.width`, 1, 8000);
    c.number(o.height, `${path}.height`, 1, 8000);
    c.oneOf(o.shape, `${path}.shape`, SHAPES);
    color(c, o.color, `${path}.color`);
    if ("image" in o) asset(ctx, o.image, `${path}.image`);
    if ("glyph" in o) c.string(o.glyph, `${path}.glyph`, 8);
    for (const k of ["vx", "vy", "gravity", "spin", "rotation"]) if (k in o) c.number(o[k], `${path}.${k}`, -20000, 20000);
    if ("collider" in o) {
      const shape = (o.collider as Obj | null)?.shape;
      if (shape === "circle") {
        const col = c.object(o.collider, `${path}.collider`, ["shape", "radius"]);
        if (col) c.number(col.radius, `${path}.collider.radius`, 1, 4000);
      } else if (shape === "rect") {
        const col = c.object(o.collider, `${path}.collider`, ["shape", "width", "height"]);
        if (col) {
          c.number(col.width, `${path}.collider.width`, 1, 8000);
          c.number(col.height, `${path}.collider.height`, 1, 8000);
        }
      } else c.fail(`${path}.collider.shape`, "must be circle or rect");
    }
  } else if (type === "text") {
    o = c.object(v, path, [...base, "text", "size", "color"], [...baseOptional, "align"]);
    if (!o) return null;
    c.string(o.text, `${path}.text`);
    c.number(o.size, `${path}.size`, 4, 1000);
    color(c, o.color, `${path}.color`);
    if ("align" in o) c.oneOf(o.align, `${path}.align`, ["left", "center", "right"] as const);
  } else if (type === "timer") {
    o = c.object(v, path, [...base, "seconds"], [...baseOptional, "autostart"]);
    if (!o) return null;
    c.number(o.seconds, `${path}.seconds`, 0.1, 86400);
    if ("autostart" in o && typeof o.autostart !== "boolean") c.fail(`${path}.autostart`, "must be true or false");
  } else {
    c.fail(`${path}.type`, "must be sprite, text or timer");
    return null;
  }
  c.number(o.x, `${path}.x`, -20000, 20000);
  c.number(o.y, `${path}.y`, -20000, 20000);
  if ("layer" in o) c.number(o.layer, `${path}.layer`, -1000, 1000);
  if ("visible" in o && typeof o.visible !== "boolean") c.fail(`${path}.visible`, "must be true or false");
  const tags: string[] = [];
  if ("tags" in o) {
    c.array(o.tags, `${path}.tags`, 20)?.forEach((t, i) => {
      if (c.id(t, `${path}.tags[${i}]`)) tags.push(t);
    });
  }
  if (!c.id(o.id, `${path}.id`)) return null;
  if (o.id.startsWith("$") || o.id.includes("#")) c.fail(`${path}.id`, "must not start with $ or contain #");
  return { id: o.id, type: type as string, tags };
}

function checkRule(v: unknown, path: string, ctx: Context): void {
  const { c } = ctx;
  const rule = c.object(v, path, ["when", "then"], ["name", "if"]);
  if (!rule) return;
  if ("name" in rule) c.string(rule.name, `${path}.name`, 120);
  const trigger = checkTrigger(rule.when, `${path}.when`, ctx);
  if ("if" in rule) {
    c.array(rule.if, `${path}.if`, LIMITS.conditionsPerRule)?.forEach((cond, i) => checkCondition(cond, `${path}.if[${i}]`, ctx, trigger, 0));
  }
  c.array(rule.then, `${path}.then`, LIMITS.actionsPerRule, 1)?.forEach((a, i) => checkAction(a, `${path}.then[${i}]`, ctx, trigger));
}

/** What a trigger makes available to the rest of its rule. */
interface TriggerScope {
  player: boolean;
  object: boolean;
  other: boolean;
}

function checkTrigger(v: unknown, path: string, ctx: Context): TriggerScope {
  const { c } = ctx;
  const scope: TriggerScope = { player: false, object: false, other: false };
  const type = (v as Obj | null)?.type;
  const player = (p: unknown, at: string): void => {
    if (p !== "any" && !(typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= ctx.maxPlayers)) {
      c.fail(at, `must be "any" or a player number from 1 to ${ctx.maxPlayers}`);
    }
  };
  switch (type) {
    case "scene-start":
      c.object(v, path, ["type"]);
      break;
    case "every": {
      const o = c.object(v, path, ["type", "seconds"], ["jitter"]);
      if (o) {
        c.number(o.seconds, `${path}.seconds`, 0.05, 3600);
        if ("jitter" in o) c.number(o.jitter, `${path}.jitter`, 0, 3600);
      }
      break;
    }
    case "hand-touches": {
      const o = c.object(v, path, ["type", "player", "object"], ["hand", "minSpeed"]);
      if (o) {
        player(o.player, `${path}.player`);
        if ("hand" in o) c.oneOf(o.hand, `${path}.hand`, ["left", "right", "any"] as const);
        if ("minSpeed" in o) c.number(o.minSpeed, `${path}.minSpeed`, 0, 100000);
        checkObjectRef(o.object, `${path}.object`, ctx, null, ["sprite"]);
      }
      scope.player = scope.object = true;
      break;
    }
    case "gesture": {
      const o = c.object(v, path, ["type", "player", "gesture"]);
      if (o) {
        player(o.player, `${path}.player`);
        c.oneOf(o.gesture, `${path}.gesture`, GESTURES);
      }
      scope.player = true;
      break;
    }
    case "timer-ends": {
      const o = c.object(v, path, ["type", "timer"]);
      if (o) checkTimer(o.timer, `${path}.timer`, ctx);
      break;
    }
    case "collision": {
      const o = c.object(v, path, ["type", "a", "b"]);
      if (o) {
        checkObjectRef(o.a, `${path}.a`, ctx, null, ["sprite"]);
        checkObjectRef(o.b, `${path}.b`, ctx, null, ["sprite"]);
      }
      scope.object = scope.other = true;
      break;
    }
    case "leaves-scene": {
      const o = c.object(v, path, ["type", "object"]);
      if (o) checkObjectRef(o.object, `${path}.object`, ctx, null, ["sprite"]);
      scope.object = true;
      break;
    }
    case "when-true": {
      const o = c.object(v, path, ["type", "condition"]);
      if (o) checkCondition(o.condition, `${path}.condition`, ctx, scope, 0);
      break;
    }
    default:
      c.fail(`${path}.type`, "is not a known trigger");
  }
  return scope;
}

function checkTimer(v: unknown, path: string, ctx: Context): void {
  if (!ctx.c.id(v, path)) return;
  if (ctx.scene.objects.get(v) !== "timer") ctx.c.fail(path, `there is no timer called "${v}" in this scene`);
}

function checkObjectRef(v: unknown, path: string, ctx: Context, scope: TriggerScope | null, types?: string[]): void {
  const { c } = ctx;
  if (typeof v === "string") {
    if (SPECIAL_REFS.includes(v)) {
      if (!scope) c.fail(path, `${v} cannot be used here`);
      else if (v === "$object" && !scope.object) c.fail(path, "$object is only available when the rule is set off by an object");
      else if (v === "$other" && !scope.other) c.fail(path, "$other is only available in collision rules");
      return;
    }
    const type = ctx.scene.objects.get(v);
    if (!type) c.fail(path, `there is no object called "${v}" in this scene`);
    else if (types && !types.includes(type)) c.fail(path, `"${v}" is a ${type}; expected ${types.join(" or ")}`);
    return;
  }
  const o = v as Obj | null;
  if (o && typeof o === "object" && "tag" in o) {
    const ref = c.object(v, path, ["tag"]);
    if (ref && c.id(ref.tag, `${path}.tag`) && !ctx.scene.tags.has(ref.tag)) c.fail(`${path}.tag`, `nothing in this scene has the tag "${ref.tag}"`);
    return;
  }
  if (o && typeof o === "object" && "random" in o) {
    const ref = c.object(v, path, ["random"]);
    const inner = ref && c.object(ref.random, `${path}.random`, ["tag"], ["state"]);
    if (inner) {
      if (c.id(inner.tag, `${path}.random.tag`) && !ctx.scene.tags.has(inner.tag)) c.fail(`${path}.random.tag`, `nothing in this scene has the tag "${inner.tag}"`);
      if ("state" in inner) c.oneOf(inner.state, `${path}.random.state`, ["visible", "hidden"] as const);
    }
    return;
  }
  c.fail(path, 'must be an object id, "$object", "$other", { "tag": … } or { "random": { "tag": … } }');
}

function checkPlayerRef(v: unknown, path: string, ctx: Context, scope: TriggerScope, extra: string[] = []): void {
  if (typeof v === "string" && extra.includes(v)) return;
  if (v === "$player") {
    if (!scope.player) ctx.c.fail(path, "$player is only available when the rule is set off by a player");
    return;
  }
  if (!(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= ctx.maxPlayers)) {
    ctx.c.fail(path, `must be "$player"${extra.map((e) => `, "${e}"`).join("")} or a player number from 1 to ${ctx.maxPlayers}`);
  }
}

function checkValue(v: unknown, path: string, ctx: Context, scope: TriggerScope, depth: number): void {
  const { c } = ctx;
  if (typeof v === "number") return void c.number(v, path);
  if (depth > LIMITS.nesting) return c.fail(path, "is nested too deeply");
  const o = v as Obj | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return c.fail(path, "must be a number or a value expression");
  if ("var" in o) {
    if (c.object(v, path, ["var"]) && c.id(o.var, `${path}.var`) && !ctx.variables.has(o.var)) c.fail(`${path}.var`, `there is no variable called "${o.var}"`);
  } else if ("score" in o) {
    if (c.object(v, path, ["score"])) checkPlayerRef(o.score, `${path}.score`, ctx, scope, ["total"]);
  } else if ("timer" in o) {
    if (c.object(v, path, ["timer"])) checkTimer(o.timer, `${path}.timer`, ctx);
  } else if ("random" in o) {
    const range = c.object(v, path, ["random"]) && c.array(o.random, `${path}.random`, 2, 2);
    if (range) {
      const a = c.number(range[0], `${path}.random[0]`);
      const b = c.number(range[1], `${path}.random[1]`);
      if (a && b && (range[0] as number) > (range[1] as number)) c.fail(`${path}.random`, "the first number must not be larger than the second");
    }
  } else if ("prop" in o) {
    const pair = c.object(v, path, ["prop"]) && c.array(o.prop, `${path}.prop`, 2, 2);
    if (pair) {
      if (typeof pair[0] !== "string") c.fail(`${path}.prop[0]`, "must be an object id, $object or $other");
      else checkObjectRef(pair[0], `${path}.prop[0]`, ctx, scope);
      c.oneOf(pair[1], `${path}.prop[1]`, PROPERTIES);
    }
  } else if ("op" in o) {
    if (c.object(v, path, ["op", "args"])) {
      c.oneOf(o.op, `${path}.op`, OPERATORS);
      c.array(o.args, `${path}.args`, 2, 2)?.forEach((a, i) => checkValue(a, `${path}.args[${i}]`, ctx, scope, depth + 1));
    }
  } else c.fail(path, "is not a known value expression");
}

function checkCondition(v: unknown, path: string, ctx: Context, scope: TriggerScope, depth: number): void {
  const { c } = ctx;
  if (depth > LIMITS.nesting) return c.fail(path, "is nested too deeply");
  const type = (v as Obj | null)?.type;
  if (type === "compare") {
    const o = c.object(v, path, ["type", "left", "op", "right"]);
    if (!o) return;
    checkValue(o.left, `${path}.left`, ctx, scope, 0);
    c.oneOf(o.op, `${path}.op`, COMPARATORS);
    checkValue(o.right, `${path}.right`, ctx, scope, 0);
  } else if (type === "all" || type === "any") {
    const o = c.object(v, path, ["type", "of"]);
    if (o) c.array(o.of, `${path}.of`, LIMITS.conditionsPerRule, 1)?.forEach((x, i) => checkCondition(x, `${path}.of[${i}]`, ctx, scope, depth + 1));
  } else if (type === "not") {
    const o = c.object(v, path, ["type", "condition"]);
    if (o) checkCondition(o.condition, `${path}.condition`, ctx, scope, depth + 1);
  } else c.fail(`${path}.type`, "is not a known condition");
}

function checkAction(v: unknown, path: string, ctx: Context, scope: TriggerScope): void {
  const { c } = ctx;
  const value = (x: unknown, key: string): void => checkValue(x, `${path}.${key}`, ctx, scope, 0);
  const ref = (x: unknown, types?: string[]): void => checkObjectRef(x, `${path}.object`, ctx, scope, types);
  const variable = (x: unknown): void => {
    if (c.id(x, `${path}.variable`) && !ctx.variables.has(x)) c.fail(`${path}.variable`, `there is no variable called "${x}"`);
  };
  const kind = (v as Obj | null)?.do;
  let o: Obj | null;
  switch (kind) {
    case "add-score":
      if ((o = c.object(v, path, ["do", "player", "amount"]))) {
        checkPlayerRef(o.player, `${path}.player`, ctx, scope, ["all"]);
        value(o.amount, "amount");
      }
      break;
    case "set-variable":
      if ((o = c.object(v, path, ["do", "variable", "value"]))) {
        variable(o.variable);
        value(o.value, "value");
      }
      break;
    case "change-variable":
      if ((o = c.object(v, path, ["do", "variable", "by"]))) {
        variable(o.variable);
        value(o.by, "by");
      }
      break;
    case "play-sound":
      if ((o = c.object(v, path, ["do", "sound"]))) c.oneOf(o.sound, `${path}.sound`, BUILTIN_SOUNDS);
      break;
    case "spawn":
      if ((o = c.object(v, path, ["do", "template", "x", "y"], ["vx", "vy"]))) {
        if (c.id(o.template, `${path}.template`) && !ctx.scene.templates.has(o.template)) c.fail(`${path}.template`, `there is no template called "${o.template}" in this scene`);
        value(o.x, "x");
        value(o.y, "y");
        if ("vx" in o) value(o.vx, "vx");
        if ("vy" in o) value(o.vy, "vy");
      }
      break;
    case "destroy":
    case "hide":
      if ((o = c.object(v, path, ["do", "object"]))) ref(o.object);
      break;
    case "show":
      if ((o = c.object(v, path, ["do", "object"], ["forSeconds"]))) {
        ref(o.object);
        if ("forSeconds" in o) c.number(o.forSeconds, `${path}.forSeconds`, 0.05, 3600);
      }
      break;
    case "set-property":
      if ((o = c.object(v, path, ["do", "object", "property", "value"]))) {
        ref(o.object);
        c.oneOf(o.property, `${path}.property`, PROPERTIES);
        value(o.value, "value");
      }
      break;
    case "set-text":
      if ((o = c.object(v, path, ["do", "object", "text"]))) {
        ref(o.object, ["text"]);
        c.string(o.text, `${path}.text`);
      }
      break;
    case "effect":
      if ((o = c.object(v, path, ["do", "object", "effect"]))) {
        ref(o.object);
        c.oneOf(o.effect, `${path}.effect`, ["burst"] as const);
      }
      break;
    case "start-timer":
    case "stop-timer":
      if ((o = c.object(v, path, ["do", "timer"]))) checkTimer(o.timer, `${path}.timer`, ctx);
      break;
    case "go-to-scene":
      if ((o = c.object(v, path, ["do", "scene"])) && c.id(o.scene, `${path}.scene`) && !ctx.sceneIds.has(o.scene)) {
        c.fail(`${path}.scene`, `there is no scene called "${o.scene}"`);
      }
      break;
    case "end-game":
      if ((o = c.object(v, path, ["do", "result"]))) c.oneOf(o.result, `${path}.result`, ["highest-score", "team-win", "team-lose"] as const);
      break;
    default:
      c.fail(`${path}.do`, "is not a known action");
  }
}
