/**
 * The pi-web bridge extension, loaded into every `pi --mode rpc` child the
 * CLI engine spawns (`--extension <this file>`).
 *
 * It carries what pi's RPC protocol (1.4.0) has no commands for, plus the
 * host policies pi-web used to inject as in-process extensions:
 *
 *   - `/pi-web:navigate` and `/pi-web:reload`: tree navigation and reload
 *     run through the ExtensionCommandContext only command handlers get.
 *     The factory verifies "pi-web:navigate" answered get_commands after
 *     spawn, so a bridge that failed to load fails the session loudly.
 *   - the read-only MCP policy (lib/mcp-read-only-policy.ts, ported): while
 *     a read-only tool pin is recorded in the session file, MCP tools whose
 *     server does not mark readOnlyHint are blocked. The pin entry is in the
 *     file before the child opens it, so ctx.sessionManager sees it.
 *
 * The artifacts prompt section lives in its own asset
 * (assets/pi-web-artifacts.mjs), which the factory loads the same way; this
 * file is protocol and security bridging only.
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child, which does not share pi-web's module graph.
 */

const READ_ONLY_MCP_POLICY_NAME = "pi-web-read-only-mcp";
const WRITE_CAPABLE_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const MCP_EXTENSION_PATH = "builtin:mcp";
const TOOL_SELECTION_TYPE = "pi-web:tool-selection";
// Mirrors lib/session-tool-selection.ts's BUILTIN_TOOL_NAMES (PRESET_FULL
// without powershell: a hand-crafted pin naming powershell must stay invalid
// so an older valid pin below it keeps deciding the read-only policy).
const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

/** The newest pinned tool selection in the session entries, pi-web's format. */
function readSessionToolSelection(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const data = entry.data;
    if (!data || data.version !== 1) continue;
    if (data.cleared === true) return undefined;
    if (Array.isArray(data.tools) && data.tools.every((tool) => typeof tool === "string" && BUILTIN_TOOL_NAMES.has(tool))) {
      return [...new Set(data.tools)];
    }
  }
  return undefined;
}

/** A pinned selection that cannot write or run commands. */
function isReadOnlySelection(tools) {
  return tools !== undefined && tools.length > 0 && !tools.some((name) => WRITE_CAPABLE_TOOLS.has(name));
}

function isMcpTool(tool) {
  return (tool.sourceInfo && tool.sourceInfo.path === MCP_EXTENSION_PATH)
    || tool.name.startsWith("mcp__");
}

import { randomUUID } from "node:crypto";

/** The result channel marker: a normal notify never starts with this. */
const BRIDGE_RESULT_PREFIX = "PI_WEB_BRIDGE_V1 ";
/** Session binding nonce the spawning host passes via PI_WEB_BRIDGE_NONCE
 * (read per request: the value is fixed in the child, and tests drive many
 * sessions through one module instance). */
const bridgeNonce = () => process.env.PI_WEB_BRIDGE_NONCE ?? "";
/** The envelope the child answers with, carried in one notify message. */
function bridgeResultMessage(sessionId, requestId, payload) {
  return BRIDGE_RESULT_PREFIX + JSON.stringify({
    sid: sessionId,
    rid: requestId,
    nonce: bridgeNonce(),
    ...(payload.ok
      ? { ok: true, result: payload.result }
      : { ok: false, error: payload.error, ...(payload.code !== undefined ? { code: payload.code } : {}) }),
  });
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
// The scheduled-run marker entry (lib/scheduled-run-marker.ts keeps the same
// rules; this copy is self-contained because the asset runs in the child).
const SCHEDULED_RUN_ENTRY_TYPE = "pi-web:scheduled-run";
const SCHEDULED_RUN_TRIGGERS = new Set(["schedule", "catch-up", "manual"]);
const MAX_TASK_NAME_LENGTH = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A validated pi-web:scheduled-run payload, or undefined. Only the fields
 * the entry needs; op/nonce travel in the same object and are ignored here. */
function parseScheduledRunData(payload) {
  if (payload.version !== 1) return undefined;
  if (typeof payload.taskId !== "string" || !UUID_PATTERN.test(payload.taskId)) return undefined;
  if (typeof payload.runId !== "string" || payload.runId.length === 0 || payload.runId.length > 128
    || /[\\/\s]/.test(payload.runId)) return undefined;
  if (typeof payload.taskName !== "string" || payload.taskName.length === 0
    || payload.taskName.length > MAX_TASK_NAME_LENGTH) return undefined;
  if (typeof payload.trigger !== "string" || !SCHEDULED_RUN_TRIGGERS.has(payload.trigger)) return undefined;
  const data = { version: 1, taskId: payload.taskId, runId: payload.runId, taskName: payload.taskName, trigger: payload.trigger };
  if (payload.scheduledFor !== undefined) {
    if (typeof payload.scheduledFor !== "string" || !ISO_TIMESTAMP_PATTERN.test(payload.scheduledFor)) return undefined;
    data.scheduledFor = payload.scheduledFor;
  }
  return data;
}
/** A protocol budget, not a product limit: a legitimate MCP-heavy session can
 * register far more than a few hundred tools, so the cap only exists to keep
 * a corrupted reply from exhausting the host; exceeding it is an error the
 * host reports, never a reason to silently drop the capability. */
const MAX_BRIDGE_TOOLS = 2048;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tool name the child would accept in setActiveTools. */
function isValidToolName(name) {
  return typeof name === "string" && TOOL_NAME_PATTERN.test(name);
}

/** The tool metadata the host's picker and definitions panel render. */
function serializeTool(tool) {
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    ...(Array.isArray(tool.promptGuidelines) ? { promptGuidelines: [...tool.promptGuidelines] } : {}),
    ...(tool.exposure !== undefined ? { exposure: tool.exposure } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool.sourceInfo !== undefined ? { sourceInfo: tool.sourceInfo } : {}),
  };
}

