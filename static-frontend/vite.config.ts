import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The migration plan fixes the output: the production Tauri shell loads the
// app-embedded index.html from ../desktop/frontend. `base: "./"` keeps every
// asset reference relative, so the bundle works from the custom protocol and
// file origins alike. Development still runs through `npm run dev` at the
// repo root (devUrl) until the Rust host wiring lands in M2; this skeleton
// exists so the window can render WITHOUT Next.js and WITHOUT a pi child.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "../desktop/frontend"),
    emptyOutDir: false, // never delete the launcher placeholder in M1
    target: "es2022",
  },
});
