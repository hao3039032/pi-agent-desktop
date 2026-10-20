/**
 * Pure view types and normalizers for the restricted pi-subagents API
 * (`app/api/agent/[id]/subagents`). Everything here is a bounded projection of
 * the package's documented RPC payloads — `ping` data, the `fleet` DTO and the
 * `asyncSnapshot` of a successful `status` reply (src/extension/rpc.js,
 * src/runs/shared/async-status-projection.js of pi-subagents) — never a guess:
 * a field the source does not carry stays absent, and an unknown run state
 * stays `unknown` (a disconnected or unreadable run is never reported as
 * finished).
 *
 * All bounds are defense in depth: the package already bounds what it emits,
 * but the API must also survive a hostile or broken payload.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Total rows kept across the run tree, active rows first. */
export const MAX_RUN_ROWS = 64;
/** How deep the run → child → child tree is walked. */
export const MAX_RUN_TREE_DEPTH = 4;
/** Children kept per node. */
export const MAX_CHILDREN_PER_NODE = 8;
/** Any single string field (the package already truncates to ~160). */
export const MAX_FIELD_STRING = 240;
/** The status summary text kept for the UI. */
export const MAX_SUMMARY_TEXT = 8_000;
/** The transcript text an `inspect` may return. */
export const MAX_TRANSCRIPT_TEXT = 100_000;
/** Generic bound for action replies passed through to the UI. */
export const MAX_RESULT_DEPTH = 6;
export const MAX_RESULT_ARRAY = 32;
export const MAX_RESULT_KEYS = 32;
/** Fleet summary entries kept (the package's own DTO caps at 16). */
export const MAX_FLEET_SUMMARY_ENTRIES = 16;

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type PiSubagentsUnavailableReason =
  /** A non-project chat: the server never wires the extension there. */
  | "chat-workspace"
  /** No pi-subagents extension file in this session's load result. */
  | "not-loaded"
  /** The wrapper has no bridge bus (a built-in subagent child, or a pre-bridge wrapper). */
  | "no-bus"
  /** The extension is loaded but the RPC bridge did not answer. */
  | "unresponsive"
  /** The bridge answered but refuses this protocol version or request. */
  | "incompatible"
  /** The session is shutting down or already gone. */
  | "session-closed"
  /** A `status` call failed (for example `no_active_session` before the session started). */
  | "status-failed";

export interface PiSubagentsUnavailable {
  available: false;
  reason: PiSubagentsUnavailableReason;
  /** English diagnostic, safe to show; never a path or secret. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Capabilities (a normalized subset of the package's ping capabilities)
// ---------------------------------------------------------------------------

export interface PiSubagentsCapabilities {
  /** The protocol version the bridge reported, null when it did not say. */
  protocolVersion: number | null;
  /** The `status` method is advertised. */
  status: boolean;
  /** `fleet` on status replies, when the package advertises it. */
  fleetStatus?: { version: number };
  /** `asyncSnapshot` on status replies, when the package advertises it. */
  asyncStatusSnapshot?: { kind: string; version: number };
  steer: boolean;
  /** The package guarantees RPC steering never pauses-and-revives. */
  nonRecoveringSteer: boolean;
  interrupt: boolean;
  stop: boolean;
  resume: boolean;
}

/** The `data` of a successful `ping` reply, as far as the view reads it. */
export interface SubagentPingData {
  version?: unknown;
  methods?: unknown;
  capabilities?: unknown;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function boundedString(value: unknown, max = MAX_FIELD_STRING): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return text.length > 0 ? text : undefined;
}

/**
 * Normalize the capabilities the restricted API acts on. Absent fields read
 * false: an older package that does not advertise an operation must not have
 * it reported as available.
 */
export function normalizePiSubagentsCapabilities(ping: SubagentPingData | undefined): PiSubagentsCapabilities {
  const caps = typeof ping?.capabilities === "object" && ping.capabilities !== null && !Array.isArray(ping.capabilities)
    ? ping.capabilities as Record<string, unknown>
    : {};
  const fleetStatus = typeof caps.fleetStatus === "object" && caps.fleetStatus !== null && !Array.isArray(caps.fleetStatus)
    ? (caps.fleetStatus as Record<string, unknown>)
    : undefined;
  const snapshot = typeof caps.asyncStatusSnapshot === "object" && caps.asyncStatusSnapshot !== null && !Array.isArray(caps.asyncStatusSnapshot)
    ? (caps.asyncStatusSnapshot as Record<string, unknown>)
    : undefined;
  return {
    protocolVersion: boundedNumber(ping?.version) ?? null,
    status: caps.status === true,
    ...(fleetStatus && boundedNumber(fleetStatus.version) !== undefined
      ? { fleetStatus: { version: boundedNumber(fleetStatus.version)! } }
      : {}),
    ...(snapshot && typeof snapshot.kind === "string" && boundedNumber(snapshot.version) !== undefined
      ? { asyncStatusSnapshot: { kind: boundedString(snapshot.kind, 64) ?? "unknown", version: boundedNumber(snapshot.version)! } }
      : {}),
    steer: caps.steer === true,
    nonRecoveringSteer: caps.nonRecoveringSteer === true,
    interrupt: caps.interrupt === true,
    stop: caps.stop === true,
    resume: caps.resume === true,
  };
}