/** A validated pin for the pi-web:tool-selection entry (cleared: true retracts it). */
function parsePinData(payload) {
  if (payload.cleared === true) return { version: 1, cleared: true };
  if (payload.cleared !== undefined) return undefined;
  if (!Array.isArray(payload.tools)) return undefined;
  if (payload.tools.some((name) => !BUILTIN_TOOL_NAMES.has(name))) return undefined;
  return { version: 1, tools: [...new Set(payload.tools)] };
}

// --- pi-subagents' in-process RPC, forwarded from the host -----------------
//
// The package listens on `subagents:rpc:v1:request` inside THIS process; the
// server has no path to that bus. The bridge therefore proxies the five
// restricted methods (never spawn/resume/manage/cost) through one request per
// bridge call, correlating the package's reply by a child-generated id and
// answering the host with the reply's body only (the ids stay here).

const SUBAGENTS_OP_PREFIX = "subagents.";
const SUBAGENTS_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENTS_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENTS_PROTOCOL_VERSION = 1;
/** The only methods the restricted API may reach. */
const SUBAGENTS_METHODS = new Set(["ping", "status", "steer", "interrupt", "stop"]);
/** Per-method parameter allowlist: a host (or a compromised route) cannot
 * smuggle `dir`, `path`, a script, or any other package knob through here. */
const SUBAGENTS_PARAM_KEYS = {
  ping: new Set([]),
  status: new Set(["id", "runId", "view", "lines", "index"]),
  steer: new Set(["id", "message", "index", "mode"]),
  interrupt: new Set(["id"]),
  stop: new Set(["id", "childId"]),
};
const MAX_SUBAGENTS_ID = 256;
const MAX_SUBAGENTS_MESSAGE = 8_000;
const MAX_SUBAGENTS_LINES = 500;
const MAX_SUBAGENTS_INDEX = 1_000;
const DEFAULT_SUBAGENTS_WAIT_MS = 20_000;
const MAX_SUBAGENTS_WAIT_MS = 30_000;
/** A status transcript is bounded; anything bigger is a protocol fault, not a
 * payload the host should try to ship through a notify line. */
const MAX_SUBAGENTS_RESULT_BYTES = 2_000_000;

function subagentsId(value, what) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SUBAGENTS_ID
    || !/^[\x21-\x7e]+$/.test(value) || /[\\/]/.test(value)) {
    throw new Error(`${what} must be a printable identifier without path separators`);
  }
  return value;
}

