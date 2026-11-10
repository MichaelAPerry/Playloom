#!/usr/bin/env node
// Prepares the files pose tracking needs so Playloom can run offline:
//   1. copies MediaPipe's WASM runtime out of node_modules, and
//   2. downloads the pose model(s), verifying each against a pinned SHA-256.
//
// Usage: node scripts/fetch-models.mjs [--all]     (--all also fetches the larger "full" model)

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Both apps serve the same files; the playground copy is the master and is mirrored at the end.
const publicDir = join(root, "apps/playground/public");
const mirrors = [join(root, "apps/console/public")];
const manifest = JSON.parse(readFileSync(join(root, "scripts/models.json"), "utf8"));
const all = process.argv.includes("--all");

// 1. WASM runtime
const visionDir = join(root, "packages/core/node_modules/@mediapipe/tasks-vision");
if (!existsSync(join(visionDir, "wasm"))) {
  console.error("MediaPipe is not installed. Run `pnpm install` first.");
  process.exit(1);
}
const wasmOut = join(publicDir, "mediapipe/wasm");
mkdirSync(wasmOut, { recursive: true });
cpSync(join(visionDir, "wasm"), wasmOut, { recursive: true });
console.log(`Copied MediaPipe WASM runtime to ${wasmOut}`);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// 1b. ONNX Runtime Web WASM (MoveNet backend), copied from node_modules and checked against a pinned hash
for (const rt of manifest.runtimeFiles ?? []) {
  const src = join(root, rt.from);
  if (!existsSync(src)) {
    console.error(`${rt.package} is not installed. Run \`pnpm install\` first.`);
    process.exit(1);
  }
  const buf = readFileSync(src);
  if (sha256(buf) !== rt.sha256) {
    console.error(`${rt.file}: checksum mismatch (expected ${rt.sha256}, got ${sha256(buf)}). Was ${rt.package} upgraded?`);
    process.exit(1);
  }
  mkdirSync(join(publicDir, rt.to), { recursive: true });
  writeFileSync(join(publicDir, rt.to, rt.file), buf);
  console.log(`Copied ${rt.file} (${rt.package}), checksum OK`);
}

// 2. Models
mkdirSync(join(publicDir, "models"), { recursive: true });
let failed = false;
for (const model of manifest.models) {
  if (model.optional && !all) continue;
  const out = join(publicDir, "models", model.file);
  if (existsSync(out) && sha256(readFileSync(out)) === model.sha256) {
    console.log(`${model.file}: already present`);
    continue;
  }
  process.stdout.write(`${model.file}: downloading… `);
  try {
    const res = await fetch(model.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = sha256(buf);
    if (digest !== model.sha256) {
      throw new Error(`checksum mismatch (expected ${model.sha256}, got ${digest})`);
    }
    writeFileSync(out, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB, checksum OK`);
  } catch (err) {
    failed = true;
    console.log(`FAILED: ${err.message}`);
  }
}
// The Console ships only what it uses. The MoveNet backend (34 MB of runtime and model) measured
// slower than MediaPipe for two players, so it stays in the developer playground for comparison
// and is not included in the Console or the desktop app.
for (const dir of mirrors) {
  cpSync(join(publicDir, "mediapipe"), join(dir, "mediapipe"), { recursive: true });
  cpSync(join(publicDir, "models"), join(dir, "models"), { recursive: true, filter: (src) => !src.endsWith(".onnx") });
}
if (failed) {
  console.error("\nSome models could not be fetched. Skeleton tracking will be unavailable; the simulator and Lite mode still work.");
  process.exit(1);
}