// ---------------------------------------------------------------------------
// Run rows
// ---------------------------------------------------------------------------

/**
 * A run state exactly as the package's async status projection defines it
 * (`normalizeState`/`ASYNC_STATUS_SNAPSHOT_STATES`); `unknown` covers anything
 * else, which the source maps to `partial` only for its own rows — this view
 * keeps it honestly unknown instead.
 */
export type PiSubagentRunState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "partial"
  | "paused"
  | "stopped"
  | "rejected"
  | "unknown";

const ACTIVE_STATES = new Set<string>(["queued", "running"]);
const TERMINAL_STATES = new Set<string>(["complete", "failed", "partial", "paused", "stopped", "rejected"]);

const RUN_NODE_KINDS = new Set(["subagent", "workflow", "step", "host-step"]);

export interface PiSubagentTokens {
  input: number;
  output: number;
  total: number;
}

export interface PiSubagentRunRow {
  /** Stable row key for React lists (unique within one snapshot). */
  key: string;
  /** The async run id, when the node is one: the control target for stop/steer/interrupt. */
  runId?: string;
  /**
   * The identity the package reports for a child node (`workflowKey` or the
   * child run id). Only ever used as the `childId` of a child-scoped stop —
   * never as a session id, which the payload does not carry.
   */
  childId?: string;
  /** Zero-based position among the siblings the snapshot kept (display only). */
  index?: number;
  /** The parent run's id for a child row. */
  parentRunId?: string;
  /**
   * Tree distance from a root run: 0 for a root row, +1 per edge. Both display
   * and targeting metadata — the package resolves a child-scoped stop against
   * the run's top-level children only (`resolveAsyncStatusChild(initialStatus,
   * childId)` walks `status.steps`, never nested children), so only a depth-1
   * row can be addressed that way.
   */
  depth: number;
  kind: "subagent" | "workflow" | "step" | "host-step" | "unknown";
  name: string;
  /** The caller-facing goal, when the source reports one. */
  task?: string;
  status: PiSubagentRunState;
  active: boolean;
  terminal: boolean;
  currentTool?: string;
  /** Only set by an `inspect` response; the list snapshot carries none. */
  recentOutput?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  model?: string;
  thinking?: string;
  tokens?: PiSubagentTokens;
  /** The owning Pi session id, when the payload actually reports one. */
  sessionId?: string;
  /** Which actions the API may address this row with, given the state, the target identity and the advertised capabilities. */
  operations: { stop: boolean; steer: boolean; interrupt: boolean; inspect: boolean };
}

// ---------------------------------------------------------------------------
// Snapshot view
// ---------------------------------------------------------------------------

/** A bounded display row from the package's fleet DTO (per active child, foreground included). */
export interface PiSubagentFleetEntry {
  key: string;
  agent: string;
  role?: string;
  model?: string;
  effort?: string;
  startedAt?: number;
  tokens?: PiSubagentTokens;
  goal?: string;
}

export interface PiSubagentsSnapshot {
  available: true;
  /** Milliseconds since the epoch, from the status reply when it says, else the request time. */
  generatedAt: number;
  capabilities: PiSubagentsCapabilities;
  /** Active and recent-terminal runs of this session, bounded, active first. */
  runs: PiSubagentRunRow[];
  activeCount: number;
  /** Rows the bounds dropped. */
  omitted: { rows: number; children: number; fleetEntries: number };
  /**
   * The fleet DTO's own view of the session's active work — including
   * foreground children of a running `Agent` tool, which the async snapshot
   * does not carry. Display-only: fleet keys are not control targets.
   */
  fleetSummary?: {
    totalActive: number;
    entries: PiSubagentFleetEntry[];
    omitted: number;
  };
  /** The package's own active count across the whole session, when it reports one. */
  fleetTotalActive?: number;
  /** The bounded `status` text, a human-readable overview. */
  summaryText?: string;
  /** The summary text was cut at the budget. */
  summaryTruncated?: boolean;
}

