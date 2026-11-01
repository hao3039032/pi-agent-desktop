/**
 * The migration checklist for every HTTP method under app/api — the single
 * source the inventory generator merges with the extracted route/method
 * facts (docs/migration/api-inventory.json). The plan (M0) requires: every
 * existing HTTP method enters the list with its IPC operation, its
 * implementation owner and its milestone; only methods explicitly marked
 * `removed-web-only` may disappear, nothing is "later".
 *
 * Shape (route-level defaults, per-method overrides allowed):
 * {
 *   "app/api/agent/new/route.ts": {
 *     domain: "agent",            // IPC namespace
 *     milestone: "M2",            // when the IPC replacement lands
 *     owner: "rust-host",         // who implements the operation
 *     methods: { POST: { op: "agent.create", owner?: ..., notes?: "..." } },
 *     notes?: "..."
 *   }
 * }
 *
 * Owners:
 *   rust-host       — Rust desktop host: registries, files, PTY, scheduler,
 *                     native dialogs, updates, IPC surface itself
 *   mgmt-extension  — the restricted pi management instance (fixed SDK deps:
 *                     config edits, enabledModels, credentials, MCP, plugins,
 *                     skills, cron, distro seeding); Rust only gates entry
 *   session-bridge  — operations executed through the target session's pi
 *                     child (bridge ops / session process state)
 *   rust-native     — Tauri native shell (menus, fonts, window, tray)
 *   removed-web-only— browser/PWA/remote-access features dropped with the
 *                     server (plan §二.1); no IPC successor
 *
 * `transitionOnly: true` marks migration scaffolding (no IPC successor;
 * removed with the server once the static frontend owns the flow).
 */

/** Allowed values, asserted by scripts/migration/api-inventory.test.mjs. */
export const OWNERS = ["rust-host", "mgmt-extension", "session-bridge", "rust-native", "removed-web-only"];
export const MILESTONES = ["M2", "M3", "M4", "M5"];

