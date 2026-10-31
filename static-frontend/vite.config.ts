import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The migration plan fixes a GIT-IGNORED build target: the static app is
// built into ../desktop/frontend-static (a full, self-contained bundle —
// `emptyOutDir: true` keeps it exactly one build, no stale hashed assets).
// The TRACKED ../desktop/frontend/index.html stays the launcher placeholder
// the production Tauri shell ships today (frontendDist needs it to resolve;
// the window still loads the packaged Next server until the M5 switch).
// When M5 flips the shell to the static app, desktop:prepare stages
// frontend-static into the package's frontend dir — a deliberate, reviewed
// step, never an accidental commit of half a build. `base: "./"` keeps
// every asset reference relative.
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
      {
        // The file-tree service (listing + linked-directory grant) swaps
        // /api/files for files.list / files.allowLink over IPC.
        find: /^@\/lib\/file-service$/,
        replacement: resolve(import.meta.dirname, "src/data/file-service.ts"),
      },
      {
        // The session-view service (view read, context paging, state poll,
        // session create, lease renewal) swaps the /api/sessions and
        // /api/agent reads for sessions.get / sessions.context /
        // sessions.state / agent.create / sessions.lease over IPC.
        find: /^@\/lib\/session-view-service$/,
        replacement: resolve(import.meta.dirname, "src/data/session-view-service.ts"),
      },
      {
        // The session-list service (catalogue load, running-set stream,
        // home dir) swaps /api/sessions, /api/agent/running/events and
        // /api/home for sessions.list / agent.subscribeRunning / cwd.home.
        find: /^@\/lib\/session-list-service$/,
        replacement: resolve(import.meta.dirname, "src/data/session-list-service.ts"),
      },
      {
        // The workspace service (chat root, cwd validation, default cwd)
        // swaps /api/chat-workspace, /api/cwd/validate and
        // /api/default-cwd for chats.workspaceState / cwd.validate /
        // cwd.createDefault.
        find: /^@\/lib\/workspace-service$/,
        replacement: resolve(import.meta.dirname, "src/data/workspace-service.ts"),
      },
      {
        // The connection probe swaps the /api/home health check for a real
        // host round trip (desktop.identity over IPC): the static app has no
        // HTTP server, so /api/home would always paint a fake offline banner.
        find: /^@\/lib\/desktop-connection$/,
        replacement: resolve(import.meta.dirname, "src/data/desktop-connection.ts"),
      },
      {
        // The scheduled-tasks store swaps the /api/scheduled-tasks list and
        // its EventSource for the host's tasks.list (real data) with no
        // event stream yet — the scheduler's host wiring (M4) will add one.
        // Without this the stream retries the SPA fallback forever.
        find: /^@\/hooks\/useScheduledTasks$/,
        replacement: resolve(import.meta.dirname, "src/data/scheduled-tasks-store.ts"),
      },
      {
        // The project-trust mount probe swaps GET /api/project-trust's status
        // half for trust.status over IPC (the Rust port of
        // getProjectTrustStatus). The MCP listing and the trust WRITE stay
        // on the HTTP route until their M3 ops land.
        find: /^@\/lib\/project-trust-client$/,
        replacement: resolve(import.meta.dirname, "src/data/project-trust-client.ts"),
      },
      {
        // The models service (selector data + the selectors' star) swaps
        // /api/models and /api/models/default for models.list /
        // models.setDefault over IPC — the host routes them to a cwd-scoped
        // management instance whose extension op runs the repo's own
        // lib/models-service.ts (the same function the Next route serves).
        find: /^@\/lib\/models-service$/,
        replacement: resolve(import.meta.dirname, "src/data/models-service.ts"),
      },
      {
        // The enabledModels service (the Models panel's switches) swaps
        // GET/PUT /api/models/enabled for models.enabledGet /
        // models.enabledSet over IPC — the same minimal-edit composition the
        // Next route serves (lib/enabled-models-service.server.ts).
        find: /^@\/lib\/enabled-models-service$/,
        replacement: resolve(import.meta.dirname, "src/data/enabled-models-service.ts"),
      },
      {
        // The models-config service swaps GET/PUT /api/models-config for
        // modelsConfig.get / modelsConfig.put over IPC (the redaction and
        // the literal-key merge stay inside the management instance's
        // composition on both paths).
        find: /^@\/lib\/models-config-service$/,
        replacement: resolve(import.meta.dirname, "src/data/models-config-service.ts"),
      },
      // The repo's path alias: the existing components/hooks/lib compile as-is.
      { find: /^@\/(.*)$/, replacement: resolve(root, "$1") },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, "../desktop/frontend-static"),
    // A build owns its output dir completely: stale hashed chunks from an
    // earlier build must never ship next to the new ones.
    emptyOutDir: true,
    target: "es2022",
    // The app tree is large; chunk warnings are expected during the
    // migration. Chunking is tuned with the real bundle at M2's end.
    chunkSizeWarningLimit: 4096,
  },
});