export type PiSubagentsStatusView = PiSubagentsSnapshot | PiSubagentsUnavailable;

/** The `data` of a successful `status` reply, as far as the view reads it. */
export interface SubagentStatusData {
  text?: unknown;
  details?: unknown;
  fleet?: unknown;
  asyncSnapshot?: unknown;
}

interface SnapshotNode {
  id?: unknown;
  kind?: unknown;
  label?: unknown;
  state?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  endedAt?: unknown;
  agent?: unknown;
  model?: unknown;
  thinking?: unknown;
  activity?: unknown;
  children?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeState(value: unknown): PiSubagentRunState {
  return typeof value === "string"
    && (ACTIVE_STATES.has(value) || TERMINAL_STATES.has(value))
    ? value as PiSubagentRunState
    : "unknown";
}

function nodeStatus(node: SnapshotNode): PiSubagentRunState {
  return normalizeState(node.state);
}

function rowOperations(
  row: Pick<PiSubagentRunRow, "active" | "runId" | "childId" | "kind" | "parentRunId" | "depth">,
  capabilities: PiSubagentsCapabilities,
): PiSubagentRunRow["operations"] {
  return {
    // stop: the whole run by its id, or one top-level child of a known parent
    // run. Only a depth-1 `step` is child-addressable: the package resolves a
    // child-scoped stop from [step.childId, step.workflowKey, step.runId,
    // "step:N"] of that run's top-level steps (src/runs/shared/child-identity.js,
    // called without `includeNested`), so a nested step would answer
    // `not_found`, and the id a `host-step` or unknown node carries can never be
    // resolved at all. Neither may offer a Stop button.
    stop: row.active && capabilities.stop
      && (Boolean(row.runId)
        || (row.depth === 1 && row.kind === "step" && Boolean(row.childId) && Boolean(row.parentRunId))),
    // steer targets a run id only: the snapshot carries no authoritative child
    // index, so a display offset must never be sent as one.
    steer: row.active && capabilities.steer && Boolean(row.runId),
    interrupt: row.active && capabilities.interrupt && Boolean(row.runId),
    // Output is read through a run-id-only transcript request; a child row
    // (host-step included) has no run id to read and gets no Output button.
    inspect: Boolean(row.runId),
  };
}

function tokensFrom(value: unknown): PiSubagentTokens | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = boundedNumber(record.input) ?? 0;
  const output = boundedNumber(record.output) ?? 0;
  const total = boundedNumber(record.total) ?? input + output;
  return { input, output, total };
}

/**
 * Walk the `asyncSnapshot` run tree into flat rows. Depth, children per node
 * and the total row count are bounded; whatever the bounds drop is counted in
 * `omitted`. Unknown node shapes become `unknown` rows only when they still
 * carry a label; anything unreadable is skipped, never guessed.
 */
