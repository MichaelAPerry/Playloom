import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { packageFileName, packGame, PACKAGE_LIMITS, sniffImage, unpackGame, validateGame, type GameDefinition, type UnpackResult } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const issues = (r: UnpackResult): string => (r.ok ? "" : r.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));

function mole(): GameDefinition {
  const r = validateGame(JSON.parse(readFileSync(new URL("../../../games/mole-mayhem/game.json", import.meta.url), "utf8")));
  if (!r.ok) throw new Error("bundled game invalid");
  return r.game;
}
const gameJson = (): Uint8Array => strToU8(JSON.stringify(mole()));

describe("game packages", () => {
  it("round-trips a game and its pictures", () => {
    const game = mole();
    const packed = packGame({ game, assets: new Map([["assets/mole.png", PNG], ["assets/unlisted.png", PNG]]) });
    const result = unpackGame(packed);
    expect(issues(result)).toBe("");
    if (!result.ok) return;
    expect(result.package.game).toEqual(game);
    expect([...result.package.assets.keys()]).toEqual(["assets/mole.png"]); // the unlisted picture was left out
    expect(result.package.assets.get("assets/mole.png")).toEqual(PNG);
  });

  it("accepts a game whose pictures are missing (shapes are drawn instead)", () => {
    expect(unpackGame(packGame({ game: mole(), assets: new Map() })).ok).toBe(true);
  });

  it("rejects files that have no business in a game", () => {
    for (const name of ["index.html", "assets/run.js", "assets/pic.svg", "extensions/x.js", "../evil.png", "assets/../../evil.png", "/abs.png", "assets/sub/mole.png", "game.json.exe"]) {
      const result = unpackGame(zipSync({ "game.json": gameJson(), [name]: PNG }));
      expect(issues(result), name).toMatch(/is not allowed in a game package|folders other than/);
    }
  });

  it("rejects a picture that is not what its name says", () => {
    expect(issues(unpackGame(zipSync({ "game.json": gameJson(), "assets/mole.png": strToU8("<script>alert(1)</script>") })))).toMatch(/assets\/mole.png: is not a picture/);
    expect(issues(unpackGame(zipSync({ "game.json": gameJson(), "assets/mole.png": JPEG })))).toMatch(/is really a jpeg picture, not a png/);
  });

  it("rejects pictures the game does not list", () => {
    expect(issues(unpackGame(zipSync({ "game.json": gameJson(), "assets/extra.png": PNG })))).toMatch(/not listed in the game's assets/);
  });

  it("rejects a package without a valid game.json", () => {
    expect(issues(unpackGame(zipSync({ "assets/mole.png": PNG })))).toMatch(/game.json: is missing/);
    expect(issues(unpackGame(zipSync({ "game.json": strToU8('{"formatVersion":1,"script":"x"}') })))).toMatch(/script: is not a known property/);
    expect(issues(unpackGame(zipSync({ "game.json": new Uint8Array([0xff, 0xfe, 0xfd]) })))).toMatch(/not valid UTF-8/);
  });

  it("rejects things that are not ZIP files", () => {
    expect(issues(unpackGame(strToU8("hello")))).toMatch(/not a readable game package/);
    expect(issues(unpackGame(new Uint8Array(0)))).toMatch(/not a readable game package/);
  });

  it("refuses oversized and over-full packages without unpacking them", () => {
    // 9 MB of zeros compresses to a few kilobytes: a small ZIP bomb.
    const bomb = zipSync({ "game.json": gameJson(), "assets/mole.png": new Uint8Array(9 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    expect(issues(unpackGame(bomb))).toMatch(/assets\/mole.png: is larger than 8 MB/);

    const many: Record<string, Uint8Array> = { "game.json": gameJson() };
    for (let i = 0; i < PACKAGE_LIMITS.files + 5; i++) many[`assets/p${i}.png`] = PNG;
    expect(issues(unpackGame(zipSync(many)))).toMatch(/contains more than 201 files/);

    expect(issues(unpackGame(new Uint8Array(PACKAGE_LIMITS.packageBytes + 1)))).toMatch(/larger than 40 MB/);
  });

  it("recognises picture types by content", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(strToU8("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(strToU8("GIF89a"))).toBeNull();
  });

  it("makes safe file names", () => {
    const game = mole();
    expect(packageFileName(game)).toBe("mole-mayhem-0.1.0.playloom");
    game.meta.name = "../..\\ Évil <Game>";
    expect(packageFileName(game)).toBe("vil-game-0.1.0.playloom");
  });
});