/** The validated params for one method, or a thrown error naming the field. */
function subagentsParams(method, raw) {
  const source = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(source)) throw new Error("params must be a JSON object");
  const allowed = SUBAGENTS_PARAM_KEYS[method];
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`pi-subagents '${method}' does not accept ${JSON.stringify(key)}`);
  }
  if (method === "ping") return {};
  if (method === "status") {
    const params = {};
    if (source.id !== undefined) params.id = subagentsId(source.id, "id");
    if (source.runId !== undefined) params.runId = subagentsId(source.runId, "runId");
    if (source.view !== undefined) {
      if (source.view !== "transcript" && source.view !== "fleet") throw new Error("view must be transcript or fleet");
      params.view = source.view;
    }
    if (source.lines !== undefined) {
      if (!Number.isInteger(source.lines) || source.lines < 1 || source.lines > MAX_SUBAGENTS_LINES) {
        throw new Error(`lines must be an integer between 1 and ${MAX_SUBAGENTS_LINES}`);
      }
      params.lines = source.lines;
    }
    if (source.index !== undefined) {
      if (!Number.isInteger(source.index) || source.index < 0 || source.index > MAX_SUBAGENTS_INDEX) {
        throw new Error(`index must be an integer between 0 and ${MAX_SUBAGENTS_INDEX}`);
      }
      params.index = source.index;
    }
    return params;
  }
  if (method === "steer") {
    if (typeof source.message !== "string" || source.message.trim().length === 0) {
      throw new Error("steer needs a non-empty message");
    }
    if (source.message.length > MAX_SUBAGENTS_MESSAGE) throw new Error(`steer message is longer than ${MAX_SUBAGENTS_MESSAGE} characters`);
    const params = { message: source.message };
    if (source.id !== undefined) params.id = subagentsId(source.id, "id");
    if (source.index !== undefined) {
      if (!Number.isInteger(source.index) || source.index < 0 || source.index > MAX_SUBAGENTS_INDEX) {
        throw new Error(`index must be an integer between 0 and ${MAX_SUBAGENTS_INDEX}`);
      }
      params.index = source.index;
    }
    if (source.mode !== undefined) {
      if (source.mode !== "steer" && source.mode !== "follow_up" && source.mode !== "auto") {
        throw new Error("mode must be steer, follow_up, or auto");
      }
      params.mode = source.mode;
    }
    return params;
  }
  // interrupt / stop
  const params = { id: subagentsId(source.id, "id") };
  if (method === "stop" && source.childId !== undefined) params.childId = subagentsId(source.childId, "childId");
  return params;
}

/** The package's documented reply shape, reduced to what the host forwards. */
function subagentsReply(raw, requestId) {
  if (!isPlainObject(raw)) return undefined;
  if (raw.version !== SUBAGENTS_PROTOCOL_VERSION || raw.requestId !== requestId) return undefined;
  if (raw.success === true) return { success: true, ...(raw.data !== undefined ? { data: raw.data } : {}) };
  if (raw.success !== false) return undefined;
  if (!isPlainObject(raw.error)) return undefined;
  if (typeof raw.error.code !== "string" || typeof raw.error.message !== "string") return undefined;
  return { success: false, error: { code: raw.error.code, message: raw.error.message.slice(0, 2_000) } };
}

/** One proxy request: event bus in, bridge answer out. Never throws. */
async function runSubagentsRpc(pi, method, rawParams, rawTimeoutMs) {
  let params;
  try {
    params = subagentsParams(method, rawParams);
  } catch (error) {
    return { ok: false, code: "subagents.invalid-params", error: error instanceof Error ? error.message : String(error) };
  }
  const events = pi.events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") {
    // No event bus in this child (an older SDK): the package cannot be reached
    // from here, and that says nothing about whether it is installed.
    return { ok: false, code: "subagents.no-events", error: "this pi child exposes no extension event bus" };
  }
  const timeoutMs = Number.isInteger(rawTimeoutMs)
    ? Math.min(Math.max(rawTimeoutMs, 250), MAX_SUBAGENTS_WAIT_MS)
    : DEFAULT_SUBAGENTS_WAIT_MS;
  const requestId = randomUUID();
  const reply = await new Promise((resolve) => {
    let settled = false;
    let off;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        off?.();
      } catch {
        // A bus that throws on unsubscribe must not mask the reply.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      code: "subagents.unresponsive",
      error: `pi-subagents did not answer '${method}' within ${timeoutMs} ms`,
    }), timeoutMs);
    try {
      off = events.on(`${SUBAGENTS_REPLY_PREFIX}${requestId}`, (incoming) => {
        const parsed = subagentsReply(incoming, requestId);
        if (parsed === undefined) return;
        finish({ ok: true, result: parsed });
      });
      events.emit(SUBAGENTS_REQUEST_EVENT, {
        version: SUBAGENTS_PROTOCOL_VERSION,
        requestId,
        method,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      });
    } catch (error) {
      finish({ ok: false, code: "subagents.emit-failed", error: error instanceof Error ? error.message : String(error) });
    }
  });
  if (reply.ok && JSON.stringify(reply.result).length > MAX_SUBAGENTS_RESULT_BYTES) {
    return { ok: false, code: "subagents.result-too-large", error: "the pi-subagents reply exceeded the bridge's size budget" };
  }
  return reply;
}

