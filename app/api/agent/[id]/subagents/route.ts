import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { loadResultHasPiSubagentsExtension } from "@/lib/subagent-extension";
import {
  SUBAGENT_RPC_PING_TIMEOUT_MS,
  callSubagentRpc,
  subagentRpcErrorStatus,
  type SubagentEventBus,
  type SubagentRpcReply,
} from "@/lib/pi-subagents-rpc";
import {
  boundActionResult,
  normalizePiSubagentsCapabilities,
  normalizePiSubagentsSnapshot,
  normalizePiSubagentsTranscript,
  type PiSubagentsCapabilities,
  type PiSubagentsStatusView,
  type PiSubagentsUnavailable,
} from "@/lib/pi-subagents-view";

/**
 * The restricted pi-subagents API. The frontend may observe this session's
 * runs and ask for four control actions; it may not launch, resume, manage
 * schedules, name directories, or pass arbitrary RPC methods or parameters
 * through. Every target is addressed through this parent session's own
 * extension event bus, where the package enforces current-session run
 * ownership (`ownsRun`), and the identifiers sent are exactly the ones the
 * package's own payloads returned (`runId`, `childId`) — never a
 * client-invented session id, file path, or display offset (the async
 * snapshot carries no authoritative child indexes, so steer targets run ids
 * only and the package applies a child-scoped stop through its own child
 * identity resolution).
 *
 * GET degrades to `{ available: false, reason }` (200) so polling stays cheap;
 * POST reports the same conditions as transport failures (4xx/5xx).
 */

export const dynamic = "force-dynamic";

const MAX_RUN_ID_LENGTH = 256;
const MAX_STEER_MESSAGE_LENGTH = 8_000;
const MAX_LINES = 500;
const MAX_INDEX = 1_000;

/** Printable, non-whitespace ASCII: the package applies the same rule to RPC ids. */
const RPC_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

interface SessionGate {
  kind: "ok";
  bus: SubagentEventBus;
  /** Aborts when the wrapper starts closing — in-flight RPC must not outlive the session. */
  closeSignal: AbortSignal;
}

type GateFailure =
  | { kind: "not-found" }
  | { kind: "chat-workspace" }
  | { kind: "unavailable"; view: PiSubagentsUnavailable };

function unavailable(reason: PiSubagentsUnavailable["reason"], error?: string): PiSubagentsUnavailable {
  return { available: false, reason, ...(error !== undefined ? { error } : {}) };
}

/**
 * The shared gate for GET and POST: the session must exist and be alive, it
 * must not be a non-project chat, the pi-subagents package must be loaded in
 * it (detected by extension source or path, never by tool names), and the
 * wrapper must hold the session's extension event bus.
 */
function gateSession(id: string): SessionGate | GateFailure {
  const wrapper = getRpcSession(id);
  if (!wrapper) return { kind: "not-found" };
  if (wrapper.isChatWorkspace()) {
    // Server-enforced policy (docs/agents/fork-chat-workspace.md): chats never
    // initialize or query subagent extensions.
    return { kind: "chat-workspace" };
  }
  if (!wrapper.isAlive()) return { kind: "unavailable", view: unavailable("session-closed") };
  const extensions = wrapper.inner.resourceLoader.getExtensions?.().extensions;
  if (!extensions || !loadResultHasPiSubagentsExtension(extensions)) {
    return { kind: "unavailable", view: unavailable("not-loaded") };
  }
  const bus = wrapper.getSubagentsEventBus?.();
  if (!bus) return { kind: "unavailable", view: unavailable("no-bus") };
  return { kind: "ok", bus, closeSignal: wrapper.getLifecycleAbortSignal() };
}

/** A bridge failure GET answers with 200 (the polling view) and POST with a transport error. */
type ProbeFailure =
  | { kind: "unresponsive"; error: string }
  | { kind: "incompatible"; error: string }
  | { kind: "closed"; error: string };

async function probeBridge(bus: SubagentEventBus, closeSignal: AbortSignal): Promise<SubagentRpcReply | ProbeFailure> {
  let reply: SubagentRpcReply;
  try {
    reply = await callSubagentRpc(bus, "ping", undefined, {
      timeoutMs: SUBAGENT_RPC_PING_TIMEOUT_MS,
      signal: closeSignal,
    });
  } catch (error) {
    // The signal's own state is the truth: an abort reason need not be an AbortError.
    if (closeSignal.aborted) return { kind: "closed", error: "session closed while probing the pi-subagents bridge" };
    return { kind: "unresponsive", error: error instanceof Error ? error.message : String(error) };
  }
  if (reply.error) {
    return { kind: "incompatible", error: `${reply.error.code}: ${reply.error.message}` };
  }
  const data = reply.data as Record<string, unknown> | undefined;
  const methods = Array.isArray(data?.methods) ? data.methods : [];
  if (data?.version !== 1 || !methods.includes("status")) {
    return { kind: "incompatible", error: "pi-subagents RPC protocol does not advertise version 1 status support" };
  }
  return reply;
}

