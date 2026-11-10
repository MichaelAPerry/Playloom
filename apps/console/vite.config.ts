import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the build works from any folder, inside Electron, or in an Android WebView.
  base: "./",
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1" },
});