/** Mutating tool operations wait for an idle session: the host's running check * races a run that started after it (TOCTOU), and the child's own state is the
 * authority. The error says the session is busy, not that the request failed. */
function assertIdle(ctx) {
  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
    throw new Error("the session is running; wait for it to finish before changing tools");
  }
}

function validateNames(names) {
  if (!Array.isArray(names) || names.some((name) => !isValidToolName(name)) || names.length > MAX_BRIDGE_TOOLS) {
    throw new Error("the op needs names: string[] of registered tool names");
  }
}

/** The whitelisted bridge operations. Each returns JSON the host needs. */
async function runBridgeOperation(pi, ctx, rawArgs) {
  const parts = String(rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
  let sessionId = "";
  let requestId = "";
  try {
    if (parts.length !== 2 || !REQUEST_ID_PATTERN.test(parts[0])) {
      throw new Error("usage: pi-web:bridge <requestId> <base64url-json>");
    }
    requestId = parts[0];
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      sessionId = "";
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    } catch {
      throw new Error("the bridge payload is not valid base64url JSON");
    }
    if (!isPlainObject(payload)) throw new Error("the bridge payload must be a JSON object");
    if (typeof payload.nonce !== "string" || payload.nonce !== bridgeNonce()) {
      throw new Error("the bridge nonce does not match this session");
    }

    if (payload.op === "tools.list") {
      const tools = pi.getAllTools().map(serializeTool);
      const active = pi.getActiveTools();
      if (tools.length > MAX_BRIDGE_TOOLS) throw new Error(`too many tools (${tools.length})`);
      answer(ctx, sessionId, requestId, { ok: true, result: { tools, active } });
      return requestId;
    }

    if (payload.op === "tools.set") {
      assertIdle(ctx);
      validateNames(payload.names);
      pi.setActiveTools(payload.names);
      answer(ctx, sessionId, requestId, { ok: true, result: { active: pi.getActiveTools() } });
      return requestId;
    }

    if (payload.op === "tools.pin") {
      assertIdle(ctx);
      const data = parsePinData(payload);
      if (data === undefined) {
        throw new Error("tools.pin needs built-in tool names or cleared: true");
      }
      pi.appendEntry(TOOL_SELECTION_TYPE, data);
      answer(ctx, sessionId, requestId, { ok: true, result: { pinned: data.cleared === true ? "cleared" : "pinned" } });
      return requestId;
    }

    if (payload.op === "tools.apply") {      // One transaction: apply and confirm the loadout, then persist the pin;
      // a pin write that fails restores the previous loadout so the session
      // and its file never disagree.
      assertIdle(ctx);
      validateNames(payload.names);
      const pin = isPlainObject(payload.pin) ? parsePinData({ tools: payload.pin.tools }) : undefined;
      if (pin === undefined || pin.cleared === true) {
        throw new Error("tools.apply needs pin: {tools: [built-in names]}");
      }
      const originalActive = pi.getActiveTools();
      pi.setActiveTools(payload.names);
      const confirmed = pi.getActiveTools();
      try {
        pi.appendEntry(TOOL_SELECTION_TYPE, pin);
      } catch (error) {
        pi.setActiveTools(originalActive);
        throw new Error(
          "persisting the tool pin failed; the previous tool set was restored: "
            + (error instanceof Error ? error.message : String(error)),
        );
      }
      answer(ctx, sessionId, requestId, { ok: true, result: { active: confirmed, pinned: "pinned" } });
      return requestId;
    }

    if (payload.op === "meta.scheduled-run") {
      // The only live metadata append the bridge offers: one fixed entry type,
      // one strictly validated payload. The runner tags a brand-new session
      // before its first prompt, so the marker lands on the run's real active
      // branch and precedes the conversation. There is deliberately no op that
      // appends an arbitrary type or payload (the tool pin above is the other
      // fixed-shape entry, and chat unlock is NOT bridge-reachable: the host
      // appends it only after this child exited).
      assertIdle(ctx);
      const data = parseScheduledRunData(payload);
      if (data === undefined) {
        throw new Error("meta.scheduled-run needs { version: 1, taskId: uuid, runId, taskName, trigger, scheduledFor? }");
      }
      pi.appendEntry(SCHEDULED_RUN_ENTRY_TYPE, data);
      answer(ctx, sessionId, requestId, { ok: true, result: { entry: "scheduled-run" } });
      return requestId;
    }

    if (typeof payload.op === "string" && payload.op.startsWith(SUBAGENTS_OP_PREFIX)) {
      // pi-subagents' in-process RPC, forwarded through THIS process's event
      // bus: the package's listener lives in this child, so the host cannot
      // reach it from the server. No idle guard — the package answers status
      // and control requests while a run is in progress, and the host polls
      // the fleet exactly then. Extension commands are dispatched immediately
      // even during streaming (docs/rpc-commands.md), so the prompt channel is
      // safe to use mid-run.
      const method = payload.op.slice(SUBAGENTS_OP_PREFIX.length);
      if (!SUBAGENTS_METHODS.has(method)) {
        // A method the restricted API does not model: answer with its own code
        // instead of the generic "unknown bridge op" (the host distinguishes
        // an older bridge from a refused package method).
        answer(ctx, sessionId, requestId, {
          ok: false,
          code: "subagents.unknown-method",
          error: `unknown pi-subagents RPC method: ${JSON.stringify(method)}`,
        });
        return requestId;
      }
      const outcome = await runSubagentsRpc(pi, method, payload.params, payload.timeoutMs);
      answer(ctx, sessionId, requestId, outcome);
      return requestId;
    }

    throw new Error(`unknown bridge op: ${JSON.stringify(payload.op)}`);
  } catch (error) {
    // The operation failed: answer ok:false so the host rejects its request
    // instead of timing out. The requestId is echoed sanitized — a malformed
    // one cannot match a pending host request and is dropped there.
    answer(ctx, sessionId, requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64), {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return requestId;
  }
}

/** One fire-and-forget result record; the host correlates it by requestId. */
function answer(ctx, sessionId, requestId, payload) {
  ctx.ui.notify(bridgeResultMessage(sessionId, requestId, payload), "info");
}

export default function piWebBridge(pi) {
  // --- session-tree operations (the RPC protocol gap) ----------------------
  pi.registerCommand("pi-web:navigate", {
    description: "pi-web internal: move the session's active leaf",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) throw new Error("pi-web:navigate requires an entry id");
      const entryId = parts[0];
      const summarize = parts.includes("--summarize");
      // Instructions travel base64-encoded: they are free text and the command
      // line is whitespace-split (a literal "--summarize" or double spaces in
      // the text would corrupt a plain token join).
      const b64Index = parts.indexOf("--instructions-b64");
      const customInstructions = b64Index >= 0 && parts[b64Index + 1]
        ? Buffer.from(parts[b64Index + 1], "base64").toString("utf8")
        : undefined;
      const result = await ctx.navigateTree(entryId, {
        ...(summarize ? { summarize: true } : {}),
        ...(customInstructions !== undefined ? { customInstructions } : {}),
      });
      if (result.cancelled) throw new Error("pi-web:navigate was cancelled");
      return "navigated";
    },
  });

  pi.registerCommand("pi-web:reload", {
    description: "pi-web internal: reload extensions, skills and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return "reloaded";
    },
  });

  // --- host bridge request/reply (the RPC protocol gap for state) ---------
  //
  // `/pi-web:bridge <requestId> <base64url-json>` runs one whitelisted state
  // operation (pi.getAllTools/getActiveTools/setActiveTools/appendEntry) and
  // answers through ctx.ui.notify — the only child→host channel the RPC
  // protocol has for extension-produced data. The RPC `prompt` response for
  // an extension command carries only disposition:"handled" (a throwing
  // handler still answers "handled" and reports through extension_error), so
  // the notify IS the operation's result, correlated by requestId.
  //
  // Why the command line cannot reach the model: the factory refuses to start
  // a session whose bridge did not register this command, and every argument
  // is a machine token (a charset-checked requestId, one base64url blob) — a
  // prompt that starts with a registered extension command name is consumed
  // by the extension runtime and never starts a run, and even a malformed
  // variant carries no instructions to follow.
  pi.registerCommand("pi-web:bridge", {
    description: "pi-web internal: run a host bridge request",
    handler: async (args, ctx) => {
      const requestId = await runBridgeOperation(pi, ctx, args);
      return "bridged:" + requestId;
    },
  });

  // --- read-only MCP policy (ported from lib/mcp-read-only-policy.ts) ------
  pi.on("tool_call", (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (!tool || !isMcpTool(tool) || (tool.annotations && tool.annotations.readOnlyHint === true)) return undefined;
    // Nested calls (a codemode script's) pass through tool_call as well.
    const selection = readSessionToolSelection(ctx.sessionManager.getEntries());
    if (!isReadOnlySelection(selection)) return undefined;
    return {
      block: true,
      reason: 'This session uses a read-only tool selection, and the MCP server does not mark "'
        + event.toolName + '" as read-only (readOnlyHint), so the call was blocked. '
        + "Switch the session to a preset that allows changes to use it.",
    };
  });
}