function gateFailureResponse(failure: GateFailure, method: "GET" | "POST"): NextResponse {
  if (failure.kind === "not-found") {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (failure.kind === "chat-workspace") {
    return NextResponse.json(
      { error: "Subagents are not available in chats", reason: "chat-workspace" },
      { status: 403 },
    );
  }
  if (method === "GET") {
    return NextResponse.json(failure.view, { headers: { "Cache-Control": "no-store" } });
  }
  const status = failure.view.reason === "session-closed" ? 409 : 503;
  return NextResponse.json(
    { error: `pi-subagents is unavailable (${failure.view.reason})`, reason: failure.view.reason },
    { status },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const gate = gateSession(id);
  if (gate.kind !== "ok") return gateFailureResponse(gate, "GET");

  const ping = await probeBridge(gate.bus, gate.closeSignal);
  if ("kind" in ping) {
    return NextResponse.json(
      unavailable(ping.kind === "closed" ? "session-closed" : ping.kind, ping.error),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let status: SubagentRpcReply;
  try {
    status = await callSubagentRpc(gate.bus, "status", undefined, { signal: gate.closeSignal });
  } catch (error) {
    if (gate.closeSignal.aborted) {
      return NextResponse.json(unavailable("session-closed"), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      unavailable("unresponsive", error instanceof Error ? error.message : String(error)),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (status.error) {
    return NextResponse.json(
      unavailable("status-failed", `${status.error.code}: ${status.error.message}`),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const view: PiSubagentsStatusView = normalizePiSubagentsSnapshot(
    status.data as Record<string, unknown> | undefined,
    ping.data as Record<string, unknown> | undefined,
    { fallbackGeneratedAt: Date.now() },
  );
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------------------
// POST actions
// ---------------------------------------------------------------------------

interface InspectRequest { action: "inspect"; runId: string; index?: number; lines?: number }
interface StopRequest { action: "stop"; runId: string; childId?: string }
interface SteerRequest { action: "steer"; runId: string; message: string; mode?: "steer" | "follow_up" | "auto" }
interface InterruptRequest { action: "interrupt"; runId: string }
type SubagentsActionRequest = InspectRequest | StopRequest | SteerRequest | InterruptRequest;

const ACTION_FIELDS: Record<SubagentsActionRequest["action"], ReadonlySet<string>> = {
  inspect: new Set(["action", "runId", "index", "lines"]),
  stop: new Set(["action", "runId", "childId"]),
  steer: new Set(["action", "runId", "message", "mode"]),
  interrupt: new Set(["action", "runId"]),
};

function invalid(message: string): NextResponse {
  return NextResponse.json({ error: message, reason: "invalid-request" }, { status: 400 });
}

/**
 * Parse the body into exactly one of the four actions. Unknown fields are
 * rejected — `dir`, `path` and `index` never reach the RPC — and every value
 * is checked against the bounds the package itself applies
 * (`SubagentFlatParams`).
 */
function parseActionRequest(body: unknown): { request?: SubagentsActionRequest; error?: NextResponse } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: invalid("Request body must be a JSON object") };
  }
  const record = body as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTION_FIELDS, action)) {
    return { error: invalid("action must be inspect, stop, steer, or interrupt") };
  }
  const allowed = ACTION_FIELDS[action as SubagentsActionRequest["action"]];
  const unknownFields = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownFields.length > 0) {
    return { error: invalid(`Unknown fields for ${action}: ${unknownFields.join(", ")}`) };
  }
  const runId = record.runId;
  if (typeof runId !== "string" || !RPC_ID_PATTERN.test(runId) || runId.length > MAX_RUN_ID_LENGTH || /[\\/]/.test(runId)) {
    return { error: invalid("runId must be a non-empty identifier without path separators, at most 256 characters") };
  }
  const readIndex = (target: Record<string, unknown>): number | undefined | null => {
    if (target.index === undefined) return undefined;
    if (typeof target.index !== "number" || !Number.isInteger(target.index) || target.index < 0 || target.index > MAX_INDEX) {
      return null;
    }
    return target.index;
  };
  switch (action) {
    case "inspect": {
      const index = readIndex(record);
      if (index === null) return { error: invalid(`index must be an integer between 0 and ${MAX_INDEX}`) };
      let lines: number | undefined;
      if (record.lines !== undefined) {
        if (typeof record.lines !== "number" || !Number.isInteger(record.lines) || record.lines < 1 || record.lines > MAX_LINES) {
          return { error: invalid(`lines must be an integer between 1 and ${MAX_LINES}`) };
        }
        lines = record.lines;
      }
      return { request: { action, runId, ...(index !== undefined ? { index } : {}), ...(lines !== undefined ? { lines } : {}) } };
    }
    case "stop": {
      let childId: string | undefined;
      if (record.childId !== undefined) {
        if (typeof record.childId !== "string" || !RPC_ID_PATTERN.test(record.childId) || record.childId.length > MAX_RUN_ID_LENGTH || /[\\/]/.test(record.childId)) {
          return { error: invalid("childId must be a non-empty identifier without path separators, at most 256 characters") };
        }
        childId = record.childId;
      }
      return { request: { action, runId, ...(childId !== undefined ? { childId } : {}) } };
    }
    case "steer": {
      const message = record.message;
      if (typeof message !== "string" || message.trim().length === 0 || message.length > MAX_STEER_MESSAGE_LENGTH) {
        return { error: invalid(`message must be a non-empty string of at most ${MAX_STEER_MESSAGE_LENGTH} characters`) };
      }
      let mode: SteerRequest["mode"] | undefined;
      if (record.mode !== undefined) {
        if (record.mode !== "steer" && record.mode !== "follow_up" && record.mode !== "auto") {
          return { error: invalid("mode must be steer, follow_up, or auto") };
        }
        mode = record.mode;
      }
      return {
        request: {
          action,
          runId,
          message: message.trim(),
          ...(mode !== undefined ? { mode } : {}),
        },
      };
    }
    default:
      return { request: { action: "interrupt", runId } };
  }
}

/** The RPC method and params for one action: only known fields, only the package's documented shapes. */
function actionRpcParams(request: SubagentsActionRequest): { method: "status" | "stop" | "steer" | "interrupt"; params: Record<string, unknown> } {
  switch (request.action) {
    case "inspect":
      return {
        method: "status",
        params: {
          id: request.runId,
          view: "transcript",
          lines: request.lines ?? 80,
          ...(request.index !== undefined ? { index: request.index } : {}),
        },
      };
    case "stop":
      return {
        method: "stop",
        params: { id: request.runId, ...(request.childId !== undefined ? { childId: request.childId } : {}) },
      };
    case "steer":
      return {
        method: "steer",
        params: {
          id: request.runId,
          message: request.message,
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
        },
      };
    default:
      return { method: "interrupt", params: { id: request.runId } };
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalid("Request body must be JSON");
  }
  const parsed = parseActionRequest(body);
  if (parsed.error || !parsed.request) return parsed.error ?? invalid("Invalid request");

  const gate = gateSession(id);
  if (gate.kind !== "ok") return gateFailureResponse(gate, "POST");

  const ping = await probeBridge(gate.bus, gate.closeSignal);
  if ("kind" in ping) {
    if (ping.kind === "closed") {
      return NextResponse.json({ error: ping.error, reason: "session-closed" }, { status: 409 });
    }
    const status = ping.kind === "unresponsive" ? 504 : 502;
    return NextResponse.json({ error: ping.error, reason: ping.kind }, { status });
  }

  // Server-side capability enforcement: never forward an action the bridge did
  // not advertise. The view computes the same flags for the UI from the same
  // ping; this gate keeps a hand-written request from reaching the package.
  const capabilities: PiSubagentsCapabilities = normalizePiSubagentsCapabilities(
    ping.data as Record<string, unknown> | undefined,
  );
  const requiredCapability: Record<SubagentsActionRequest["action"], keyof PiSubagentsCapabilities> = {
    inspect: "status",
    stop: "stop",
    steer: "steer",
    interrupt: "interrupt",
  };
  if (capabilities[requiredCapability[parsed.request.action]] !== true) {
    return NextResponse.json(
      {
        error: `pi-subagents does not advertise the '${parsed.request.action}' capability`,
        reason: "capability-unavailable",
      },
      { status: 400 },
    );
  }

  const { method, params: rpcParams } = actionRpcParams(parsed.request);
  let reply: SubagentRpcReply;
  try {
    reply = await callSubagentRpc(gate.bus, method, rpcParams, { signal: gate.closeSignal });
  } catch (error) {
    if (gate.closeSignal.aborted) {
      return NextResponse.json(
        { error: "session closed before the pi-subagents action completed", reason: "session-closed" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), reason: "unresponsive" },
      { status: 504 },
    );
  }
  if (reply.error) {
    return NextResponse.json(
      { error: reply.error.message, reason: reply.error.code },
      { status: subagentRpcErrorStatus(reply.error.code) },
    );
  }

  if (parsed.request.action === "inspect") {
    return NextResponse.json(
      {
        ok: true,
        action: "inspect",
        view: normalizePiSubagentsTranscript(
          parsed.request.runId,
          reply.data as Record<string, unknown> | undefined,
          { lines: parsed.request.lines ?? 80, ...(parsed.request.index !== undefined ? { index: parsed.request.index } : {}) },
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      action: parsed.request.action,
      // Bounded pass-through: the package's control receipts (runId, state,
      // message, deliveryStatus) are small, and the bound keeps them that way.
      result: boundActionResult(reply.data),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
