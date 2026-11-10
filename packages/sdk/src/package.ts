import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { GameDefinition } from "./format";
import { parseGame, type ValidationIssue } from "./validate";

/**
 * The `.playloom` game package: a ZIP file holding `game.json` and the pictures in `assets/`.
 *
 * A package comes from someone else and is treated as hostile until proven otherwise. A ZIP is
 * only a container — it protects nothing by itself — so everything is checked here before a
 * single byte is stored:
 *   - only `game.json` and `assets/<name>.<png|webp|jpg|jpeg>` may appear; anything else rejects the package;
 *   - the number of files and their declared and actual sizes are limited (defence against ZIP bombs);
 *   - every picture must really be a picture of the type its name claims;
 *   - `game.json` must pass the game validator.
 * Nothing in a package is ever executed.
 */

export const PACKAGE_EXTENSION = ".playloom";

export const PACKAGE_LIMITS = {
  /** Size of the .playloom file itself. */
  packageBytes: 40 * 1024 * 1024,
  files: 201,
  /** One picture, unpacked. */
  assetBytes: 8 * 1024 * 1024,
  /** Everything, unpacked. */
  totalBytes: 80 * 1024 * 1024,
} as const;

export interface GamePackage {
  game: GameDefinition;
  /** Picture bytes by their path in the package, e.g. `assets/mole.png`. */
  assets: Map<string, Uint8Array>;
}

export type UnpackResult = { ok: true; package: GamePackage } | { ok: false; issues: ValidationIssue[] };

const ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|webp|jpg|jpeg)$/;

/** What kind of picture these bytes really are, judged by their first bytes. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && strFromU8(b.subarray(0, 4), true) === "RIFF" && strFromU8(b.subarray(8, 12), true) === "WEBP") return "webp";
  return null;
}

export const imageMimeType = (path: string): string =>
  path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";

export function unpackGame(bytes: Uint8Array): UnpackResult {
  const fail = (path: string, message: string): UnpackResult => ({ ok: false, issues: [{ path, message }] });
  if (bytes.length > PACKAGE_LIMITS.packageBytes) return fail("package", `is larger than ${PACKAGE_LIMITS.packageBytes / 1048576} MB`);

  const issues: ValidationIssue[] = [];
  let count = 0;
  let declared = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Called for every entry before it is unpacked; returning false skips it without inflating.
      filter: (file) => {
        if (file.name.endsWith("/")) {
          if (file.name !== "assets/") issues.push({ path: file.name, message: "folders other than assets/ are not allowed" });
          return false;
        }
        count++;
        if (count > PACKAGE_LIMITS.files) {
          if (count === PACKAGE_LIMITS.files + 1) issues.push({ path: "package", message: `contains more than ${PACKAGE_LIMITS.files} files` });
          return false;
        }
        if (file.name !== "game.json" && !ASSET_PATH.test(file.name)) {
          issues.push({ path: file.name, message: "is not allowed in a game package (only game.json and pictures in assets/)" });
          return false;
        }
        if (file.originalSize > PACKAGE_LIMITS.assetBytes) {
          issues.push({ path: file.name, message: `is larger than ${PACKAGE_LIMITS.assetBytes / 1048576} MB` });
          return false;
        }
        declared += file.originalSize;
        if (declared > PACKAGE_LIMITS.totalBytes) {
          issues.push({ path: "package", message: `unpacks to more than ${PACKAGE_LIMITS.totalBytes / 1048576} MB` });
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    return fail("package", `is not a readable game package: ${(err as Error)?.message ?? err}`);
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 20) };

  // Sizes declared in a ZIP can lie, so measure what actually came out.
  let total = 0;
  for (const [name, data] of Object.entries(files)) {
    total += data.length;
    if (data.length > PACKAGE_LIMITS.assetBytes || total > PACKAGE_LIMITS.totalBytes) return fail(name, "is larger than the package declared");
  }

  const gameBytes = files["game.json"];
  if (!gameBytes) return fail("game.json", "is missing from the package");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(gameBytes);
  } catch {
    return fail("game.json", "is not valid UTF-8 text");
  }
  const parsed = parseGame(text);
  if (!parsed.ok) return parsed;

  const assets = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    if (name === "game.json") continue;
    const kind = sniffImage(data);
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const expected = ext === "jpg" ? "jpeg" : ext;
    if (kind !== expected) issues.push({ path: name, message: kind ? `is really a ${kind} picture, not a ${ext}` : "is not a picture" });
    assets.set(name, data);
  }
  const declaredFiles = new Set((parsed.game.assets ?? []).map((a) => a.file));
  for (const name of assets.keys()) {
    if (!declaredFiles.has(name)) issues.push({ path: name, message: "is not listed in the game's assets" });
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 20) };
  return { ok: true, package: { game: parsed.game, assets } };
}

/** Build a `.playloom` file. Pictures the game does not list are left out. */
export function packGame(pkg: GamePackage): Uint8Array {
  const files: Record<string, Uint8Array> = { "game.json": strToU8(JSON.stringify(pkg.game, null, 2) + "\n") };
  for (const asset of pkg.game.assets ?? []) {
    const data = pkg.assets.get(asset.file);
    if (data) files[asset.file] = data;
  }
  // Pictures are already compressed; storing them unpacked keeps export fast on slow machines.
  return zipSync(files, { level: 0, mtime: new Date(2026, 0, 1) });
}

/** A file name for a game's package: letters, digits and dashes only. */
export function packageFileName(game: GameDefinition): string {
  const base = game.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
  return `${base}-${game.meta.version}${PACKAGE_EXTENSION}`;
}
