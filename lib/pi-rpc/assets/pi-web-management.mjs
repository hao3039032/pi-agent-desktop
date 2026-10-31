/**
 * pi-web management extension (M3 skeleton).
 *
 * Runs INSIDE a management instance (`pi --mode rpc --no-session`,
 * discovery off; the host passes this file as the only --extension). The
 * management protocol (plan §五 管理实例):
 *
 *   request:   /pi-web:mgmt <requestId> <base64url-json>
 *              payload { op, args, nonce }
 *   reply:     one notify "PI_WEB_MGMT_V1 " + JSON
 *              { rid, nonce, ok, result | error, code }
 *
 * - commands are consumed by the extension runtime: NO run starts and the
 *   tokens never become model input;
 * - the nonce binds replies to the spawning host (PI_WEB_MGMT_NONCE), the
 *   same discipline the session bridge uses;
 * - unknown/unloaded ops fail with a code and the instance stays usable;
 * - progress messages carry {rid, nonce, progress}; only sanitized, bounded
 *   values belong there, never credentials.
 * - long operations receive an operation context with signal and progress.
 *   Aborting the signal is only a request. An operation may report code
 *   "cancelled" only after it has actually stopped and cleaned up.
 *
 * Dependencies load from the VENDORED management tree by absolute path
 * (the host injects PI_WEB_MANAGED_MODULES): croner for cron math, the
 * pi SDK for file-based session access. The module graph is this tree's
 * own — never the child pi host's internal instances (plan §五).
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child's runtime before any bundler exists.
 */

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const RESULT_PREFIX = "PI_WEB_MGMT_V1 ";
const PROGRESS_PREFIX = "PI_WEB_MGMT_PROGRESS_V1 ";
const MGMT_PROTOCOL_VERSION = 1;

/** The ops this build supports (the capability table). */
const CAPABILITIES = ["sys.capabilities", "cron.preview", "cron.previousRuns", "cron.countSlots", "session.readHeader", "session.readEntries", "session.readContext", "session.readView", "session.projectSnapshot", "chat.systemPrompt", "session.chatOnlyPrompt", "models.list", "models.setDefault", "models.enabledGet", "models.enabledSet", "modelsConfig.get", "modelsConfig.put", "modelsConfig.catalog", "modelsConfig.discover", "modelsConfig.test", "models.nonchat", "models.refreshCatalog", "models.providerUsage", "docx.extractText", "session.search", "session.fork", "session.export", "terminal.settingsGet", "terminal.settingsSet", "terminal.resolveShell", "skills.list", "skills.setDisabled", "plugins.list", "skills.search", "plugins.check", "skills.check", "plugins.setEnabled"];

function managedDir() {
  const dir = process.env.PI_WEB_MANAGED_MODULES;
  if (!dir) throw new Error("the management tree is not configured (PI_WEB_MANAGED_MODULES)");
  return dir;
}

/** Lazily-loaded vendored modules (one isolated graph, cached per child). */
const lazy = new Map();
function managed(name) {
  if (!lazy.has(name)) {
    lazy.set(name, import(`${managedDir()}/${name}`));
  }
  return lazy.get(name);
}

export default function piWebManagement(pi) {
  const active = new Map();
  pi.registerCommand("pi-web:mgmt", {
    description: "pi-web internal: management operations",
    handler: async (args, ctx) => {
      const requestId = String(args ?? "").trim().split(/\s+/)[0] ?? "";
      let payload;
      try {
        const token = String(args ?? "").trim().split(/\s+/).slice(1).join(" ");
        payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      } catch {
        return requestId;
      }
      const nonce = process.env.PI_WEB_MGMT_NONCE ?? "";
      if (!nonce || payload.nonce !== nonce) return requestId;
      if (payload.op === "__cancel") {
        const task = active.get(payload.args?.rid);
        if (task) task.abort();
        answer(ctx, requestId, nonce, { ok: true, result: { requested: Boolean(task) } });
        return requestId;
      }
      if (active.has(requestId) || active.size >= 128) {
        answer(ctx, requestId, nonce, { ok: false, error: "task capacity or duplicate request", code: "busy" });
        return requestId;
      }
      const controller = new AbortController();
      active.set(requestId, controller);
      const opContext = {
        signal: controller.signal,
        progress(value) {
          try {
            const message = JSON.stringify({ rid: requestId, nonce, progress: value });
            if (Buffer.byteLength(message) <= 4096) ctx.ui.notify(PROGRESS_PREFIX + message, "info");
          } catch {
            // Progress is best-effort; a non-serializable value cannot fail an operation.
          }
        },
      };
      void (async () => {
        try {
          const result = await runOp(payload.op ?? "", payload.args ?? {}, requestId, ctx, opContext);
          answer(ctx, requestId, nonce, { ok: true, result });
        } catch (error) {
          answer(ctx, requestId, nonce, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: error && typeof error.code === "string" ? error.code : "op_failed",
          });
        } finally {
          active.delete(requestId);
        }
      })();
      return requestId;
    },
  });
}

