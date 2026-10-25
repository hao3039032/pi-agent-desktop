/**
 * The `AgentSessionLike` the real `AgentSessionWrapper` (lib/rpc-manager.ts)
 * runs when the engine is a `pi --mode rpc` child process. RpcAgentSession
 * (session.ts) is the protocol engine; this subclass fills the members the
 * wrapper reads beyond commands and events:
 *
 *   - `sessionManager`: pi-web keeps owning the session FILE. The child
 *     appends conversation entries; pi-web reads them fresh from disk on
 *     every access (two processes, one append-only JSONL) and appends its
 *     own custom entries only while the wrapper guarantees no run.
 *   - `settingsManager`: a process-local SDK `SettingsManager` over the same
 *     settings.json files the child reads (reads only; trust writes stay in
 *     lib/project-trust.ts, which shares `trust.json` with the CLI).
 *   - `extensionRunner`: no in-process extensions run here. Registered
 *     commands, prompt templates and skills come from the child's
 *     `get_commands`; UI raised by extensions in the child is relayed through
 *     the wrapper's external-UI bridge (see attachUiRelay).
 *   - `agent.state`: the event-maintained view (streamingMessage,
 *     thinkingLevel); `waitForIdle` waits on the settle.
 *
 * Tool listing: pi 1.4.0 has no `get_tools` RPC, so the bridge extension
 *   answers a request/reply subprotocol over the extension-ui notify channel:
 *   the host sends `/pi-web:bridge <requestId> <base64url-json>` and the child
 *   replies with one `PI_WEB_BRIDGE_V1` notify carrying a JSON envelope. The
 *   real `pi.getAllTools()`/`getActiveTools()`/`setActiveTools()` power the
 *   picker, and the pin persists through the child's own `pi.appendEntry`
 *   (single writer). An old bridge asset without the command degrades to the
 *   restart-based switching the factory started with.
 */

import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { NavigateTreeOptions, NavigateTreeResult, PiAgentMessage, SlashCommandInfo, ToolInfo } from "../pi-types";
import { appendClearedSessionToolSelection, appendSessionToolSelection } from "../session-tool-selection";
import { PI_SUBAGENTS_PACKAGE_NAME } from "../subagent-settings";
import { PiRpcClient, type PiRpcRecord } from "./client";
import { PiRpcUnsupportedError, RpcAgentSession, type RpcAgentSessionOptions, type RpcAgentSessionState } from "./session";

/** The subset of the SDK's SessionManager pi-web touches on a live wrapper. */
export class FileSessionManagerView {
  constructor(
    private readonly file: string,
    private readonly fallbackCwd: string,
    private readonly sessionDir?: string,
  ) {}

  private open(): SessionManager {
    return SessionManager.open(this.file, this.sessionDir);
  }

  getCwd(): string {
    try {
      return this.open().getCwd();
    } catch {
      // A file this wrapper created but the child has not flushed yet.
      return this.fallbackCwd;
    }
  }

  getSessionFile(): string {
    return this.file;
  }

  getHeader() {
    return this.open().getHeader();
  }

  getEntries() {
    return this.open().getEntries();
  }

  // The live session reload (GET /api/sessions/[id]) reads the branch tree
  // from this view for as long as the wrapper is alive.
  getTree() {
    return this.open().getTree();
  }

  getBranch(fromId?: string) {
    // Parameterized: the wrapper's clone path passes a leafId, and a
    // zero-argument forwarding view would silently drop it and read the
    // current leaf's branch instead (a wrong-answer, not a crash).
    return this.open().getBranch(fromId);
  }

  getEntry(id: string) {
    return this.open().getEntry(id);
  }

  // The tree-writing/moving members the wrapper's fork/fork_branch/clone
  // paths reach. These are FILE-level operations the backing SDK manager
  // already implements, so they work here; only in-process navigation is
  // not (the bridge extension owns that).
  isPersisted(): boolean {
    return this.open().isPersisted();
  }

  getLeafId(): string | null {
    return this.open().getLeafId();
  }

  getSessionDir(): string {
    return this.sessionDir ?? this.open().getSessionDir();
  }

  createBranchedSession(leafId: string): string | undefined {
    return this.open().createBranchedSession(leafId);
  }

  getSessionName(): string | undefined {
    return this.open().getSessionName();
  }

  appendCustomEntry(type: string, data: unknown): void {
    this.open().appendCustomEntry(type, data);
  }
}

/** What `attachUiRelay` needs from the wrapper; declared here to keep core.ts free of an rpc-manager import. */
export interface UiRelayTarget {
  /** A dialog from an extension in the child; resolves with the user's answer. */
  relayExternalUiRequest(request: PiRpcRecord): Promise<PiRpcRecord>;
  /** Fire-and-forget UI (notify/status/widget/title/editor text) from the child. */
  relayExternalUiEvent(event: PiRpcRecord): void;
}

