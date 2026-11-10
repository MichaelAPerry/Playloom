import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS, parseGame, validateGame, type ValidationResult } from "../src";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../games/${name}/game.json`, import.meta.url), "utf8"));
const issues = (r: ValidationResult): string[] => (r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`));

/** A small valid game to break in different ways. */
const base = (): any => ({
  formatVersion: 1,
  meta: { id: "test.game", name: "Test", version: "1.0.0", mode: "competitive" },
  requires: { players: { min: 1, max: 2 }, tracking: "hands" },
  variables: [{ id: "lives", initial: 3 }],
  startScene: "main",
  scenes: [
    {
      id: "main",
      size: [1280, 720],
      background: "#000000",
      objects: [
        { id: "target", type: "sprite", x: 100, y: 100, width: 50, height: 50, shape: "circle", color: "#ff0000", tags: ["t"] },
        { id: "clock", type: "timer", x: 0, y: 0, seconds: 10 },
        { id: "label", type: "text", x: 0, y: 0, text: "hi", size: 20, color: "#ffffff" },
      ],
      templates: [{ id: "drop", type: "sprite", x: 0, y: 0, width: 10, height: 10, shape: "rect", color: "#00ff00" }],
      rules: [{ when: { type: "hand-touches", player: "any", object: "target" }, then: [{ do: "add-score", player: "$player", amount: 1 }] }],
    },
  ],
});

describe("bundled games", () => {
  it.each(["mole-mayhem", "slice-party"])("%s is a valid format 1 game", (name) => {
    const result = validateGame(load(name));
    expect(issues(result)).toEqual([]);
  });
});

