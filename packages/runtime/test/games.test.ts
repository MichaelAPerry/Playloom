import { readFileSync } from "node:fs";
import { MotionEngine } from "@playloom/core";
import { validateGame, type GameDefinition, type SoundId } from "@playloom/sdk";
import { SimulatorSource } from "@playloom/simulator";
import { describe, expect, it } from "vitest";
import { GameRuntime, seededRandom } from "../src";

function load(name: string): GameDefinition {
  const result = validateGame(JSON.parse(readFileSync(new URL(`../../../games/${name}/game.json`, import.meta.url), "utf8")));
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
  return result.game;
}

/** Two simulated players, the real motion engine and a game, advanced together frame by frame. */
async function play(game: GameDefinition, seed = 7) {
  const sim = new SimulatorSource({ clock: "manual" });
  const engine = new MotionEngine({ now: () => sim.now });
  await engine.attach(sim);
  await engine.start();
  sim.step(1000); // players walk in and are recognised before the game starts
  const sounds: SoundId[] = [];
  const runtime = new GameRuntime(game, engine.api, { random: seededRandom(seed), audio: { play: (s) => sounds.push(s) } });
  runtime.start();
  const step = (ms: number): void => {
    for (let t = 0; t < ms; t += 1000 / 30) {
      sim.step(1000 / 30);
      runtime.update(1 / 30);
    }
  };
  const [W, H] = runtime.scene.size;
  /** Put a simulated player's hand on a scene position. */
  const reach = (player: number, x: number, y: number): void => sim.setHand(player, "right", { x: x / W, y: y / H });
  return { sim, engine, runtime, step, reach, sounds };
}

describe("Mole Mayhem (defined entirely by rules)", () => {
  it("scores for the player who bonks a mole, and only for them", async () => {
    const { runtime, step, reach, sounds } = await play(load("mole-mayhem"));
    step(1500);
    const mole = runtime.objects.find((o) => o.tags.has("mole") && o.visible)!;
    expect(mole).toBeDefined();
    reach(2, mole.x, mole.y);
    step(400);
    expect(runtime.score(2)).toBe(10);
    expect(runtime.score(1)).toBe(0);
    expect(mole.visible).toBe(false);
    expect(sounds).toContain("bonk");
    expect(runtime.formatText("Player 2: {score:2}")).toBe("Player 2: 10");
  });

  it("does not score for touching an empty hole", async () => {
    const { runtime, step, reach } = await play(load("mole-mayhem"));
    step(200);
    const hidden = runtime.objects.find((o) => o.tags.has("mole") && !o.visible)!;
    reach(1, hidden.x, hidden.y);
    step(150);
    expect(runtime.score(1)).toBe(0);
  });

  it("does not score when a mole pops up under a resting hand", async () => {
    const { runtime, step, reach } = await play(load("mole-mayhem"));
    step(1500);
    const mole = runtime.objects.find((o) => o.tags.has("mole") && o.visible)!;
    reach(1, mole.x, mole.y);
    step(300);
    expect(runtime.score(1)).toBe(10);
    step(20_000); // the hand stays put while the mole reappears several times
    expect(runtime.score(1)).toBe(10);
    // Moving away and back counts again.
    reach(1, mole.x + 300, mole.y);
    step(300);
    for (let i = 0; i < 100 && !mole.visible; i++) step(100);
    reach(1, mole.x, mole.y);
    step(300);
    expect(runtime.score(1)).toBe(20);
  });

  it("does not let players score by standing still with their arms down", async () => {
    const { runtime, step } = await play(load("mole-mayhem"));
    step(30_000);
    expect(runtime.totalScore()).toBe(0);
  });

  it("plays a full round to a winner", async () => {
    const { runtime, step, reach, sounds } = await play(load("mole-mayhem"));
    const states: string[] = [];
    runtime.onStateChange((s) => states.push(s));
    // Player 1 chases moles; Player 2 stands still.
    for (let i = 0; i < 200 && runtime.state !== "ended"; i++) {
      const mole = runtime.objects.find((o) => o.tags.has("mole") && o.visible);
      if (mole) reach(1, mole.x, mole.y);
      step(330);
    }
    expect(runtime.state).toBe("ended");
    expect(states).toEqual(["ended"]);
    expect(runtime.result).toEqual({ kind: "winner", player: 1 });
    expect(runtime.score(1)).toBeGreaterThan(100);
    expect(runtime.score(2)).toBe(0);
    expect(sounds.at(-1)).toBe("win");
    const frozen = runtime.score(1);
    step(2000);
    expect(runtime.score(1)).toBe(frozen);
  });

  it("ends in a tie when nobody scores", async () => {
    const { runtime, step } = await play(load("mole-mayhem"));
    step(61_000);
    expect(runtime.result).toEqual({ kind: "tie", players: [1, 2] });
  });
});