export interface CliAgentSessionCoreOptions extends RpcAgentSessionOptions {
  /** Absolute session file both processes share. */
  sessionFile: string;
  /** The session's working folder (the child was spawned with it). */
  cwd: string;
  /** The pinned tool selection the child was spawned with, undefined for defaults. */
  spawnToolNames?: string[];
  /** All coding tool names (the preset universe) for the degraded tool list. */
  knownToolNames: readonly string[];
  /** Session storage dir (tests sandbox it); also the fork target dir. */
  sessionDir?: string;
  /** Run when the core is disposed (the factory drops its prompt-file dir). */
  onDispose?: () => void;
  /** Absolute path of the shipped bridge extension; commands are attributed to it. */
  bridgeExtensionPath: string;
  /** The session-binding nonce the child was spawned with (PI_WEB_BRIDGE_NONCE). */
  bridgeNonce: string;
  /** Bridge request timeout (default 30s; tests pass milliseconds). */
  bridgeTimeoutMs?: number;
  /**
   * How long the host waits for the child to exit before refusing to append a
   * tool pin to the session file beside it (default 15s; tests pass
   * milliseconds).
   */
  childExitTimeoutMs?: number;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Bound on the pre-relay backlog (the boot gap only). A session cannot usefully
 * present more startup UI than this; an unbounded queue here would be the only
 * structure that grows with a chatty extension.
 */
const RELAY_BACKLOG_LIMIT = 64;

/** Compare an extension source path with the shipped asset, tolerating the
 * platform's separator/case rules and symlinked module layouts. */
function sameExtensionPath(reported: string, shipped: string): boolean {
  const normalize = (value: string): string => {
    let candidate = value.replace(/\\/g, "/");
    try {
      candidate = realpathSync(candidate).replace(/\\/g, "/");
    } catch {
      // A missing file (or a jiti-resolved virtual path) compares as written.
    }
    return process.platform === "win32" ? candidate.toLowerCase() : candidate;
  };
  return normalize(reported) === normalize(shipped);
}

/** The command the child's bridge extension registers for host state requests. */
const BRIDGE_COMMAND = "pi-web:bridge";
/** The result-channel marker; assets/pi-web-bridge.mjs must use the same bytes. */
const BRIDGE_RESULT_PREFIX = "PI_WEB_BRIDGE_V1 ";
const BRIDGE_TOOL_EXPOSURES = new Set(["direct", "model-only", "codemode", "deferred", "hidden"]);
/** A protocol budget (mirrors the asset's MAX_BRIDGE_TOOLS), not a product
 * limit: exceeding it is a reported protocol failure, never a silent
 * capability drop, and it is high enough that a legitimate MCP-heavy session
 * (hundreds of tools) never hits it. */
const BRIDGE_TOOL_LIMIT = 2048;

/** The completion record one bridge request keeps, whatever settles first. */
interface BridgeOutcome {
  ok: boolean;
  value?: unknown;
  error?: Error;
}

/** A bridge op the child refused, carrying its machine-readable code (when it sent one). */
export class BridgeOpError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "BridgeOpError";
  }
}

/** One in-flight bridge request, resolved by the child's result notify. */
interface BridgePending {
  op: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Set by whichever settle path ran first (reply, timeout, exit, dispose). */
  outcome: BridgeOutcome | undefined;
}