export function normalizePiSubagentsSnapshot(
  status: SubagentStatusData | undefined,
  ping: SubagentPingData | undefined,
  options: { generatedAt?: number; fallbackGeneratedAt?: number } = {},
): PiSubagentsSnapshot {
  const capabilities = normalizePiSubagentsCapabilities(ping);
  const omitted = { rows: 0, children: 0, fleetEntries: 0 };
  const rows: PiSubagentRunRow[] = [];
  const seenKeys = new Set<string>();

  const pushRow = (row: PiSubagentRunRow) => {
    let key = row.key;
    let suffix = 2;
    while (seenKeys.has(key)) key = `${row.key}#${suffix++}`;
    seenKeys.add(key);
    rows.push({ ...row, key });
  };

  const activityOf = (node: SnapshotNode): { currentTool?: string; updatedAt?: number } => {
    const activity = asRecord(node.activity);
    return {
      ...(activity && typeof activity.currentTool === "string"
        ? { currentTool: boundedString(activity.currentTool) }
        : {}),
      ...(activity && boundedNumber(activity.lastActivityAt) !== undefined
        ? { updatedAt: boundedNumber(activity.lastActivityAt) }
        : {}),
    };
  };

  const projectNode = (node: SnapshotNode, depth: number, parentRunId: string | undefined, parentIndex: number | undefined) => {
    if (rows.length >= MAX_RUN_ROWS) return;
    const state = nodeStatus(node);
    const id = boundedString(node.id, 256);
    const kind = typeof node.kind === "string" && RUN_NODE_KINDS.has(node.kind)
      ? node.kind as PiSubagentRunRow["kind"]
      : "unknown";
    const isRunNode = kind === "subagent" || kind === "workflow";
    const row: PiSubagentRunRow = {
      key: parentRunId !== undefined
        ? `${parentRunId}:${parentIndex ?? 0}:${id ?? "node"}`
        : id ?? "run:0",
      ...(isRunNode && id !== undefined ? { runId: id } : {}),
      ...(!isRunNode && id !== undefined ? { childId: id } : {}),
      ...(parentIndex !== undefined ? { index: parentIndex } : {}),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      depth,
      kind,
      name: boundedString(node.label) ?? boundedString(node.agent) ?? "subagent",
      status: state,
      active: ACTIVE_STATES.has(state),
      terminal: TERMINAL_STATES.has(state),
      ...activityOf(node),
      ...(boundedNumber(node.startedAt) !== undefined ? { startedAt: boundedNumber(node.startedAt) } : {}),
      ...(boundedNumber(node.updatedAt) !== undefined ? { updatedAt: boundedNumber(node.updatedAt) } : {}),
      ...(boundedNumber(node.endedAt) !== undefined ? { endedAt: boundedNumber(node.endedAt) } : {}),
      ...(boundedString(node.model) !== undefined ? { model: boundedString(node.model) } : {}),
      ...(boundedString(node.thinking) !== undefined ? { thinking: boundedString(node.thinking) } : {}),
      operations: { stop: false, steer: false, interrupt: false, inspect: false },
    };
    row.operations = rowOperations(row, capabilities);
    pushRow(row);

    const children = Array.isArray(node.children) ? node.children : [];
    const kept = children.slice(0, MAX_CHILDREN_PER_NODE);
    omitted.children += children.length - kept.length;
    if (depth + 1 >= MAX_RUN_TREE_DEPTH) {
      omitted.children += kept.length;
      return;
    }
    kept.forEach((child, index) => {
      const record = asRecord(child) as SnapshotNode | null;
      if (!record || rows.length >= MAX_RUN_ROWS) {
        if (record) omitted.rows += 1;
        return;
      }
      projectNode(record, depth + 1, isRunNode && id !== undefined ? id : parentRunId, index);
    });
  };

  const snapshot = asRecord(status?.asyncSnapshot);
  const runs = snapshot && Array.isArray(snapshot.runs) ? snapshot.runs : [];
  for (const run of runs) {
    if (rows.length >= MAX_RUN_ROWS) break;
    const record = asRecord(run) as SnapshotNode | null;
    if (!record) continue;
    projectNode(record, 0, undefined, undefined);
  }
  omitted.rows += Math.max(0, runs.length - rows.length);

  const fleet = asRecord(status?.fleet);
  // The fleet summary is projected whenever the DTO is present: it is the only
  // place foreground children of a running Agent tool appear (the async
  // snapshot carries background runs only).
  let fleetSummary: PiSubagentsSnapshot["fleetSummary"];
  if (fleet && Array.isArray(fleet.entries)) {
    const entries = fleet.entries;
    const kept = entries.slice(0, MAX_FLEET_SUMMARY_ENTRIES);
    const fleetRows: PiSubagentFleetEntry[] = [];
    for (const entry of kept) {
      const record = asRecord(entry);
      const agent = boundedString(record?.agent);
      const key = boundedString(record?.key, 128);
      if (!record || !agent || !key) continue;
      fleetRows.push({
        key,
        agent,
        ...(boundedString(record.role) !== undefined ? { role: boundedString(record.role) } : {}),
        ...(boundedString(record.model) !== undefined ? { model: boundedString(record.model) } : {}),
        ...(boundedString(record.effort) !== undefined ? { effort: boundedString(record.effort) } : {}),
        ...(boundedNumber(record.startedAt) !== undefined ? { startedAt: boundedNumber(record.startedAt) } : {}),
        ...(tokensFrom(record.tokens) !== undefined ? { tokens: tokensFrom(record.tokens) } : {}),
        ...(boundedString(record.goal, 512) !== undefined ? { goal: boundedString(record.goal, 512) } : {}),
      });
    }
    const totalActive = boundedNumber(fleet.totalActive);
    if (fleetRows.length > 0 || totalActive !== undefined) {
      fleetSummary = {
        totalActive: totalActive ?? fleetRows.length,
        entries: fleetRows,
        omitted: entries.length - kept.length,
      };
    }
  }

  // Older packages without the snapshot: the fleet DTO still gives bounded
  // display rows. It exposes no run ids, so those rows carry no operations —
  // that is the package's contract, not a bug to paper over.
  if (rows.length === 0 && fleet && Array.isArray(fleet.entries)) {
    const entries = fleet.entries;
    const kept = entries.slice(0, MAX_RUN_ROWS);
    omitted.fleetEntries += entries.length - kept.length;
    for (const [index, entry] of kept.entries()) {
      const record = asRecord(entry);
      if (!record) continue;
      const state: PiSubagentRunState = "unknown";
      // The fleet DTO lists this session's active work by construction, but it
      // carries no state field, so the status stays honestly unknown.
      const row: PiSubagentRunRow = {
        key: `fleet:${boundedString(record.key, 128) ?? index}`,
        depth: 0,
        kind: "unknown",
        name: boundedString(record.agent) ?? boundedString(record.role) ?? "subagent",
        ...(boundedString(record.goal) !== undefined ? { task: boundedString(record.goal) } : {}),
        status: state,
        active: true,
        terminal: false,
        ...(boundedString(record.model) !== undefined ? { model: boundedString(record.model) } : {}),
        ...(boundedString(record.effort) !== undefined ? { thinking: boundedString(record.effort) } : {}),
        ...(boundedNumber(record.startedAt) !== undefined ? { startedAt: boundedNumber(record.startedAt) } : {}),
        ...(tokensFrom(record.tokens) !== undefined ? { tokens: tokensFrom(record.tokens) } : {}),
        operations: { stop: false, steer: false, interrupt: false, inspect: false },
      };
      row.operations = rowOperations(row, capabilities);
      pushRow(row);
    }
  }

  const text = typeof status?.text === "string" ? status.text : undefined;
  const summaryText = text !== undefined && text.length > 0
    ? (text.length > MAX_SUMMARY_TEXT ? text.slice(0, MAX_SUMMARY_TEXT) : text)
    : undefined;
  const fleetTotalActive = fleet ? boundedNumber(fleet.totalActive) : undefined;

  return {
    available: true,
    generatedAt: boundedNumber(snapshot?.generatedAt) ?? options.generatedAt ?? options.fallbackGeneratedAt ?? 0,
    capabilities,
    // Active rows first, then most recently updated — matches the snapshot's own ordering intent.
    runs: rows.sort((left, right) =>
      Number(left.active === false) - Number(right.active === false)
      || (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0)),
    activeCount: rows.filter((row) => row.active).length,
    omitted,
    ...(fleetSummary !== undefined ? { fleetSummary } : {}),
    ...(fleetTotalActive !== undefined ? { fleetTotalActive } : {}),
    ...(summaryText !== undefined ? { summaryText } : {}),
    ...(summaryText !== undefined && text !== undefined && text.length > MAX_SUMMARY_TEXT
      ? { summaryTruncated: true }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Transcript (inspect) view
// ---------------------------------------------------------------------------

export interface PiSubagentsInspectView {
  runId: string;
  /** The bounded, read-only transcript tail the package rendered. */
  text: string;
  truncated: boolean;
  lines: number;
  index?: number;
}

/** Normalize a `status { view: "transcript" }` reply into the bounded inspect view. */
export function normalizePiSubagentsTranscript(
  runId: string,
  data: SubagentStatusData | undefined,
  request: { lines?: number; index?: number } = {},
): PiSubagentsInspectView {
  const text = typeof data?.text === "string" ? data.text : "";
  const truncated = text.length > MAX_TRANSCRIPT_TEXT;
  return {
    runId,
    text: truncated ? text.slice(0, MAX_TRANSCRIPT_TEXT) : text,
    truncated,
    lines: request.lines ?? 80,
    ...(request.index !== undefined ? { index: request.index } : {}),
  };
}

// ---------------------------------------------------------------------------
// Action replies (stop / steer / interrupt)
// ---------------------------------------------------------------------------

/**
 * Bound an action reply for the UI: plain JSON only, with depth, array, key
 * and string budgets. Replaces anything outside them with null, so a hostile
 * payload cannot balloon the response.
 */
export function boundActionResult(value: unknown, depth = 0): unknown {
  if (depth >= MAX_RESULT_DEPTH) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && (Number.isNaN(value) || !Number.isFinite(value)) ? null : value;
  }
  if (typeof value === "string") {
    return value.length > MAX_FIELD_STRING ? `${value.slice(0, MAX_FIELD_STRING - 1)}…` : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_RESULT_ARRAY);
    return kept.map((item) => boundActionResult(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, MAX_RESULT_KEYS)
      .map(([key, item]) => [key, boundActionResult(item, depth + 1)] as const);
    return Object.fromEntries(entries);
  }
  return null;
}
