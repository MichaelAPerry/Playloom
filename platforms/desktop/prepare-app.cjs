// Copies the built Console into this folder so it can be packaged with the desktop shell.
const { cpSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const from = join(__dirname, "../../apps/console/dist");
const to = join(__dirname, "app");
if (!existsSync(join(from, "index.html"))) {
  console.error("The Console has not been built. Run `pnpm fetch-models` and `pnpm build` in the repository root first.");
  process.exit(1);
}
if (!existsSync(join(from, "models/pose_landmarker_lite.task"))) {
  console.warn("Warning: the pose model is missing from the build; full body tracking will not work. Run `pnpm fetch-models` and rebuild.");
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`Copied the Console to ${to}`);