describe("Slice Party (cooperative, defined entirely by rules)", () => {
  it("needs a fast hand to slice, and slicing adds to the team total", async () => {
    const { sim, runtime, step, reach } = await play(load("slice-party"));
    step(2500);
    const fruit = (): (typeof runtime.objects)[number] | undefined =>
      runtime.objects.find((o) => o.tags.has("fruit") && o.y > 150 && o.y < 600 && o.x > 100 && o.x < 1180);
    expect(fruit()).toBeDefined();

    // Slow approach: follow a fruit gently; it must not be sliced by mere contact at low speed.
    // (A hand placed by the simulator jumps there instantly, which is fast, so slice deliberately.)
    let sliced = 0;
    for (let i = 0; i < 400 && runtime.totalScore() < 30; i++) {
      const f = fruit();
      if (f) {
        const player = f.x < 640 ? 1 : 2;
        reach(player, f.x - 150, f.y + f.vy * 0.1);
        step(100);
        reach(player, f.x + 150, f.y + f.vy * 0.1);
        step(100);
        if (!runtime.objects.includes(f)) sliced++;
      } else step(100);
    }
    expect(sliced).toBeGreaterThan(0);
    expect(runtime.totalScore()).toBeGreaterThanOrEqual(30);
    expect(runtime.variables.get("sliced")).toBeGreaterThanOrEqual(3);
    expect(runtime.formatText("Team: {score:total} / {var:goal}")).toMatch(/^Team: \d+ \/ 300$/);
    void sim;
  });

  it("removes fruit that falls out of the scene", async () => {
    const { runtime, step } = await play(load("slice-party"));
    step(30_000);
    expect(runtime.objects.filter((o) => o.template).length).toBeLessThan(20);
  });

  it("the team loses when time runs out", async () => {
    const { runtime, step, sounds } = await play(load("slice-party"));
    step(61_000);
    expect(runtime.state).toBe("ended");
    expect(runtime.result).toEqual({ kind: "team", won: false });
    expect(sounds.at(-1)).toBe("lose");
  });

  it("the team wins on reaching the goal", async () => {
    const game = load("slice-party");
    game.variables!.find((v) => v.id === "goal")!.initial = 20;
    const { runtime, step, reach } = await play(game);
    for (let i = 0; i < 600 && runtime.state !== "ended"; i++) {
      const f = runtime.objects.find((o) => o.tags.has("fruit") && o.y > 150 && o.y < 600);
      if (f) {
        reach(1, f.x - 150, f.y);
        step(100);
        reach(1, f.x + 150, f.y);
      }
      step(100);
    }
    expect(runtime.result).toEqual({ kind: "team", won: true });
  });

  it("touching a bomb costs points", async () => {
    const { runtime, step, reach } = await play(load("slice-party"), 3);
    for (let i = 0; i < 900 && runtime.score(1) >= 0; i++) {
      const bomb = runtime.objects.find((o) => o.tags.has("bomb") && o.y > 100 && o.y < 620);
      if (bomb) reach(1, bomb.x, bomb.y + bomb.vy * 0.05);
      step(66);
    }
    expect(runtime.score(1)).toBe(-20);
  });
});