export const ROUTE_MAP = {
  // --- sessions: listing, context, export (Rust history index; live runs
  // --- resolved through the wrapper/child state) -------------------------
  "app/api/sessions/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "sessions.list" } },
    notes: "incremental scanner + project grouping move into the Rust host",
  },
  "app/api/sessions/[id]/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M2",
    methods: {
      GET: { op: "sessions.get" },
      PATCH: { op: "sessions.rename", notes: "session_info entry stays in the session file" },
      DELETE: { op: "sessions.delete" },
    },
  },
  "app/api/sessions/[id]/state/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "sessions.runState", notes: "live wrapper snapshot (isRunning ORs isIdle===false)" } },
  },
  "app/api/sessions/[id]/context/route.ts": {
    domain: "sessions", owner: "mgmt-extension", milestone: "M2",
    methods: { GET: { op: "sessions.context", notes: "context projection over the fixed-SDK session reader; leafId paging" } },
  },
  "app/api/sessions/[id]/entries/[entryId]/thinking/route.ts": {
    domain: "sessions", owner: "mgmt-extension", milestone: "M2",
    methods: { GET: { op: "sessions.entryThinking", notes: "lazy thinking load from the session file" } },
  },
  "app/api/sessions/[id]/entries/[entryId]/tool-result-image/route.ts": {
    domain: "sessions", owner: "mgmt-extension", milestone: "M2",
    methods: { GET: { op: "sessions.entryToolResultImage", notes: "session-reference read-only grant, binary via resource channel" } },
  },
  "app/api/sessions/[id]/export/route.ts": {
    domain: "sessions", owner: "mgmt-extension", milestone: "M2",
    methods: { GET: { op: "sessions.export", notes: "HTML export keeps the non-recursive deep-tree fix" } },
  },
  "app/api/sessions/[id]/reference/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "sessions.reference", notes: "session-file reference grants (read-only, scope-checked)" } },
  },
  "app/api/sessions/[id]/auto-name/route.ts": {
    domain: "sessions", owner: "session-bridge", milestone: "M2",
    methods: { POST: { op: "sessions.autoName", notes: "named bridge op on the session child; never a user-chat prompt" } },
  },
  "app/api/sessions/[id]/chat-access/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "sessions.chatAccessGet" },
      POST: { op: "sessions.chatAccessSet", notes: "chat folder confinement checks stay server-side → host-side" },
    },
  },
  "app/api/sessions/[id]/continue-in-project/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M3",
    methods: { POST: { op: "sessions.continueInProject" } },
  },
  "app/api/sessions/search/route.ts": {
    domain: "sessions", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "sessions.search", notes: "history search over the Rust index" } },
  },

  // --- agent: per-session children, events, fleet ------------------------
  "app/api/agent/new/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: { POST: { op: "agent.create", notes: "spawn the session child; concurrent starts dedup through one start lock" } },
  },
  "app/api/agent/[id]/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: {
      GET: { op: "agent.get" },
      POST: { op: "agent.command", notes: "typed per-command IPC ops (prompt/interrupt/queue/compact/reload/navigate_tree...), NOT a generic passthrough" },
    },
  },
  "app/api/agent/[id]/events/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "agent.subscribeEvents", notes: "Tauri Channel stream: subscriptionId + host epoch + monotonic sequence; snapshot then events" } },
  },
  "app/api/agent/[id]/bash-output/route.ts": {
    domain: "agent", owner: "session-bridge", milestone: "M2",
    methods: { GET: { op: "agent.bashOutput", notes: "session-referenced temp output; inline capped at 5 MiB, download pins a file resource for streaming native save" } },
  },
  "app/api/agent/[id]/lease/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: { POST: { op: "agent.lease", notes: "prevents idle eviction while a window is attached" } },
  },
  "app/api/agent/[id]/subagents/route.ts": {
    domain: "agent", owner: "session-bridge", milestone: "M2",
    methods: {
      GET: { op: "agent.subagentsStatus", notes: "pi-subagents event bus via the bridge (restricted rpc)" },
      POST: { op: "agent.subagentsControl", notes: "steer/interrupt/stop only" },
    },
  },
  "app/api/agent/running/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "agent.runningSnapshot" } },
  },
  "app/api/agent/running/events/route.ts": {
    domain: "agent", owner: "rust-host", milestone: "M2",
    methods: { GET: { op: "agent.subscribeRunning", notes: "running-id set stream" } },
  },

  // --- models, auth, provider usage (management instance) ----------------
  "app/api/models/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { GET: { op: "models.list" } },
  },
  "app/api/models/default/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { PUT: { op: "models.setDefault", notes: "the only writer of global defaults" } },
  },
  "app/api/models/enabled/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "models.enabledGet" },
      PUT: { op: "models.enabledSet", notes: "minimal-edit engine; resync repairs; never string-compare patterns" },
    },
  },
  "app/api/models/nonchat/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { GET: { op: "models.nonchat", notes: "classifier + image models and the global Code mode choice" } },
  },
  "app/api/models/refresh/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "models.refreshCatalog", notes: "network only on explicit user action" } },
  },
  "app/api/models-config/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "modelsConfig.get", notes: "literal-key redaction stays" },
      PUT: { op: "modelsConfig.put" },
    },
  },
  "app/api/models-config/catalog/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { GET: { op: "modelsConfig.catalog", notes: "models.dev pricing presets" } },
  },
  "app/api/models-config/discover/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "modelsConfig.discover", notes: "configured provider's upstream list fetch" } },
  },
  "app/api/models-config/test/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "modelsConfig.test", notes: "named model request; credentials never reach the frontend" } },
  },
  "app/api/auth/providers/route.ts": {
    domain: "auth", owner: "mgmt-extension", milestone: "M3",
    methods: { GET: { op: "auth.providers" } },
  },
  "app/api/auth/api-key/[provider]/route.ts": {
    domain: "auth", owner: "mgmt-extension", milestone: "M3",
    methods: {
      POST: { op: "auth.apiKeyStore" },
      DELETE: { op: "auth.apiKeyDelete", notes: "removeStoredCredentialIfType(); both lists refresh after any change" },
    },
  },
  "app/api/auth/login/[provider]/route.ts": {
    domain: "auth", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "auth.loginStream", notes: "device-code/OAuth progress stream; loopback callback listener in Rust (state + PKCE, closed on done/cancel/timeout)" },
      POST: { op: "auth.loginManualCode" },
    },
  },
  "app/api/auth/logout/[provider]/route.ts": {
    domain: "auth", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "auth.logout" } },
  },
  "app/api/provider-usage/query/route.ts": {
    domain: "models", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "models.providerUsage", notes: "provider usage query over stored credentials" } },
  },

  // --- MCP management ------------------------------------------------------
  "app/api/mcp/route.ts": {
    domain: "mcp", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "mcp.configGet", notes: "reads nothing running; masking stays" },
      POST: { op: "mcp.configAction", notes: "add/update/remove/undo-takeover via the typed action union (NOT raw JSON passthrough)" },
    },
  },
  "app/api/mcp/test/route.ts": {
    domain: "mcp", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "mcp.test", notes: "bounded connection probe, !command queue, redaction" } },
  },
  "app/api/mcp/sign-in/route.ts": {
    domain: "mcp", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "mcp.signInStart", notes: "entry request + status store" } },
  },
  "app/api/mcp/sign-in/[flowId]/route.ts": {
    domain: "mcp", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "mcp.signInStatus" },
      POST: { op: "mcp.signInSubmit", notes: "manual code paste" },
      DELETE: { op: "mcp.signInCancel" },
    },
  },
  "app/api/project-trust/route.ts": {
    domain: "mcp", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "trust.status" },
      POST: { op: "trust.set", notes: "trust.json stays the shared decision store; fresh-folder rules move to the host" },
    },
  },

  // --- plugins & skills -----------------------------------------------------
  "app/api/plugins/route.ts": {
    domain: "plugins", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "plugins.list" },
      POST: { op: "plugins.manage", notes: "install/uninstall via package tooling in the management instance" },
    },
  },
  "app/api/plugins/check/route.ts": {
    domain: "plugins", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "plugins.check", notes: "updates available check" } },
  },
  "app/api/skills/route.ts": {
    domain: "skills", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "skills.list" },
      PATCH: { op: "skills.setDisabled", notes: "disable-model-invocation toggles" },
    },
  },
  "app/api/skills/install/route.ts": {
    domain: "skills", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "skills.install", notes: "npx skills add runner; mirror/progress/cancel semantics stay" } },
  },
  "app/api/skills/search/route.ts": {
    domain: "skills", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "skills.search", notes: "skills.sh search; manual refresh only" } },
  },
  "app/api/skills/update/route.ts": {
    domain: "skills", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "skills.update" } },
  },
  "app/api/skills/check/route.ts": {
    domain: "skills", owner: "mgmt-extension", milestone: "M3",
    methods: { POST: { op: "skills.check" } },
  },

  // --- files, git, worktrees, cwd ------------------------------------------
  "app/api/files/[...path]/route.ts": {
    domain: "files", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "files.read", notes: "canonical-path allow-list stays in Rust; binary via the resource protocol" },
      POST: { op: "files.write" },
    },
  },
  "app/api/file-index/route.ts": {
    domain: "files", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "files.index", notes: "file-tree visibility rules" } },
  },
  "app/api/git/diff/route.ts": {
    domain: "git", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "git.diff" } },
  },
  "app/api/git/status/route.ts": {
    domain: "git", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "git.status" } },
  },
  "app/api/worktrees/route.ts": {
    domain: "worktrees", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "worktrees.list" },
      POST: { op: "worktrees.create" },
      PUT: { op: "worktrees.switch" },
      DELETE: { op: "worktrees.delete" },
    },
  },
  "app/api/worktrees/fetch/route.ts": {
    domain: "worktrees", owner: "rust-host", milestone: "M3",
    methods: { POST: { op: "worktrees.fetch" } },
  },
  "app/api/cwd/browse/route.ts": {
    domain: "cwd", owner: "rust-native", milestone: "M3",
    methods: {
      GET: { op: "cwd.browse", notes: "native folder picker replaces HTML browsing; path listing stays host-side" },
      POST: { op: "cwd.pickFolder", owner: "rust-native" },
    },
  },
  "app/api/cwd/status/route.ts": {
    domain: "cwd", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "cwd.status", notes: "read-only existence check; grants nothing" } },
  },
  "app/api/cwd/validate/route.ts": {
    domain: "cwd", owner: "rust-host", milestone: "M3",
    methods: { POST: { op: "cwd.validate" } },
  },
  "app/api/default-cwd/route.ts": {
    domain: "cwd", owner: "rust-host", milestone: "M3",
    methods: { POST: { op: "cwd.createDefault", notes: "creates ~/pi-cwd-YYYYMMDD" } },
  },
  "app/api/home/route.ts": {
    domain: "cwd", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "cwd.home" } },
  },
  "app/api/open-in-explorer/route.ts": {
    domain: "files", owner: "rust-native", milestone: "M3",
    methods: {
      GET: { op: "files.revealSupport" },
      POST: { op: "files.reveal", notes: "explorer.exe on Windows, never cmd /C start" },
    },
  },

  // --- chat workspace -------------------------------------------------------
  "app/api/chat-workspace/route.ts": {
    domain: "chats", owner: "rust-host", milestone: "M3",
    methods: { GET: { op: "chats.workspaceState", notes: "workspaceKind/chatFolder identity from the host" } },
  },
  "app/api/chat-settings/route.ts": {
    domain: "chats", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "chats.settingsGet" },
      PUT: { op: "chats.settingsSet", notes: "per-chat panel switch + folder-path guards stay" },
    },
  },
  "app/api/chat-folder/reveal/route.ts": {
    domain: "chats", owner: "rust-native", milestone: "M3",
    methods: { POST: { op: "chats.revealFolder" } },
  },
  "app/api/chat-downloads/reveal/route.ts": {
    domain: "chats", owner: "rust-native", milestone: "M3",
    methods: { POST: { op: "chats.revealDownload", notes: "scope-confined to the chat folder" } },
  },
  "app/api/chat-attachments/extract/route.ts": {
    domain: "chats", owner: "rust-host", milestone: "M3",
    methods: { POST: { op: "chats.extractAttachmentText", notes: "DOCX text via the mammoth worker; size caps and error contract stay" } },
  },

  // --- appearance / prefs ----------------------------------------------------
  "app/api/appearance/fonts/route.ts": {
    domain: "appearance", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "appearance.fontsGet" },
      PUT: { op: "appearance.fontsSet", notes: "font settings file; bundled fonts load offline" },
    },
  },
  "app/api/custom-css/route.ts": {
    domain: "appearance", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "appearance.customCssGet" },
      POST: { op: "appearance.customCssSet", notes: "injected after a restricted read; never an iframe-reachable file" },
    },
  },
  "app/api/artifacts/settings/route.ts": {
    domain: "artifacts", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "artifacts.settingsGet" },
      PUT: { op: "artifacts.settingsSet", notes: "the artifacts prompt switch file" },
    },
  },

  // --- tools ------------------------------------------------------------------
  "app/api/tools/settings/route.ts": {
    domain: "tools", owner: "rust-host", milestone: "M3",
    methods: {
      GET: { op: "tools.settingsGet", notes: "presets, Chat-only, exact prompt, Code mode and PowerShell switches" },
      PUT: { op: "tools.settingsSet" },
    },
  },

  // --- terminal -----------------------------------------------------------------
  "app/api/terminal/route.ts": {
    domain: "terminal", owner: "rust-host", milestone: "M4",
    methods: { POST: { op: "terminal.create", notes: "portable-pty replaces node-pty; id/cwd idempotent create" } },
  },
  "app/api/terminal/[id]/route.ts": {
    domain: "terminal", owner: "rust-host", milestone: "M4",
    methods: {
      GET: { op: "terminal.history", notes: "128 Ki UTF-16 history + cursor semantics" },
      POST: { op: "terminal.write", notes: "input + resize serialized; input failures never auto-retried" },
      DELETE: { op: "terminal.close" },
    },
  },
  "app/api/terminal/[id]/events/route.ts": {
    domain: "terminal", owner: "rust-host", milestone: "M4",
    methods: { GET: { op: "terminal.subscribeOutput", notes: "Channel stream; 120s connection lease" } },
  },
  "app/api/terminal/settings/route.ts": {
    domain: "terminal", owner: "rust-host", milestone: "M4",
    methods: {
      GET: { op: "terminal.settingsGet" },
      PUT: { op: "terminal.settingsSet" },
    },
  },

  // --- scheduled tasks ------------------------------------------------------------
  "app/api/scheduled-tasks/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: {
      GET: { op: "tasks.list" },
      POST: { op: "tasks.create", notes: "cron calc via the management extension's fixed-version croner" },
    },
  },
  "app/api/scheduled-tasks/[id]/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: {
      GET: { op: "tasks.get" },
      PATCH: { op: "tasks.update" },
      DELETE: { op: "tasks.delete" },
    },
  },
  "app/api/scheduled-tasks/[id]/run/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: { POST: { op: "tasks.runNow", notes: "marker confirmed by the CLI before the prompt is sent" } },
  },
  "app/api/scheduled-tasks/[id]/runs/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: { GET: { op: "tasks.runs" } },
  },
  "app/api/scheduled-tasks/[id]/runs/[runId]/seen/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: { POST: { op: "tasks.markRunSeen" } },
  },
  "app/api/scheduled-tasks/preview/route.ts": {
    domain: "tasks", owner: "mgmt-extension", milestone: "M4",
    methods: { POST: { op: "tasks.previewCron", notes: "cron next-run preview in the management instance" } },
  },
  "app/api/scheduled-tasks/events/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: { GET: { op: "tasks.subscribeEvents", notes: "Channel stream; scheduler runs while the UI is closed" } },
  },
  "app/api/scheduled-tasks/scheduler/takeover/route.ts": {
    domain: "tasks", owner: "rust-host", milestone: "M4",
    methods: { POST: { op: "tasks.schedulerTakeover", notes: "manual takeover after a stale lease (90s rule)" } },
  },

  // --- desktop shell ---------------------------------------------------------------
  "app/api/desktop/identity/route.ts": {
    domain: "desktop", owner: "rust-host", milestone: "M5",
    methods: { GET: { op: "desktop.identity", notes: "in-process now: the host proves itself to the WebView at IPC handshake" } },
  },
  "app/api/desktop/describe-paths/route.ts": {
    domain: "desktop", owner: "rust-native", milestone: "M3",
    methods: { POST: { op: "desktop.describePaths", notes: "native path fields for dialogs" } },
  },
  "app/api/desktop/fonts/route.ts": {
    domain: "desktop", owner: "rust-native", milestone: "M3",
    methods: { GET: { op: "desktop.fonts" } },
  },
  "app/api/desktop/read-images/route.ts": {
    domain: "desktop", owner: "rust-native", milestone: "M3",
    methods: { POST: { op: "desktop.readImages", notes: "native-picked images → attachment payloads; cap derives from MAX_ATTACHED_IMAGES" } },
  },
  "app/api/desktop/save/route.ts": {
    domain: "desktop", owner: "rust-native", milestone: "M3",
    methods: { POST: { op: "desktop.saveFile", notes: "dialog-scoped destination only; no arbitrary paths" } },
  },

  // --- updates & distro ---------------------------------------------------------------
  "app/api/updates/route.ts": {
    domain: "updates", owner: "rust-native", milestone: "M4",
    methods: { GET: { op: "updates.check", notes: "mirror fallback, URL restrictions, signature/version checks, busy guard" } },
  },
  "app/api/distro/route.ts": {
    domain: "updates", owner: "mgmt-extension", milestone: "M3",
    methods: {
      GET: { op: "distro.status", notes: "service address/key status; key never leaves the host" },
      PUT: { op: "distro.configure", notes: "distro service config + idempotent release seeding" },
    },
  },

  // --- transition-only: scaffolding for the migration itself -----------------
  // The state mirror is how the CURRENT app exports WebView persistence for
  // the static frontend to import (docs/migration/README.md §M1). It has no
  // IPC successor: the new architecture reads the mirror FILE at boot and
  // writes host-owned state natively. Removed with the server in M5.
  "app/api/state-mirror/route.ts": {
    domain: "state-mirror", owner: "rust-host", milestone: "M5",
    methods: {
      GET: { op: null, transitionOnly: true, notes: "read for diagnostics; the importer reads the file directly" },
      PUT: { op: null, transitionOnly: true, notes: "the transition version writes the mirror file" },
    },
  },

  // --- web-only: removed with the server (plan §二.1) -----------------------------------
  "app/api/web-auth/route.ts": {
    domain: "web", owner: "removed-web-only", milestone: "M5",
    methods: {
      GET: { op: null, notes: "web password gate — no desktop successor" },
      POST: { op: null },
      DELETE: { op: null },
    },
  },
  "app/api/push/config/route.ts": {
    domain: "web", owner: "removed-web-only", milestone: "M5",
    methods: { GET: { op: null, notes: "Web Push/VAPID — desktop notifications go through the tray/notifier" } },
  },
  "app/api/push/subscribe/route.ts": {
    domain: "web", owner: "removed-web-only", milestone: "M5",
    methods: { POST: { op: null } },
  },
};