function answer(ctx, rid, nonce, payload) {
  // Sanitized rid: a malformed one cannot match a pending host request.
  const safeRid = String(rid ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  ctx.ui.notify(
    RESULT_PREFIX + JSON.stringify({ rid: safeRid, nonce, ...payload }),
    "info",
  );
}

function opError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function runOp(op, args, rid, ctx, opContext) {
  switch (op) {
    case "sys.capabilities":
      return { version: MGMT_PROTOCOL_VERSION, ops: CAPABILITIES };

    case "chat.systemPrompt":
      return chatSystemPrompt(args);

    case "session.chatOnlyPrompt":
      return sessionChatOnlyPrompt(args);

    case "docx.extractText": {
      const mammothMod = await managed("mammoth/lib/index.js");
      const mammoth = mammothMod.default ?? mammothMod;
      let buffer;
      if (typeof args.path === "string" && args.path) {
        const { readFile } = await import("node:fs/promises");
        buffer = await readFile(args.path);
      } else if (typeof args.data === "string" && args.data) {
        buffer = Buffer.from(args.data, "base64");
      } else {
        throw opError("invalid_args", "not-text");
      }
      if (!buffer || buffer.length === 0) throw opError("invalid_args", "not-text");
      if (buffer.length > 10 * 1024 * 1024) throw opError("too_large", "too-large");
      try {
        const { value } = await mammoth.extractRawText({ buffer });
        const text = value.replace(/\r\n?/g, "\n").trim();
        if (!text) throw opError("not_text", "not-text");
        if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw opError("too_large", "too-large");
        return { text };
      } catch (err) {
        if (err && typeof err.code === "string") throw err;
        throw opError("not_text", "not-text");
      }
    }

    case "cron.preview": {
      const { Cron } = await managed("croner/dist/croner.js");
      const expr = requireString(args, "expr");
      const timezone = typeof args.timezone === "string" ? args.timezone : undefined;
      const count = clampInt(args.count, 1, 100, 10);
      validateCron(Cron, expr, timezone);
      const cron = new Cron(expr, { timezone, paused: true });
      try {
        const runs = cron.nextRuns(count).map((date) => date.toISOString());
        return { expr, timezone: timezone ?? "local", runs };
      } finally {
        cron.stop();
      }
    }

    case "cron.previousRuns": {
      const { Cron } = await managed("croner/dist/croner.js");
      const expr = requireString(args, "expr");
      const timezone = typeof args.timezone === "string" ? args.timezone : undefined;
      const from = new Date(requireString(args, "fromISO"));
      if (Number.isNaN(from.getTime())) throw opError("invalid_args", "fromISO is not a date");
      const count = clampInt(args.count, 1, 100, 10);
      validateCron(Cron, expr, timezone);
      const cron = new Cron(expr, { timezone, paused: true });
      try {
        const runs = cron.previousRuns(count, from).map((date) => date.toISOString());
        return { expr, timezone: timezone ?? "local", runs };
      } finally {
        cron.stop();
      }
    }

    case "cron.countSlots": {
      // How many slots fall in (sinceISO, untilISO] — the scheduler's
      // skipped-slot count. Bounded: a pathological expression inside a
      // year-long window must not spin forever (the cap keeps the count
      // honest by refusing instead of truncating).
      const { Cron } = await managed("croner/dist/croner.js");
      const expr = requireString(args, "expr");
      const timezone = typeof args.timezone === "string" ? args.timezone : undefined;
      const since = new Date(requireString(args, "sinceISO"));
      const until = new Date(requireString(args, "untilISO"));
      if (Number.isNaN(since.getTime())) throw opError("invalid_args", "sinceISO is not a date");
      if (Number.isNaN(until.getTime())) throw opError("invalid_args", "untilISO is not a date");
      if (until <= since) return { count: 0 };
      const MAX_SLOTS = 100_000;
      const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
      if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
        throw opError("invalid_args", "the countSlots window exceeds one year");
      }
      validateCron(Cron, expr, timezone);
      const cron = new Cron(expr, { timezone, paused: true });
      try {
        // (since, until] semantics: croner's previousRuns(reference) is
        // strictly before the reference AND skips a slot within the same
        // millisecond family (a 12:00:00.001 reference answers 11:50, not
        // 12:00), so the cursor starts one full second past until — cron
        // has minute granularity at finest, and the walk then counts the
        // slot exactly AT until.
        let count = 0;
        let cursor = new Date(until.getTime() + 1000);
        while (cursor > since) {
          const [previous] = cron.previousRuns(1, cursor);
          if (!previous || previous >= cursor || previous <= since) break;
          count += 1;
          cursor = previous;
          if (count > MAX_SLOTS) throw opError("invalid_args", "too many slots in the window");
        }
        return { count };
      } finally {
        cron.stop();
      }
    }

    case "session.export": {
      const file = realpath(requireString(args, "file"));
      const output = requireString(args, "output");
      const exporter = await managed("@earendil-works/pi-coding-agent/dist/core/export-html/index.js");
      const projection = await managedProjection();
      await exporter.exportFromFile(file, output);
      const { readFileSync } = await import("node:fs");
      const patched = projection.patchExportHtml(readFileSync(output, "utf8"));
      writeFileSync(output, patched, "utf8");
      return { ok: true };
    }

    case "session.fork": {
      const file = realpath(requireString(args, "file"));
      const sdk = await managedSdk();
      const source = sdk.SessionManager.open(file);
      const entryId = requireString(args, "entryId");
      const entry = source.getEntry(entryId);
      if (!entry) throw opError("invalid_args", "Invalid entry ID for forking");
      const mode = requireString(args, "mode");
      if (!["fork", "fork_branch", "clone"].includes(mode)) throw opError("invalid_args", "invalid fork mode");
      const leaf = mode === "fork" ? entry.parentId : entryId;
      if (mode === "clone" && !source.getBranch(leaf).some((item) => item.type === "message" && item.message?.role === "assistant")) {
        return { cancelled: true };
      }
      let target;
      if (leaf) {
        const path = source.createBranchedSession(leaf);
        if (!path) throw new Error("Failed to create forked session");
        target = existsSync(path) ? sdk.SessionManager.open(path) : source;
      } else {
        target = sdk.SessionManager.create(source.getCwd(), source.getSessionDir(), { parentSession: file });
      }
      const targetFile = target.getSessionFile();
      if (!targetFile) throw new Error("Forked session is missing a session file");
      if (!existsSync(targetFile)) {
        writeFileSync(targetFile, [target.getHeader(), ...target.getEntries()].map((item) => JSON.stringify(item)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
      }
      return { cancelled: false, newSessionId: target.getSessionId() };
    }

    case "session.search": {
      const query = requireString(args, "query");
      if (!Array.isArray(args.sessions) || args.sessions.length > 501) {
        throw opError("invalid_args", "invalid session search catalogue");
      }
      const projection = await managedProjection();
      return projection.searchSessionContents(args.sessions, query);
    }

    case "session.readHeader": {
      const sdk = await managedSdk();
      const file = requireString(args, "file");
      const manager = sdk.SessionManager.open(realpath(file));
      return { header: manager.getHeader() };
    }

    case "session.readEntries": {
      const sdk = await managedSdk();
      const file = requireString(args, "file");
      const manager = sdk.SessionManager.open(realpath(file));
      const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInt(args.limit, 1, 1000, 100);
      const entries = manager.getEntries();
      return {
        total: entries.length,
        offset,
        entries: entries.slice(offset, offset + limit),
      };
    }

    // --- the session-view projection (M2: sessions.context / sessions.get) ---
    //
    // One projection implementation: these ops run the repo's own
    // lib/session-projection.ts code, bundled into the managed tree by
    // scripts/migration/build-management-modules.mjs — the exact functions
    // the Next server's GET /api/sessions/[id] and /context routes run.
    // The host (src-tauri) resolves the session id to a FILE and passes the
    // absolute path; this extension never guesses the agent dir.
    //
    // Deliberate divergence from the HTTP routes: no `sessionId` is passed
    // to buildSessionContext, so large tool-result images are omitted with a
    // bounded note instead of being rewritten to /api/... URLs (the desktop
    // host has no HTTP server; the lazy-image channel is the resource
    // protocol, wired with its own inventory op).

    case "session.readContext": {
      // The /api/sessions/[id]/context contract: the newest `tail` entries of
      // one branch (leafId), or the ancestors of a `before` cursor (paging
      // upward without duplicating `before`).
      const projection = await managedProjection();
      const file = requireString(args, "file");
      const manager = await openManagedSession(file);
      const leafId = optionalString(args, "leafId");
      const before = optionalString(args, "before");
      const tail = clampInt(args.tail, 1, 1000, 50);
      const context = projection.buildSessionContext(manager.getEntries(), before ?? leafId, {
        deferThinking: args.deferThinking === true,
        deferToolResultImages: args.deferMedia === true,
        tail,
        excludeLeaf: Boolean(before),
        wholeTurns: args.wholeTurns === true,
      });
      return { context, tail, before: before ?? null };
    }

    case "session.readView": {
      // The disk half of GET /api/sessions/[id]: header, leaf, projected
      // (optionally summary) tree, context, stats, active time, the
      // persisted tool pin and the subagent relation for a session no live
      // child owns.
      const projection = await managedProjection();
      const file = requireString(args, "file");
      const manager = await openManagedSession(file);
      const entries = manager.getEntries();
      const header = manager.getHeader();
      const subagent = header
        ? projection.readSubagentRun(entries, header.id ?? "", realpath(file))
        : null;
      return {
        header,
        ...projectView(projection, {
          entries,
          leafId: manager.getLeafId(),
          rawTree: manager.getTree(),
          summaryTree: args.summaryTree === true,
          deferThinking: args.deferThinking === true,
          deferMedia: args.deferMedia === true,
          tail: clampInt(args.tail, 1, 1000, 50),
          wholeTurns: args.wholeTurns === true,
        }),
        ...(subagent
          ? {
              relation: {
                kind: "subagent",
                parentSessionId: subagent.parentSessionId,
                profile: subagent.profile,
                description: subagent.description,
                status: subagent.status,
              },
            }
          : {}),
      };
    }

    case "session.projectSnapshot": {
      // The LIVE half of GET /api/sessions/[id]: the host took the child's
      // one-shot snapshot (get_entries + get_tree — entries the file may not
      // hold yet, plus the in-memory branch pointer navigateTree moved) and
      // hands it over as a JSON file; big payloads never ride the prompt
      // envelope. The file is the host's own temp file; this op reads it and
      // never learns anything else about the host.
      const projection = await managedProjection();
      const snapshotFile = requireString(args, "snapshotFile");
      let snapshot;
      try {
        snapshot = JSON.parse(await readFileUtf8(snapshotFile));
      } catch (error) {
        throw opError("invalid_args", `the snapshot file is not readable JSON: ${errorMessage(error)}`);
      }
      if (!Array.isArray(snapshot?.entries) || !Array.isArray(snapshot?.tree)) {
        throw opError("invalid_args", "the snapshot needs entries[] and tree[]");
      }
      if (snapshot.leafId !== null && typeof snapshot.leafId !== "string") {
        throw opError("invalid_args", "the snapshot leafId must be a string or null");
      }
      const view = projectView(projection, {
        entries: snapshot.entries,
        leafId: snapshot.leafId,
        rawTree: snapshot.tree,
        summaryTree: args.summaryTree === true,
        deferThinking: args.deferThinking === true,
        deferMedia: args.deferMedia === true,
        tail: clampInt(args.tail, 1, 1000, 50),
        wholeTurns: args.wholeTurns === true,
      });
      // The subagent relation needs the session's own identity (the meta
      // entry records parentSessionId; readSubagentRun echoes it back).
      const sessionId = optionalString(args, "sessionId");
      const sessionPath = optionalString(args, "sessionPath");
      const subagent = sessionId && sessionPath
        ? projection.readSubagentRun(snapshot.entries, sessionId, sessionPath)
        : null;
      return {
        ...view,
        ...(subagent
          ? {
              relation: {
                kind: "subagent",
                parentSessionId: subagent.parentSessionId,
                profile: subagent.profile,
                description: subagent.description,
                status: subagent.status,
              },
            }
          : {}),
      };
    }

    // --- the models domain (M3: the selector's data + the saved defaults) --
    //
    // ONE composition, two thin adapters: the Next routes
    // (app/api/models/route.ts, app/api/models/default/route.ts) and these
    // ops both run lib/models-service.server.ts, bundled into the managed tree by
    // scripts/migration/build-management-modules.mjs. The host — never the
    // extension — resolves the cwd and enforces the access policy, so these
    // ops trust the `cwd` argument the way the route trusted its own
    // allow-listed resolution.
    case "plugins.check":
    case "skills.check": {
      const projection = await managedProjection();
      const cwd = realpath(requireString(args, "cwd"));
      const scope = args.scope;
      if (scope !== undefined && scope !== "global" && scope !== "project") throw opError("invalid_args", "invalid scope");
      if (op === "plugins.check") return projection.checkManagedPluginUpdates(cwd, optionalString(args, "source"), scope);
      return projection.checkManagedSkillUpdates(cwd, optionalString(args, "package"), scope);
    }
    case "skills.search": {
      const projection = await managedProjection();
      return { results: await projection.searchSkills(requireString(args, "query"), args.limit, opContext.signal) };
    }
    case "plugins.install": {
      if (process.env.PI_WEB_EXCLUSIVE_MUTATION !== "1") throw opError("invalid_context", "exclusive management instance required");
      const projection = await managedProjection();
      const cwd = realpath(requireString(args, "cwd"));
      const source = requireString(args, "source").trim();
      if (!source || source.length > 4096 || (args.scope !== "global" && args.scope !== "project")) throw opError("invalid_args", "invalid source or scope");
      try {
        return await projection.runPluginMutationTask({ cwd, source, scope: args.scope, action: "install" }, opContext);
      } catch (error) {
        if (error?.code === "outcome_unknown") throw opError("outcome_unknown", "Installation outcome unknown");
        throw opError("op_failed", "Plugin installation failed; check the source and project trust");
      }
    }
    case "plugins.setEnabled": {
      const projection = await managedProjection();
      const cwd = realpath(requireString(args, "cwd"));
      if (args.action !== "enable" && args.action !== "disable") throw opError("invalid_args", "invalid action");
      if (!Array.isArray(args.packages) || !args.packages.length || args.packages.length > 512 || !args.packages.every((entry) => entry && typeof entry.source === "string" && entry.source.trim() && (entry.scope === "global" || entry.scope === "project"))) throw opError("invalid_args", "invalid packages");
      if (args.single === true) {
        if (args.packages.length !== 1) throw opError("invalid_args", "single requires one package");
        return projection.managePlugins({ cwd, action: args.action, ...args.packages[0] });
      }
      return projection.managePlugins({ cwd, action: args.action, packages: args.packages });
    }
    case "plugins.list": {
      const projection = await managedProjection();
      return projection.readPlugins(realpath(requireString(args, "cwd")));
    }
    case "skills.list": {
      const projection = await managedProjection();
      return projection.loadSkillsWithInstallInfo(realpath(requireString(args, "cwd")));
    }
    case "skills.setDisabled": {
      const projection = await managedProjection();
      const cwd = realpath(requireString(args, "cwd"));
      if (!Array.isArray(args.filePaths) || !args.filePaths.every((p) => typeof p === "string" && p)
          || typeof args.disableModelInvocation !== "boolean") {
        throw opError("invalid_args", "filePaths and disableModelInvocation are required");
      }
      if (args.allowedRoots !== undefined && (!Array.isArray(args.allowedRoots) || !args.allowedRoots.every((p) => typeof p === "string" && p))) {
        throw opError("invalid_args", "allowedRoots must be a list of paths");
      }
      return projection.setVisibleSkillsDisabled(cwd, args.filePaths, args.disableModelInvocation, args.allowedRoots);
    }
    case "models.list": {
      const projection = await managedProjection();
      const cwd = requireString(args, "cwd");
      return projection.loadScopedModelsData(realpath(cwd));
    }

    // The selectors' star: the ONLY writer of the global defaults. The shared
    // path's shaped refusals map to the management protocol's codes (the
    // route answers the same cases 409/404).
    case "models.setDefault": {
      const projection = await managedProjection();
      const cwd = requireString(args, "cwd");
      const edit = projection.parseDefaultPreferencesEdit(args);
      if (!edit) {
        throw opError("invalid_args", "Expected provider and modelId, or a valid thinkingLevel");
      }
      try {
        const parsed = await projection.saveScopedDefaultPreferences(realpath(cwd), edit);
        return {
          ok: true,
          ...(parsed.model ? { defaultModel: parsed.model } : {}),
          ...(parsed.thinkingLevel ? { defaultThinkingLevel: parsed.thinkingLevel } : {}),
        };
      } catch (error) {
        if (error instanceof projection.ProjectScopeShadowError) {
          throw opError("project_scope", error.message);
        }
        if (error instanceof projection.ModelNotAvailableError) {
          throw opError("not_found", error.message);
        }
        throw error;
      }
    }

    // --- the enabledModels domain (M3: the Models panel's switches) -------
    //
    // ONE composition again: these ops run the repo's own
    // lib/enabled-models-service.server.ts (the enabledModels seam), the
    // exact functions the Next /api/models/enabled route serves — the
    // minimal-edit engine and the SDK resolver adapter underneath it are
    // the unchanged lib/enabled-models.ts / lib/enabled-models-runtime.ts.
    // The host — never the extension — resolves the cwd and enforces the
    // access policy; the shaped refusals map to the protocol's codes
    // (`project_scope` / `last_model`, the route's 409 reasons).
    case "models.enabledGet": {
      const projection = await managedProjection();
      const cwd = requireString(args, "cwd");
      return projection.loadEnabledModelsView(realpath(cwd));
    }

    case "models.enabledSet": {
      const projection = await managedProjection();
      const cwd = requireString(args, "cwd");
      const parsed = projection.parseEnabledModelsMutation(args);
      if (!parsed.ok) {
        throw opError("invalid_args", parsed.error);
      }
      try {
        return await projection.applyEnabledModelsEdit(realpath(cwd), parsed.mutation);
      } catch (error) {
        if (error instanceof projection.EnabledModelsRefusalError) {
          throw opError(error.reason.replace("-", "_"), error.message);
        }
        throw error;
      }
    }

    // The Models panel's models.json read: the redaction is part of the
    // ONE composition (lib/models-config-store.ts's readRedactedModelsConfig,
    // the same function the Next /api/models-config route serves), so a
    // stored literal apiKey can never reach any frontend.
    case "terminal.settingsGet": {
      return (await managedProjection()).getTerminalSettings();
    }
    case "terminal.settingsSet": {
      return (await managedProjection()).setTerminalShell(requireString(args, "shell"));
    }
    case "terminal.resolveShell": {
      return (await managedProjection()).resolveTerminalShell();
    }
    case "modelsConfig.get": {
      const projection = await managedProjection();
      return projection.readRedactedModelsConfig();
    }

    // The Models panel's models.json save: the write composition (the
    // stored-literal apiKey merge, cost normalization, the blank-row
    // sanitize, the private atomic write) is ONE implementation in
    // lib/models-config-service.server.ts's saveModelsConfig — the same
    // function the Next route's PUT serves. A models.json the composition
    // cannot read is never replaced: the ModelsConfigReadError maps to the
    // route's 409 shape (`models_config_read`, which the host carries as
    // the protocol's preserved reason).
    case "modelsConfig.put": {
      const projection = await managedProjection();
      if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.config !== "object"
        || args.config === null || Array.isArray(args.config)) {
        throw opError("invalid_args", "config must be a JSON object");
      }
      try {
        projection.saveModelsConfig(args.config);
        return { success: true };
      } catch (error) {
        if (error instanceof projection.ModelsConfigReadError) {
          throw opError("models_config_read", error.message);
        }
        throw error;
      }
    }

    // --- models extras (M3: catalog presets, discovery, test, nonchat, refresh, provider usage) ---
    case "modelsConfig.catalog": {
      const projection = await managedProjection();
      const q = typeof args?.q === "string" ? args.q : undefined;
      const provider = typeof args?.provider === "string" ? args.provider : undefined;
      const baseUrl = typeof args?.baseUrl === "string" ? args.baseUrl : undefined;
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      try {
        return await projection.queryModelCatalog({ q, provider, baseUrl, limit });
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    case "modelsConfig.discover": {
      const projection = await managedProjection();
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw opError("invalid_args", "args must be an object");
      }
      const providerName = typeof args.providerName === "string" ? args.providerName.trim() : "";
      if (!providerName) {
        throw opError("invalid_args", "providerName is required");
      }
      if (!args.provider || typeof args.provider !== "object" || Array.isArray(args.provider)) {
        throw opError("invalid_args", "provider must be an object");
      }
      try {
        return await projection.discoverModels({ providerName, provider: args.provider });
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    case "modelsConfig.test": {
      const projection = await managedProjection();
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw opError("invalid_args", "args must be an object");
      }
      const providerName = typeof args.providerName === "string" ? args.providerName.trim() : "";
      if (!providerName) {
        throw opError("invalid_args", "providerName is required");
      }
      if (!args.provider || typeof args.provider !== "object" || Array.isArray(args.provider)) {
        throw opError("invalid_args", "provider must be an object");
      }
      if (!args.model || typeof args.model !== "object" || Array.isArray(args.model)) {
        throw opError("invalid_args", "model must be an object");
      }
      const modelId = typeof args.model.id === "string" ? args.model.id.trim() : "";
      if (!modelId) {
        throw opError("invalid_args", "Model ID is required");
      }
      try {
        return await projection.testModel({
          providerName,
          provider: args.provider,
          model: args.model,
        });
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    case "models.nonchat": {
      const projection = await managedProjection();
      try {
        return await projection.loadNonChatModels();
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    case "models.refreshCatalog": {
      const projection = await managedProjection();
      const provider = typeof args?.provider === "string" ? args.provider.trim() : undefined;
      try {
        return await projection.refreshProviderCatalogs({ provider });
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    case "models.providerUsage": {
      const projection = await managedProjection();
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw opError("invalid_args", "args must be an object");
      }
      const providerId = typeof args.providerId === "string" ? args.providerId.trim() : "";
      if (!providerId) {
        throw opError("invalid_args", "providerId is required");
      }
      try {
        return await projection.queryProviderUsageReport(providerId);
      } catch (error) {
        throw opError("io", error.message);
      }
    }

    default:
      throw opError("unknown_op", `unknown management op: ${JSON.stringify(op).slice(0, 60)}`);
  }
}

// --- the spawn prompts (sessions.create's chat / chat-only kinds) ---------
//
// The Rust host builds a child's spawn plan BEFORE the child exists; these
// two ops are the ONE implementation of the exact prompts the Next factory
// built (lib/chat-workspace-prompt.ts, and the context-files prompt over the
// SDK's own resource loader) — never a Rust copy of the text.

async function chatSystemPrompt(args) {
  const projection = await managedProjection();
  const filesEnabled = args.filesEnabled === true;
  const scope = {
    ...(args.folder === true ? { folder: true } : {}),
    ...(args.unlocked === true ? { unlocked: true } : {}),
  };
  return { prompt: projection.chatWorkspacePrompt(filesEnabled, scope) };
}

async function sessionChatOnlyPrompt(args) {
  // The chat-only pin's exact prompt: the session cwd's context files joined
  // in pi's discovery order (createAgentSessionServices' offline half — the
  // settings manager and resource loader the child itself would use, with
  // discovery off everywhere except context files).
  const sdk = await managed("@earendil-works/pi-coding-agent/dist/core/settings-manager.js");
  const loader = await managed("@earendil-works/pi-coding-agent/dist/core/resource-loader.js");
  const projection = await managedProjection();
  const cwd = requireString(args, "cwd");
  // PI_CODING_AGENT_DIR already IS the complete agent dir (the SDK's
  // convention — the Rust host sets it to the sandboxed/packaged dir);
  // appending /.pi/agent to it would read a nested dir that does not
  // exist. Only the home fallback needs the suffix.
  const defaultAgentDir = process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`;
  const agentDir = args.agentDir !== undefined ? requireString(args, "agentDir") : defaultAgentDir;
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new loader.DefaultResourceLoader({
    ...projection.CHAT_ONLY_RESOURCE_LOADER_OPTIONS,
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  return { prompt: projection.contextFilesSystemPrompt(resourceLoader.getAgentsFiles().agentsFiles) };
}

/** The vendored pi SDK (this tree's OWN copy — instance identity is the
 *  point: never import from the child host's internals). The session
 *  manager's own module graph is the narrow surface; the full SDK barrel
 *  (dist/index.js) drags in the CLI/provider tree this extension never
 *  touches. */
async function managedSdk() {
  const mod = await managed("@earendil-works/pi-coding-agent/dist/core/session-manager.js");
  return mod;
}

/** The repo's session-view projection, bundled into this managed tree by
 *  scripts/migration/build-management-modules.mjs. One implementation: the
 *  Next server runs the same functions from lib/session-projection.ts. */
async function managedProjection() {
  return managed("pi-web-session-projection.mjs");
}

// A small read-only SessionManager cache, the same discipline as the Next
// server's (lib/session-reader.ts): a detail read and each pagination page
// re-open the same file, and a big session's parse is not free. Entries are
// fingerprint-validated (size + mtimeMs) so an external append (the child
// writes the same file once it flushes) never serves a stale view, and a
// cached manager is READ-ONLY — every write path opens fresh.
const MANAGED_SM_CACHE_LIMIT = 8;
const managedSmCache = new Map();

async function openManagedSession(file) {
  const sdk = await managedSdk();
  const resolved = realpath(file);
  const { statSync } = await import("node:fs");
  let fingerprint = null;
  try {
    const stats = statSync(resolved);
    fingerprint = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    managedSmCache.delete(resolved);
    return sdk.SessionManager.open(resolved);
  }
  const cached = managedSmCache.get(resolved);
  if (cached && cached.fingerprint === fingerprint) {
    // LRU touch.
    managedSmCache.delete(resolved);
    managedSmCache.set(resolved, cached);
    return cached.manager;
  }
  managedSmCache.delete(resolved);
  const manager = sdk.SessionManager.open(resolved);
  managedSmCache.set(resolved, { manager, fingerprint });
  while (managedSmCache.size > MANAGED_SM_CACHE_LIMIT) {
    managedSmCache.delete(managedSmCache.keys().next().value);
  }
  return manager;
}

/** The shared view projection for readView / projectSnapshot. */
function projectView(projection, view) {
  const {
    entries,
    leafId,
    rawTree,
    summaryTree,
    deferThinking,
    deferMedia,
    tail,
    wholeTurns,
  } = view;
  const tree = summaryTree
    ? projection.toSummaryTree(projection.projectTreeForResponse(rawTree))
    : projection.projectTreeForResponse(rawTree);
  const context = projection.buildSessionContext(entries, leafId, {
    deferThinking,
    deferToolResultImages: deferMedia,
    tail,
    wholeTurns,
  });
  const toolNames = projection.readSessionToolSelection(entries);
  const latestEntry = entries[entries.length - 1];
  return {
    leafId,
    tree,
    ...(summaryTree ? { treeFormat: "summary" } : {}),
    context,
    stats: projection.computeSessionStats(entries),
    totalActiveMs: projection.computeSessionTotalActiveMs(entries),
    ...(toolNames !== undefined ? { toolNames } : {}),
    // The snapshot revision's inputs (the host owns the fingerprint half).
    entryCount: entries.length,
    latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
  };
}

function optionalString(args, key) {
  const value = args && args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw opError("invalid_args", `${key} must be a string`);
  return value;
}

async function readFileUtf8(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateCron(Cron, expr, timezone) {
  try {
    const probe = new Cron(expr, { timezone, paused: true });
    probe.stop();
  } catch (error) {
    throw opError("invalid_cron", error instanceof Error ? error.message : String(error));
  }
}

function requireString(args, key) {
  const value = args && args[key];
  if (typeof value !== "string" || !value) throw opError("invalid_args", `${key} must be a non-empty string`);
  return value;
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function realpath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