describe("lifecycle and safety", () => {
  it("pauses when a player is missing and resumes when they return", async () => {
    const { sim, runtime, step } = await play(load("mole-mayhem"));
    step(1000);
    sim.setPresent(2, false);
    step(2000);
    expect(runtime.state).toBe("paused");
    expect(runtime.pauseReason).toBe("players");
    const clock = runtime.objects.find((o) => o.id === "clock")!.remaining;
    step(3000);
    expect(runtime.objects.find((o) => o.id === "clock")!.remaining).toBe(clock);
    sim.setPresent(2, true);
    step(1500);
    expect(runtime.state).toBe("playing");
  });

  it("pauses while player identity needs attention", async () => {
    const { sim, engine, runtime, step } = await play(load("mole-mayhem"));
    step(500);
    sim.cross();
    step(3500);
    expect(engine.api.status.needsAction).toBe(true);
    expect(runtime.state).toBe("paused");
    expect(runtime.pauseReason).toBe("identity");
    engine.confirmIdentities();
    step(200);
    expect(runtime.state).toBe("playing");
  });

  it("supports user pause, resume and restart", async () => {
    const { runtime, step, reach } = await play(load("mole-mayhem"));
    step(1500);
    runtime.pause();
    step(500);
    expect(runtime.pauseReason).toBe("user");
    const t = runtime.time;
    step(1000);
    expect(runtime.time).toBe(t);
    runtime.resume();
    step(1500);
    const mole = runtime.objects.find((o) => o.tags.has("mole") && o.visible)!;
    reach(1, mole.x, mole.y);
    step(300);
    expect(runtime.score(1)).toBe(10);
    runtime.start();
    expect(runtime.score(1)).toBe(0);
    expect(runtime.state).toBe("playing");
  });

  it("is repeatable for a given seed", async () => {
    const run = async (): Promise<string> => {
      const { runtime, step } = await play(load("slice-party"), 99);
      step(5000);
      return JSON.stringify(runtime.objects.map((o) => [o.id, Math.round(o.x), Math.round(o.y)]));
    };
    expect(await run()).toBe(await run());
  });

  it("caps the number of live objects", async () => {
    const game = load("slice-party");
    const scene = game.scenes[0]!;
    scene.templates!.push({ id: "dot", type: "sprite", x: 0, y: 0, width: 4, height: 4, shape: "circle", color: "#ffffff" });
    scene.rules = [{ when: { type: "every", seconds: 0.05 }, then: Array.from({ length: 50 }, () => ({ do: "spawn" as const, template: "dot", x: 640, y: 360 })) }];
    expect(validateGame(game).ok).toBe(true);
    const { runtime, step } = await play(game);
    step(3000);
    expect(runtime.objects.length).toBe(300);
  });

  it("runs gesture, collision, scene-change and leaves-scene rules", async () => {
    const game: GameDefinition = {
      formatVersion: 1,
      meta: { id: "test.rules", name: "Rules", version: "1.0.0", mode: "cooperative" },
      requires: { players: { min: 1, max: 2 }, tracking: "skeleton", gestures: ["jump"] },
      variables: [{ id: "hits", initial: 0 }, { id: "gone", initial: 0 }],
      startScene: "one",
      scenes: [
        {
          id: "one",
          size: [1000, 500],
          background: "#000000",
          objects: [
            { id: "ball", type: "sprite", x: 100, y: 250, width: 40, height: 40, shape: "circle", color: "#ffffff", vx: 400 },
            { id: "wall", type: "sprite", x: 500, y: 250, width: 40, height: 400, shape: "rect", color: "#ffffff", collider: { shape: "rect", width: 40, height: 400 } },
          ],
          rules: [
            { when: { type: "collision", a: "ball", b: "wall" }, then: [{ do: "change-variable", variable: "hits", by: 1 }] },
            { when: { type: "leaves-scene", object: "ball" }, then: [{ do: "change-variable", variable: "gone", by: 1 }] },
            { when: { type: "gesture", player: 2, gesture: "jump" }, if: [{ type: "compare", left: { var: "gone" }, op: "==", right: 1 }], then: [{ do: "go-to-scene", scene: "two" }] },
          ],
        },
        {
          id: "two",
          size: [1000, 500],
          background: "#111111",
          objects: [],
          rules: [{ when: { type: "scene-start" }, then: [{ do: "add-score", player: "all", amount: 5 }, { do: "end-game", result: "team-win" }] }],
        },
      ],
    };
    expect(validateGame(game)).toMatchObject({ ok: true });
    const { sim, runtime, step } = await play(game);
    sim.jump(2); // too early: the ball has not left yet, so the condition blocks the rule
    step(1000);
    expect(runtime.scene.id).toBe("one");
    step(2500);
    expect(runtime.variables.get("hits")).toBe(1);
    expect(runtime.variables.get("gone")).toBe(1);
    sim.jump(1); // wrong player
    step(1000);
    expect(runtime.scene.id).toBe("one");
    sim.jump(2);
    step(1000);
    expect(runtime.scene.id).toBe("two");
    expect(runtime.result).toEqual({ kind: "team", won: true });
    expect(runtime.score(1)).toBe(5);
    expect(runtime.score(2)).toBe(5);
  });
});
