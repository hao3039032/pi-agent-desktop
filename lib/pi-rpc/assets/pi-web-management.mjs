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
 * - progress messages ("PI_WEB_MGMT_PROGRESS_V1 " + {rid, at, total?})
 *   cover long installs later.
 *
 * Dependencies load from the VENDORED management tree by absolute path
 * (the host injects PI_WEB_MANAGED_MODULES): croner for cron math, the
 * pi SDK for file-based session access. The module graph is this tree's
 * own — never the child pi host's internal instances (plan §五).
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child's runtime before any bundler exists.
 */

import { realpathSync } from "node:fs";

const RESULT_PREFIX = "PI_WEB_MGMT_V1 ";
const PROGRESS_PREFIX = "PI_WEB_MGMT_PROGRESS_V1 ";
const MGMT_PROTOCOL_VERSION = 1;

/** The ops this build supports (the capability table). */
const CAPABILITIES = ["sys.capabilities", "cron.preview", "cron.previousRuns", "session.readHeader", "session.readEntries"];

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
      try {
        const result = await runOp(payload.op ?? "", payload.args ?? {}, requestId, ctx);
        answer(ctx, requestId, nonce, { ok: true, result });
      } catch (error) {
        answer(ctx, requestId, nonce, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: error && typeof error.code === "string" ? error.code : "op_failed",
        });
      }
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

async function runOp(op, args, rid, ctx) {
  switch (op) {
    case "sys.capabilities":
      return { version: MGMT_PROTOCOL_VERSION, ops: CAPABILITIES };

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

    default:
      throw opError("unknown_op", `unknown management op: ${JSON.stringify(op).slice(0, 60)}`);
  }
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
