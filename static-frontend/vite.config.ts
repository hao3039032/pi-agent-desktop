import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The migration plan fixes the output: the production Tauri shell loads the
// app-embedded index.html from ../desktop/frontend. `base: "./"` keeps every
// asset reference relative.
//
// The UI migration reuses the EXISTING component tree (plan §四: 保留现有组件/
// hooks 分层、CSS 加载顺序和菜单体系): `@/` aliases to the repo root, and the
// handful of Next-specific client APIs are aliased to shims in src/shims.
// The Next app keeps building unchanged until M5; the static build swaps the
// data layer module-by-module through the aliases below (no fetch
// monkey-patching — each swap is a typed IPC implementation).
const root = resolve(import.meta.dirname, "..");

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: [
      // The Next client-API surface the app touches (surveyed: navigation in
      // AppShell, image in the web-only login page — the shim keeps any
      // straggler import compiling).
      ...[
        ["next/navigation", "navigation"],
        ["next/image", "image"],
        ["next/dynamic", "dynamic"],
        ["next/link", "link"],
      ].map(([module, shim]) => ({
        find: new RegExp(`^${module}$`),
        replacement: resolve(import.meta.dirname, `src/shims/next/${shim}`),
      })),
      // The data-layer swaps (M2): typed IPC implementations replace the
      // HTTP clients module-by-module. The Next app keeps the originals.
      {
        find: /^@\/lib\/agent-client$/,
        replacement: resolve(import.meta.dirname, "src/data/agent-client.ts"),
      },
      {
        find: /^@\/lib\/session-event-source$/,
        replacement: resolve(import.meta.dirname, "src/data/session-event-source.ts"),
      },
      {
        // The mirror hook swaps its HTTP flush for the IPC bridge; the
        // import itself runs before mount in app-main.tsx.
        find: /^@\/hooks\/useStateMirror$/,
        replacement: resolve(import.meta.dirname, "src/data/state-mirror.ts"),
      },
      // The repo's path alias: the existing components/hooks/lib compile as-is.
      { find: /^@\/(.*)$/, replacement: resolve(root, "$1") },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, "../desktop/frontend"),
    emptyOutDir: false, // never delete the launcher placeholder until M5
    target: "es2022",
    // The app tree is large; chunk warnings are expected during the
    // migration. Chunking is tuned with the real bundle at M2's end.
    chunkSizeWarningLimit: 4096,
  },
});