/** Plain text of a message content (string or blocks), the SDK's editorText derivation. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("");
  return text || undefined;
}

interface GetCommandsResult {
  commands?: Array<SlashCommandInfo & { source?: string }>;
}

export class CliAgentSessionCore extends RpcAgentSession {
  private readonly coreSessionFile: string;
  private readonly sessionCwd: string;
  private readonly sessionDir: string | undefined;
  private onDisposeCallback: (() => void) | undefined;
  private readonly spawnToolNames: string[] | undefined;
  private readonly knownToolNames: readonly string[];
  private readonly localSettings: SettingsManager;
  private readonly view: FileSessionManagerView;
  private commandsCache: GetCommandsResult["commands"];
  private uiRelay: UiRelayTarget | undefined;
  private offUiRelay: Array<() => void> = [];
  /**
   * Fire-and-forget child UI raised between this core's construction and
   * attachUiRelay (a startup notify/status/widget): bounded, arrival-ordered.
   */
  private relayBacklog: PiRpcRecord[] = [];
  /** Bridge request/reply state (see bridgeRequest). */
  private readonly bridgeNote: (line: string) => void;
  private readonly offBridgeNotify: () => void;
  private readonly bridgeNonce: string;
  private readonly bridgeTimeoutMs: number;
  private readonly childExitTimeoutMs: number;
  private readonly bridgeExtensionPath: string;
  /** Command names the SHIPPED bridge asset registered (source-path verified). */
  private bridgeCommandNames = new Set<string>();
  private bridgePending = new Map<string, BridgePending>();
  /** Tool operations state: unsupported (old asset), live, or failed (protocol error). */
  private toolsUnsupported = false;
  private liveTools = false;
  private toolsFailure: Error | undefined;
  private toolsListCache: ToolInfo[] = [];
  private activeToolsCache: string[] | undefined;

  constructor(options: CliAgentSessionCoreOptions) {
    super(options);
    this.coreSessionFile = options.sessionFile;
    this.sessionCwd = options.cwd;
    this.spawnToolNames = options.spawnToolNames;
    this.knownToolNames = options.knownToolNames;
    this.sessionDir = options.sessionDir;
    this.onDisposeCallback = options.onDispose;
    this.bridgeNonce = options.bridgeNonce;
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? 30_000;
    this.childExitTimeoutMs = options.childExitTimeoutMs ?? 15_000;
    this.bridgeExtensionPath = options.bridgeExtensionPath;
    this.view = new FileSessionManagerView(this.coreSessionFile, this.sessionCwd, options.sessionDir);
    this.localSettings = SettingsManager.create(this.sessionCwd, options.agentDir ?? getAgentDir());
    this.bridgeNote = options.onLog ?? ((line) => console.log(`[pi-rpc] ${line}`));
    // The bridge result channel owns "notify": it is registered for the core's
    // whole lifetime (refreshTools runs before attachUiRelay wires the relay)
    // and forwards every non-bridge notify to the relay unchanged.
    this.offBridgeNotify = this.rpc.onUi("notify", (record) => this.onNotifyRecord(record));
  }

  /** Wire the wrapper in after it exists; registers the child-UI subprotocol handlers. */
  attachUiRelay(relay: UiRelayTarget): void {
    this.uiRelay = relay;
    // Whatever the child raised before the wrapper existed is replayed first,
    // in arrival order, so a startup notify/status is not silently dropped.
    for (const event of this.relayBacklog.splice(0)) {
      try {
        relay.relayExternalUiEvent(event);
      } catch {
        // One bad consumer must not cost the rest of the backlog.
      }
    }
    const client: PiRpcClient = this.rpc;
    for (const method of DIALOG_METHODS) {
      this.offUiRelay.push(client.onUi(method, (record) => {
        if (!this.uiRelay) return { cancelled: true };
        // A relay failure (Stop, wrapper gone) must still answer the child.
        return this.uiRelay.relayExternalUiRequest(record).catch(() => ({ cancelled: true }));
      }));
    }
    // "notify" is owned by the bridge result channel (constructor); every
    // other fire-and-forget method relays unchanged.
    for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      this.offUiRelay.push(client.onUi(method, (record) => {
        this.relayUiEvent(record);
        return undefined;
      }));
    }
    // Anything the relay does not cover must not block the child.
  }

  /**
   * Hand one fire-and-forget child-UI record to the wrapper, or hold it (bounded)
   * until attachUiRelay exists — before that `uiRelay` is undefined and the
   * record would be lost.
   */
  private relayUiEvent(record: PiRpcRecord): void {
    if (this.uiRelay) {
      this.uiRelay.relayExternalUiEvent(record);
      return;
    }
    this.relayBacklog.push(record);
    if (this.relayBacklog.length > RELAY_BACKLOG_LIMIT) this.relayBacklog.shift();
  }

  dispose(): void {
    // Pending bridge requests must not wait for their 30s timers: the session
    // is going away, and every caller gets an immediate, diagnosable reject.
    for (const [requestId, pending] of [...this.bridgePending]) {
      this.settleBridge(pending, { ok: false, error: new Error(`pi-web bridge '${pending.op}' was cancelled: the session is being disposed`) });
      this.bridgePending.delete(requestId);
    }
    try {
      this.offBridgeNotify();
    } catch {
      // unsubscribe races are harmless at dispose
    }
    for (const off of this.offUiRelay.splice(0)) {
      try {
        off();
      } catch {
        // unsubscribe races are harmless at dispose
      }
    }
    this.uiRelay = undefined;
    this.relayBacklog.splice(0);
    const disposeExtras = this.onDisposeCallback;
    this.onDisposeCallback = undefined;
    super.dispose();
    if (disposeExtras) {
      try {
        disposeExtras();
      } catch {
        // best effort
      }
    }
  }

  // --- heavy members -------------------------------------------------------

  get sessionManager(): SessionManager {
    // Structural: the wrapper only calls the members FileSessionManagerView
    // implements. The cast is contained here; M4 replaces the SDK types.
    return this.view as unknown as SessionManager;
  }

  get settingsManager(): SettingsManager {
    return this.localSettings;
  }

  /** Stable identity: the wrapper and tests patch `extensionRunner.emit` by reference. */
  private extensionRunnerView: {
    getRegisteredCommands(): Array<{
      invocationName: string;
      description?: string;
      sourceInfo: SlashCommandInfo["sourceInfo"];
    }>;
    setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
    emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  } | undefined;

  get extensionRunner(): {
    getRegisteredCommands(): Array<{
      invocationName: string;
      description?: string;
      sourceInfo: SlashCommandInfo["sourceInfo"];
    }>;
    setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
    emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  } {
    if (!this.extensionRunnerView) {
      this.extensionRunnerView = {
        getRegisteredCommands: () =>
          (this.commandsCache ?? [])
            .filter((command) => command.source === "extension")
            .map((command) => ({
              invocationName: command.name,
              description: command.description,
              sourceInfo: command.sourceInfo,
            })),
        setUIContext: () => {
          // Extensions live in the child; their UI context is the RPC
          // subprotocol this core relays, not an in-process context.
        },
        emit: async () => {
          // The child runs its own session_shutdown when stdin closes
          // (client.close() in dispose); nothing to forward in-process.
        },
      };
    }
    return this.extensionRunnerView;
  }

  get promptTemplates(): Array<{
    name: string;
    description?: string;
    sourceInfo: SlashCommandInfo["sourceInfo"];
  }> {
    return (this.commandsCache ?? [])
      .filter((command) => command.source === "prompt")
      .map((command) => ({
        name: command.name,
        description: command.description,
        sourceInfo: command.sourceInfo,
      }));
  }

  get resourceLoader(): {
    getSkills(): {
      skills: Array<{
        name: string;
        description?: string;
        sourceInfo: SlashCommandInfo["sourceInfo"];
        filePath?: string;
        baseDir?: string;
      }>;
    };
    getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  } {
    return {
      getSkills: () => ({
        skills: (this.commandsCache ?? [])
          .filter((command) => command.source === "skill")
          .map((command) => ({
            name: command.name.replace(/^skill:/, ""),
            description: command.description,
            sourceInfo: command.sourceInfo,
            filePath: command.sourceInfo?.path,
            baseDir: command.sourceInfo?.path ? dirname(command.sourceInfo.path) : undefined,
          })),
      }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    };
  }

  get agent(): {
    state?: {
      thinkingLevel?: string;
      streamingMessage?: PiAgentMessage;
    };
    waitForIdle?: () => Promise<void>;
  } {
    return super.agent;
  }

  // --- bridge request/reply (host state through the child's extension) ------

  /**
   * One host→child state request over the bridge command, answered by the
   * child's result notify. `disposition: "handled"` alone is NOT success: the
   * promise resolves only on the child's `{ok, result}` envelope, so a lost,
   * late or mismatched answer rejects (never a silent success). The message
   * the child receives is `/pi-web:bridge <requestId> <base64url-json>` — a
   * registered extension command consumed by the extension runtime (no run
   * starts, so the tokens never become model input), and the requestId
   * correlates exactly one reply.
   */
  async bridgeRequest<T = unknown>(
    op: string,
    args?: Record<string, unknown>,
    timeoutMs = this.bridgeTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.hasBridgeCommand(BRIDGE_COMMAND)) {
      throw new Error(`the pi-web bridge command is not registered in the child; cannot run bridge op '${op}'`);
    }
    const abortError = () => (signal?.reason instanceof Error
      ? signal.reason
      : new DOMException(`pi-web bridge '${op}' was cancelled`, "AbortError"));
    if (signal?.aborted) throw abortError();
    const requestId = `pwb-${randomUUID()}`;
    // The op and the session nonce are the host's, not the caller's: they are
    // written AFTER the args spread so no argument can retarget the operation
    // or replay another session's request.
    const token = Buffer.from(
      JSON.stringify({ ...(args ?? {}), op, nonce: this.bridgeNonce }),
      "utf8",
    ).toString("base64url");

    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: Error) => void;
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Abandoned results (the ack path failed first) must not surface as
    // unhandled rejections; whoever still awaits sees the real error.
    resultPromise.catch(() => {});
    const pending: BridgePending = {
      op,
      timer: setTimeout(() => {
        this.settleBridge(pending, { ok: false, error: new Error(`pi-web bridge '${op}' did not answer within ${timeoutMs} ms`) });
        this.bridgePending.delete(requestId);
      }, timeoutMs),
      resolve: resolveResult,
      reject: rejectResult,
      outcome: undefined,
    };
    // Ref'd on purpose: a genuinely pending request keeps the event loop (and
    // a test runner) alive until it settles or the core is disposed, which
    // clears every pending timer.
    this.bridgePending.set(requestId, pending);
    const offExit = this.rpc.onProcessExit((code) => {
      if (pending.outcome === undefined) {
        this.settleBridge(pending, { ok: false, error: new Error(`pi process exited during bridge '${op}' (code ${code ?? "?"})`) });
        this.bridgePending.delete(requestId);
      }
    });
    // The caller's cancellation ends the HOST's wait only: the bridge op was
    // already sent to the child, and claiming it was undone would lie. The
    // late ack/reply finds no pending entry and is dropped.
    const onAbort = () => {
      if (pending.outcome === undefined) {
        this.settleBridge(pending, { ok: false, error: abortError() });
        this.bridgePending.delete(requestId);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // The prompt ack and the result notify are independent channels. The
      // ack only says the message was an extension command; the result is the
      // operation's answer. Waiting on the ack first would let a child that
      // never acks swallow a dispose/exit/timeout until the ack's own (longer)
      // deadline, so the two are raced and whichever settles the request first
      // decides. `ackOutcome` never rejects: the loser of the race must not
      // surface as an unhandled rejection.
      const ackOutcome = this.rpc.command<{ disposition?: string }>(
        "prompt",
        { message: `/${BRIDGE_COMMAND} ${requestId} ${token}` },
        timeoutMs + 10_000,
      ).then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      ackOutcome.catch(() => {});
      // Settles (never rejects) as soon as the request's own outcome exists:
      // reply, child error, timeout, exit or dispose.
      const resultSettled = resultPromise.then(() => "result" as const, () => "result" as const);
      const first = await Promise.race([resultSettled, ackOutcome.then(() => "ack" as const)]);

      if (first === "result") {
        // The operation finished first (normally: the child notifies before it
        // acks). Its outcome is the truth; a late or failing ack cannot change
        // it, and the request is already out of the pending map.
        if (pending.outcome?.ok) return pending.outcome.value as T;
        throw pending.outcome?.error ?? new Error(`pi-web bridge '${op}' failed`);
      }

      const ack = await ackOutcome;
      if (!ack.ok) {
        // The ack broke before any reply. An outcome that arrived meanwhile
        // still explains itself first (a reply wins over a transport fault);
        // otherwise the ack error is the diagnosable reason.
        if (pending.outcome?.ok) return pending.outcome.value as T;
        throw pending.outcome && !pending.outcome.ok
          ? pending.outcome.error!
          : ack.error instanceof Error ? ack.error : new Error(String(ack.error));
      }
      if (ack.response?.disposition !== "handled") {
        throw new Error(
          `pi-web bridge '${op}': the child did not treat the message as an extension command `
            + `(disposition ${JSON.stringify(ack.response?.disposition)}); refusing to guess the result`,
        );
      }
      // A handled ack with no reply yet: the result timer (or exit/dispose) is
      // the floor. The child normally notifies before the ack.
      return await resultPromise as T;
    } catch (error) {
      if (pending.outcome === undefined) {
        this.settleBridge(pending, { ok: false, error: error instanceof Error ? error : new Error(String(error)) });
      }
      this.bridgePending.delete(requestId);
      throw error;
    } finally {
      offExit();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Record one completion on the pending entry and settle its promise. */
  private settleBridge(pending: BridgePending, outcome: BridgeOutcome): void {
    if (pending.outcome !== undefined) return;
    clearTimeout(pending.timer);
    pending.outcome = outcome;
    if (outcome.ok) pending.resolve(outcome.value);
    else pending.reject(outcome.error ?? new Error("pi-web bridge request failed"));
  }

  /** Route one child notify: a bridge envelope resolves its request, everything else relays. */
  private onNotifyRecord(record: PiRpcRecord): void {
    let message: unknown;
    try {
      message = record.message;
      if (typeof message !== "string" || !message.startsWith(BRIDGE_RESULT_PREFIX)) {
        // A plain notify (never a bridge envelope) is an ordinary user-facing
        // message: relay it, or hold it until the wrapper is attached.
        this.relayUiEvent(record);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.slice(BRIDGE_RESULT_PREFIX.length));
      } catch {
        this.bridgeNote(`dropped an unparseable bridge result: ${message.slice(BRIDGE_RESULT_PREFIX.length, 120)}`);
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        // JSON.parse("null") / arrays must degrade to a drop, never a throw.
        this.bridgeNote(`dropped a non-object bridge result: ${message.slice(BRIDGE_RESULT_PREFIX.length, 120)}`);
        return;
      }
      const envelope = parsed as {
        sid?: unknown; rid?: unknown; nonce?: unknown; ok?: unknown; result?: unknown; error?: unknown; code?: unknown;
      };
      const requestId = typeof envelope.rid === "string" ? envelope.rid : undefined;
      const pending = requestId !== undefined ? this.bridgePending.get(requestId) : undefined;
      if (pending === undefined) {
        // Not ours (a stale reply, or a user typing the command by hand): never
        // a user-facing notification, and never a success for anyone.
        this.bridgeNote(`dropped a bridge result with no pending request (rid ${requestId ?? "?"})`);
        return;
      }
      const fail = (error: Error) => {
        this.settleBridge(pending, { ok: false, error });
        this.bridgePending.delete(requestId!);
      };
      if (envelope.nonce !== this.bridgeNonce) {
        fail(new Error(`pi-web bridge '${pending.op}' answered with the wrong session nonce`));
        return;
      }
      if (envelope.sid !== this.sessionId) {
        fail(new Error(
          `pi-web bridge '${pending.op}' answered for session ${JSON.stringify(envelope.sid)} instead of ${JSON.stringify(this.sessionId)}`,
        ));
        return;
      }
      if (envelope.ok === true) {
        this.settleBridge(pending, { ok: true, value: envelope.result });
        this.bridgePending.delete(requestId!);
      } else {
        fail(new BridgeOpError(
          `pi-web bridge '${pending.op}' failed: ${typeof envelope.error === "string" ? envelope.error : "unknown error"}`,
          typeof envelope.code === "string" ? envelope.code : undefined,
        ));
      }
    } catch (error) {
      // The result channel must never break the client's dispatch loop.
      this.bridgeNote(`bridge notify handling failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- tool listing and switching (the child's real state) -----------------

  /**
   * Probe/refresh the child's tool operations. Three explicit outcomes:
   *   - live: the bridge answered; later refreshes keep the caches real.
   *   - unsupported: no bridge command from the shipped asset, or the asset
   *     knows no tool ops (an older build) — the spawn-time coding-tool list
   *     stands, logged once, and switching stays restart-based.
   *   - failure (THROWN): the bridge is there but its answer was invalid,
   *     oversized or late. That is a protocol fault, not a degradation: the
   *     static list must never stand in for a broken real one.
   */
  async refreshTools(): Promise<void> {
    if (this.toolsUnsupported) return;
    if (!this.hasBridgeCommand(BRIDGE_COMMAND)) {
      this.toolsUnsupported = true;
      this.bridgeNote("bridge tool operations unsupported: the shipped bridge asset registered no bridge command; tool changes stay restart-based");
      return;
    }
    try {
      await this.queryTools();
      this.liveTools = true;
      this.toolsFailure = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("unknown bridge op")) {
        this.toolsUnsupported = true;
        this.bridgeNote(`bridge tool operations unsupported (${message}); tool changes stay restart-based`);
        return;
      }
      this.liveTools = false;
      this.toolsFailure = error instanceof Error ? error : new Error(message);
      throw this.toolsFailure;
    }
  }

  /** Whether the child's bridge answers tool operations (set at spawn). */
  supportsLiveToolSwitch(): boolean {
    return this.liveTools;
  }

  // --- restricted pi-subagents RPC (the child's event bus) -----------------

  /**
   * One restricted pi-subagents RPC, forwarded to the child's extension event
   * bus by the bridge (`subagents.<method>`). The package's listener lives in
   * the child, so this is the only path from the server to it. No idle guard:
   * the fleet polls status and sends control exactly while a run is going.
   * Returns the package's reply body (`{success, data|error}`) and throws only
   * when the transport itself failed (no bridge, child exit, timeout, unknown
   * op on an older bridge asset).
   */
  async requestSubagentsRpc(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ success?: boolean; data?: unknown; error?: { code: string; message: string } }> {
    const result = await this.bridgeRequest<{ success?: boolean; data?: unknown; error?: { code: string; message: string } }>(
      `subagents.${method}`,
      { ...(params !== undefined ? { params } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
      (options.timeoutMs ?? 20_000) + 5_000,
      options.signal,
    );
    if (typeof result !== "object" || result === null) {
      throw new Error(`pi-web bridge 'subagents.${method}' returned no reply body`);
    }
    return result;
  }

  /**
   * Whether the pi-subagents package is visible in this child, by SOURCE, never
   * by tool name: the tool list and the command list both carry `sourceInfo`
   * (path + package source), and a package that registers any tool or command
   * shows up in at least one of them.
   *
   * `unknown` is a real answer: without either list there is no evidence, and
   * "no evidence" must never be reported as "not installed".
   */
  piSubagentsExtensionState(): "loaded" | "not-loaded" | "unknown" {
    const sources: Array<{ path?: unknown; source?: unknown }> = [];
    for (const tool of this.toolsListCache) {
      const info = tool.sourceInfo;
      if (info && typeof info === "object") sources.push(info as { path?: unknown; source?: unknown });
    }    for (const command of this.commandsCache ?? []) {
      const info = command.sourceInfo;
      if (info && typeof info === "object") sources.push(info as { path?: unknown; source?: unknown });
    }
    if (sources.length === 0) return "unknown";
    for (const info of sources) {
      const path = typeof info.path === "string" ? info.path : "";
      const source = typeof info.source === "string" ? info.source : "";
      const segments = `${path}\u0000${source}`.replaceAll("\\", "/").split(/[\u0000/]/);
      if (segments.some((segment) => segment === PI_SUBAGENTS_PACKAGE_NAME)
        || source.replace(/^npm:/, "").split("@")[0] === PI_SUBAGENTS_PACKAGE_NAME) {
        return "loaded";
      }
    }
    return "not-loaded";
  }

  /** The tools.list bridge query, validated into the caches. */
  private async queryTools(): Promise<void> {
    const result = await this.bridgeRequest<{ tools?: unknown; active?: unknown }>("tools.list");
    if (!Array.isArray(result?.tools) || !Array.isArray(result?.active)) {
      throw new Error("pi-web bridge 'tools.list' did not return {tools, active}");
    }
    if (result.tools.length > BRIDGE_TOOL_LIMIT || result.active.length > BRIDGE_TOOL_LIMIT) {
      throw new Error(`pi-web bridge 'tools.list' returned too many tools (${result.tools.length}/${result.active.length})`);
    }
    const tools: ToolInfo[] = [];
    for (const entry of result.tools) {
      if (typeof entry !== "object" || entry === null) throw new Error("pi-web bridge 'tools.list' returned a non-object tool");
      const tool = entry as Record<string, unknown>;
      if (typeof tool.name !== "string" || !tool.name) throw new Error("pi-web bridge 'tools.list' returned a tool without a name");
      const exposure = tool.exposure === undefined ? undefined : tool.exposure;
      if (exposure !== undefined && typeof exposure !== "string") {
        throw new Error(`pi-web bridge 'tools.list' returned tool ${tool.name} with a non-string exposure`);
      }
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
        ...(Array.isArray(tool.promptGuidelines) ? { promptGuidelines: tool.promptGuidelines as string[] } : {}),
        ...(exposure !== undefined && BRIDGE_TOOL_EXPOSURES.has(exposure) ? { exposure: exposure as ToolInfo["exposure"] } : {}),
        ...(tool.sourceInfo !== undefined ? { sourceInfo: tool.sourceInfo } : {}),
      });
    }
    this.toolsListCache = tools;
    this.activeToolsCache = result.active.filter((name): name is string => typeof name === "string");
  }

  getAllTools(): ToolInfo[] {
    if (this.toolsFailure !== undefined) {
      throw new Error(`pi-web bridge tool listing failed: ${this.toolsFailure.message}`);
    }
    if (this.liveTools) return this.toolsListCache;
    // Unsupported (old bridge asset): the preset universe the child was
    // spawned from — the honest answer when the child exposes no tool query.
    return this.knownToolNames.map((name) => ({
      name,
      description: "",
      exposure: "direct" as const,
    }));
  }

  getActiveToolNames(): string[] {
    if (this.liveTools) return this.activeToolsCache ?? [];
    return this.spawnToolNames ?? [...this.knownToolNames];
  }

  /**
   * Apply an active-tool set in the child. The names must already be resolved
   * (coding selection + carried extension tools, shell mapping applied); the
   * child ignores unknown and hidden names, and the reply's active list is the
   * confirmation the cache keeps.
   */
  override async setActiveToolsByName(names: string[]): Promise<void> {
    if (!this.liveTools) {
      throw new Error("Tool changes on this pi CLI engine restart the session; the bridge exposes no tool operations");
    }
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 128)) {
      throw new Error("setActiveToolsByName: names must be tool-name strings");
    }
    if (names.length > BRIDGE_TOOL_LIMIT) throw new Error(`setActiveToolsByName: too many names (${names.length})`);
    const result = await this.bridgeRequest<{ active?: unknown }>("tools.set", { names });
    if (!Array.isArray(result?.active)) {
      throw new Error("pi-web bridge 'tools.set' did not confirm with an active tool list");
    }
    this.activeToolsCache = result.active.filter((name): name is string => typeof name === "string");
  }

  /**
   * Atomically apply a resolved active set AND persist its pin: one child-side
   * transaction (set + confirm, then the pin entry; a pin failure restores the
   * previous loadout), so the session and its file never disagree.
   */
  async applyToolSelection(names: string[], pin: string[]): Promise<void> {
    if (!this.liveTools) {
      throw new Error("Tool changes on this pi CLI engine restart the session; the bridge exposes no tool operations");
    }
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 128)) {
      throw new Error("applyToolSelection: names must be tool-name strings");
    }
    if (names.length > BRIDGE_TOOL_LIMIT) throw new Error(`applyToolSelection: too many names (${names.length})`);
    if (!Array.isArray(pin) || pin.some((name) => typeof name !== "string" || name.length === 0)) {
      throw new Error("applyToolSelection: pin must be an array of tool names");
    }
    const result = await this.bridgeRequest<{ active?: unknown }>("tools.apply", { names, pin: { tools: [...pin] } });
    if (!Array.isArray(result?.active)) {
      throw new Error("pi-web bridge 'tools.apply' did not confirm with an active tool list");
    }
    this.activeToolsCache = result.active.filter((name): name is string => typeof name === "string");
  }

  /**
   * Whether the pin can be appended while the child is alive: the bridge's
   * tool operations answer and the child has not exited. This is about
   * persistence only — a chat-only session refuses live SWITCHING but still
   * owns its file.
   */
  canPersistToolPinLive(): boolean {
    return this.liveTools && !this.rpc.hasExited;
  }

  /**
   * Persist the session's tool pin. A live child with tool operations appends
   * it itself (single writer). Otherwise the only writer left is the host, and
   * only once the child is gone: the restart path shuts it down first, so this
   * waits for that exit instead of appending beside a live writer — and never
   * sends a bridge command to a child that already exited.
   */
  async persistToolSelection(toolNames: string[] | undefined): Promise<void> {
    if (this.canPersistToolPinLive()) {
      await this.bridgeRequest("tools.pin", toolNames === undefined ? { cleared: true } : { tools: toolNames });
      return;
    }
    await this.waitForChildExit();
    if (toolNames === undefined) appendClearedSessionToolSelection(this.view as unknown as SessionManager);
    else appendSessionToolSelection(this.view as unknown as SessionManager, toolNames);
  }

  /**
   * Wait for the child process to be gone, so the host is the session file's
   * only writer. Returns at once when it already exited; a child that outlives
   * the wait is an error (the pin is never appended next to a live writer).
   */
  async waitForChildExit(): Promise<void> {
    if (this.rpc.hasExited) return;
    await new Promise<void>((resolve, reject) => {
      let off = (): void => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error(
          `the pi child is still running after ${this.childExitTimeoutMs} ms; `
            + "refusing to append the tool pin beside a live session writer",
        ));
      }, this.childExitTimeoutMs);
      timer.unref?.();
      off = this.rpc.onProcessExit(() => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  // --- tree navigation via the bridge extension ----------------------------

  /**
   * The bridge extension's `/pi-web:navigate` command runs the child's own
   * navigateTree (in-memory leaf move; the file keeps every branch). The
   * editor text for a re-edit target is computed here from the entry, the
   * same way the SDK derives it. The `summarize` flag goes through; its
   * branch_summary entry lands in the shared file for the reader to show.
   * Aborting an in-flight summary is not reachable through a command, so
   * abortBranchSummary stays unsupported on this engine.
   */
  override async navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult> {
    if (this.isStreaming || this.isCompacting) {
      throw new Error("Wait for the current response to finish before navigating the session tree.");
    }
    const targetEntry = this.view.getEntry(targetId);
    if (!targetEntry) throw new Error(`Entry ${targetId} not found`);

    const commandParts = ["pi-web:navigate", targetId];
    if (options?.summarize) commandParts.push("--summarize");
    if (typeof options?.customInstructions === "string" && options.customInstructions.trim()) {
      commandParts.push("--instructions-b64", Buffer.from(options.customInstructions.trim(), "utf8").toString("base64"));
    }
    // "handled" is the only healthy outcome: the bridge owns the command, so
    // no run starts. A rejection (busy tree, cancelled summary) propagates
    // exactly like the SDK's navigateTree throwing.
    await this.rpc.command("prompt", { message: `/${commandParts.join(" ")}` }, 120_000);
    // The child restored the target branch's loadout; pick up the real set.
    // The navigation itself already happened, so the error says so — a bare
    // refresh failure would invite the user to navigate again.
    try {
      await this.refreshTools();
    } catch (error) {
      throw new Error(
        `the session navigated to ${targetId}, but refreshing its tool state failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }

    // Mirror the SDK: re-editing a user (or custom) message puts its text
    // back into the composer and moves the leaf to its parent.
    const entry = targetEntry as { type?: string; message?: { role?: string; content?: unknown }; content?: unknown };
    if (entry.type === "custom_message") {
      return { cancelled: false, editorText: contentText(entry.content) };
    }
    if (entry.type === "message" && entry.message?.role === "user") {
      return { cancelled: false, editorText: contentText(entry.message.content) };
    }
    return { cancelled: false };
  }

  /** The bridge's `/pi-web:reload` runs the child's own extension/skill/context reload. */
  override async reload(): Promise<void> {
    // Reload restarts extensions and reconnects MCP servers — the same order of
    // work as compaction, so it gets the same generous timeout.
    await this.rpc.command("prompt", { message: "/pi-web:reload" }, 600_000);
    // The new runtime re-registered commands and rebuilt the tool registry.
    // The reload itself already happened, so the error says so — a bare refresh
    // failure would invite the user to reload again.
    try {
      await this.refreshCommands();
      await this.refreshTools();
    } catch (error) {
      throw new Error(
        `the session reloaded its extensions, but refreshing its state failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  // --- commands cache ------------------------------------------------------

  /**
   * Whether the SHIPPED bridge asset registered a command by name. The check
   * is source-based: a same-named command from any other extension is NOT the
   * bridge (the factory would otherwise trust a stranger's handler), so the
   * command's sourceInfo.path must resolve to the bridge extension file.
   */
  hasBridgeCommand(name: string): boolean {
    return this.bridgeCommandNames.has(name);
  }

  /** Refresh the get_commands-backed views; called by the factory after spawn. */
  async refreshCommands(): Promise<void> {
    const result = await this.rpc.command<GetCommandsResult>("get_commands", {}, 60_000);
    this.commandsCache = Array.isArray(result?.commands) ? result.commands : [];
    this.noteBridgeCommands();
  }

  /** Re-attribute bridge commands after a reload replaced the extension runtime. */
  private noteBridgeCommands(): void {
    const names = new Set<string>();
    for (const command of this.commandsCache ?? []) {
      if (command.name?.startsWith("pi-web:") && command.source === "extension" && command.sourceInfo?.path
        && sameExtensionPath(command.sourceInfo.path, this.bridgeExtensionPath)) {
        names.add(command.name);
      }
    }
    this.bridgeCommandNames = names;
  }
}

/** Ensure the session file exists with pi-web's header before the child opens it. */
export function ensureSessionFile(
  manager: SessionManager,
): string {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Session manager produced no session file");
  if (!existsSync(file)) {
    const header = manager.getHeader();
    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    try {
      writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      // Concurrent starts of the same file race on `wx`; whoever won, the
      // precondition (the file exists with a header) is satisfied either way.
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    // Pi delays the first flush until a user or assistant message exists;
    // our generated entries are already on disk (persistBashOnlySession's trick).
    (manager as unknown as { flushed: boolean }).flushed = true;
  }
  return file;
}

/** Default state merged with the child's first get_state. */
export function initialCoreState(state: Partial<RpcAgentSessionState>): RpcAgentSessionState {
  return {
    sessionId: state.sessionId ?? "",
    sessionFile: state.sessionFile,
    sessionName: state.sessionName,
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    autoCompactionEnabled: true,
    // get_state reports no autoRetryEnabled field (docs/rpc-commands.md), so
    // the child's retry policy is UNKNOWN here. Claiming `true` asserted a
    // policy the child never confirmed; undefined stays "unknown" all the way
    // to the UI (hooks/useSessionAutomation keeps null, the automation menu
    // hides the switch) until set_auto_retry or an auto_retry_start event
    // proves a value.
    autoRetryEnabled: state.autoRetryEnabled,
    retryAttempt: 0,
    messageCount: 0,
    pendingMessageCount: 0,
    steeringQueue: [],
    followUpQueue: [],
    ...state,
  };
}