describe("validateGame", () => {
  it("accepts the base game", () => {
    expect(issues(validateGame(base()))).toEqual([]);
  });

  it("refuses other format versions", () => {
    const g = base();
    g.formatVersion = 2;
    expect(issues(validateGame(g))[0]).toMatch(/reads format 1 only/);
  });

  it("rejects unknown properties everywhere", () => {
    const g = base();
    g.script = "alert(1)";
    g.scenes[0].objects[0].onclick = "x";
    g.scenes[0].rules[0].then[0].extra = 1;
    const found = issues(validateGame(g)).join("\n");
    expect(found).toMatch(/game\.script: is not a known property/);
    expect(found).toMatch(/objects\[0\]\.onclick/);
    expect(found).toMatch(/then\[0\]\.extra/);
  });

  it("rejects unknown triggers, actions, sounds and shapes", () => {
    const g = base();
    g.scenes[0].rules.push({ when: { type: "run-script" }, then: [{ do: "fetch", url: "https://example.com" }] });
    g.scenes[0].rules.push({ when: { type: "scene-start" }, then: [{ do: "play-sound", sound: "https://example.com/a.mp3" }] });
    g.scenes[0].objects[0].shape = "blob";
    const found = issues(validateGame(g)).join("\n");
    expect(found).toMatch(/is not a known trigger/);
    expect(found).toMatch(/is not a known action/);
    expect(found).toMatch(/sound: must be one of/);
    expect(found).toMatch(/shape: must be one of/);
  });

  it("checks every reference", () => {
    const g = base();
    g.startScene = "nowhere";
    g.scenes[0].rules = [
      { when: { type: "timer-ends", timer: "target" }, then: [{ do: "go-to-scene", scene: "missing" }] },
      { when: { type: "hand-touches", player: "any", object: { tag: "ghost" } }, then: [{ do: "spawn", template: "nope", x: 0, y: 0 }] },
      { when: { type: "scene-start" }, then: [{ do: "set-variable", variable: "unknown", value: { var: "alsoUnknown" } }, { do: "hide", object: "phantom" }] },
    ];
    const found = issues(validateGame(g)).join("\n");
    expect(found).toMatch(/no scene called "nowhere"/);
    expect(found).toMatch(/no timer called "target"/);
    expect(found).toMatch(/no scene called "missing"/);
    expect(found).toMatch(/nothing in this scene has the tag "ghost"/);
    expect(found).toMatch(/no template called "nope"/);
    expect(found).toMatch(/no variable called "unknown"/);
    expect(found).toMatch(/no variable called "alsoUnknown"/);
    expect(found).toMatch(/no object called "phantom"/);
  });

  it("only allows $player and $object where a trigger provides them", () => {
    const g = base();
    g.scenes[0].rules = [{ when: { type: "scene-start" }, then: [{ do: "add-score", player: "$player", amount: 1 }, { do: "hide", object: "$object" }] }];
    const found = issues(validateGame(g)).join("\n");
    expect(found).toMatch(/\$player is only available/);
    expect(found).toMatch(/\$object is only available/);
  });

  it("requires skeleton tracking for body gestures but not for swipes", () => {
    const g = base();
    g.scenes[0].rules = [{ when: { type: "gesture", player: 1, gesture: "swipe" }, then: [{ do: "play-sound", sound: "pop" }] }];
    expect(validateGame(g).ok).toBe(true);
    g.scenes[0].rules[0].when.gesture = "jump";
    expect(issues(validateGame(g)).join()).toMatch(/needs requires.tracking to be "skeleton"/);
    g.requires.tracking = "skeleton";
    expect(validateGame(g).ok).toBe(true);
  });

  it("rejects duplicate ids, bad colours, bad numbers and player numbers out of range", () => {
    const g = base();
    g.scenes[0].objects.push({ ...g.scenes[0].objects[0] });
    g.scenes[0].background = "red; background:url(https://example.com)";
    g.scenes[0].objects[0].x = Infinity;
    g.scenes[0].objects[0].width = "50";
    g.scenes[0].rules[0].when.player = 3;
    const found = issues(validateGame(g)).join("\n");
    expect(found).toMatch(/"target" is used twice/);
    expect(found).toMatch(/background: must be a hex colour/);
    expect(found).toMatch(/\.x: must be a number/);
    expect(found).toMatch(/\.width: must be a number/);
    expect(found).toMatch(/player number from 1 to 2/);
  });

  it("only accepts picture files inside the game's own assets folder", () => {
    const g = base();
    g.assets = [{ id: "ok", type: "image", file: "assets/mole.png" }];
    g.scenes[0].objects[0].image = "ok";
    g.scenes[0].backgroundImage = "ok";
    expect(issues(validateGame(g))).toEqual([]);
    for (const file of ["https://example.com/a.png", "../secret.png", "assets/../../a.png", "assets/a.svg", "/etc/passwd", "assets/a.png?x=1", "data:image/png;base64,AAAA"]) {
      g.assets = [{ id: "ok", type: "image", file }];
      expect(issues(validateGame(g)).join(), file).toMatch(/must look like assets\/name\.png/);
    }
    g.assets = [];
    expect(issues(validateGame(g)).join()).toMatch(/no asset called "ok"/);
  });

  it("enforces size limits", () => {
    const g = base();
    g.scenes[0].rules = Array.from({ length: LIMITS.rulesPerScene + 1 }, () => g.scenes[0].rules[0]);
    expect(issues(validateGame(g)).join()).toMatch(/the limit is 500/);

    const deep = base();
    let v: any = 1;
    for (let i = 0; i < 20; i++) v = { op: "+", args: [v, 1] };
    deep.scenes[0].rules[0].then[0].amount = v;
    expect(issues(validateGame(deep)).join()).toMatch(/nested too deeply/);
  });

  it("is not fooled by prototype tricks or non-objects", () => {
    expect(validateGame(null).ok).toBe(false);
    expect(validateGame([]).ok).toBe(false);
    expect(validateGame("game").ok).toBe(false);
    const result = parseGame('{"formatVersion":1,"__proto__":{"polluted":true},"meta":{}}');
    expect(result.ok).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(issues(result).join()).toMatch(/__proto__: is not a known property/);
  });

  it("parseGame rejects invalid JSON and oversized files before parsing", () => {
    expect(issues(parseGame("{nope"))[0]).toMatch(/not valid JSON/);
    expect(issues(parseGame(" ".repeat(LIMITS.jsonBytes + 1)))[0]).toMatch(/larger than 2 MB/);
  });
});
