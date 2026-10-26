/**
 * An `AgentSessionLike` (lib/pi-types.ts) whose engine is a `pi --mode rpc`
 * child process instead of the in-process SDK session. One RpcAgentSession
 * owns one child; the wrapper (rpc-manager) keeps working because every
 * member it reads maps onto either an RPC command or a field of the event
 * stream's state machine.
 *
 * Scope (M1): the normal project-session path. Chat workspaces, subagent
 * resources, and dynamic tool allow-lists are later milestones; their members
 * throw `PiRpcUnsupportedError` instead of silently doing nothing, so a wrong
 * wiring fails loudly in tests rather than degrading in production.
 */

import type { ContextUsage, ModelLike, NavigateTreeOptions, NavigateTreeResult, PiAgentMessage, SessionStatsInfo, ToolInfo } from "../pi-types";
import type { PiRpcClient, PiRpcRecord } from "./client";

export class PiRpcUnsupportedError extends Error {
  constructor(member: string, milestone: string) {
    super(`${member} is not available on the pi CLI RPC backend yet (${milestone})`);
    this.name = "PiRpcUnsupportedError";
  }
}

export interface RpcAgentSessionState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isIdle: boolean;
  autoCompactionEnabled: boolean;
  /**
   * Unknown until the child proves it: get_state reports no auto-retry field,
   * so only set_auto_retry (the UI's own choice) or an auto_retry_start event
   * sets it. undefined means "the child never told us", never "disabled".
   */
  autoRetryEnabled: boolean | undefined;
  retryAttempt: number;
  steeringMode?: string;
  followUpMode?: string;
  model?: ModelLike & Record<string, unknown>;
  thinkingLevel?: string;
  messageCount: number;
  pendingMessageCount: number;
  steeringQueue: string[];
  followUpQueue: string[];
}

interface QueuesSnapshot {
  steering: string[];
  followUp: string[];
}

type SessionEventListener = (event: PiRpcRecord) => void;

/** Run-liveness fields a stale get_state snapshot must never overwrite (see RpcAgentSession.applyState). */
const VOLATILE_STATE_KEYS: ReadonlyArray<keyof RpcAgentSessionState> = [
  "isStreaming",
  "isIdle",
  "messageCount",
  "pendingMessageCount",
  "steeringQueue",
  "followUpQueue",
];

export interface RpcAgentSessionOptions {
  client: PiRpcClient;
  /** Resolved by the factory from `get_state` when the child is ready. */
  initialState: RpcAgentSessionState;
  /** Diagnostic sink for protocol-level notes (defaults to console). */
  onLog?: (line: string) => void;
  /** Overrides ~/.pi/agent for process-local views (tests). */
  agentDir?: string;
}

export class RpcAgentSession {
  private listeners = new Set<SessionEventListener>();
  private disposed = false;
  private state: RpcAgentSessionState;
  private readonly client: PiRpcClient;
  private readonly offEvents: () => void;
  private toolsCache: ToolInfo[] = [];
  private bashRunning = false;
  private lastAssistantText: string | undefined;
  private streamingMessage: PiAgentMessage | undefined;
  /** Shared by every modelRuntime read (the factory does getModel→refresh→getModel). */
  private modelsCache: Array<ModelLike & Record<string, unknown>> | undefined;
  /** Bumped by every agent_start; a settle records the epoch it ended. */
  private runEpoch = 0;
  private settledEpoch = 0;

  constructor(options: RpcAgentSessionOptions) {
    this.client = options.client;
    this.state = { ...options.initialState };
    this.offEvents = options.client.onEvent((record) => this.onRecord(record));
  }

  // --- lifecycle -----------------------------------------------------------

  /** The underlying client, for the session manager's close/kill paths. */
  get rpc(): PiRpcClient {
    return this.client;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offEvents();
    this.listeners.clear();
    void this.client.close();
  }

  async reload(): Promise<void> {
    // pi's own `switch_session`/resume semantics replace the SDK's in-place
    // reload; the wrapper's reload callers go through the session factory.
    throw new PiRpcUnsupportedError("reload()", "M2: switch_session-based reload");
  }

  // --- state (event-maintained) --------------------------------------------

  get sessionId(): string {
    return this.state.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.state.sessionFile;
  }

  /** The name the child has confirmed (see setSessionName). */
  get sessionName(): string | undefined {
    return this.state.sessionName;
  }

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this.state.isCompacting;
  }

  get isIdle(): boolean | undefined {
    return this.state.isIdle;
  }

  get isBashRunning(): boolean {
    return this.bashRunning;
  }

  get autoCompactionEnabled(): boolean {
    return this.state.autoCompactionEnabled;
  }

  get autoRetryEnabled(): boolean | undefined {
    return this.state.autoRetryEnabled;
  }

  get retryAttempt(): number | undefined {
    return this.state.retryAttempt;
  }

  get steeringMode(): string | undefined {
    return this.state.steeringMode;
  }

  get followUpMode(): string | undefined {
    return this.state.followUpMode;
  }

  get model(): ModelLike | undefined {
    return this.state.model as ModelLike | undefined;
  }

  get pendingMessageCount(): number {
    return this.state.pendingMessageCount;
  }

  getSteeringMessages(): string[] {
    return [...this.state.steeringQueue];
  }

  getFollowUpMessages(): string[] {
    return [...this.state.followUpQueue];
  }

  get messageCount(): number {
    return this.state.messageCount;
  }

  get systemPrompt(): string {
    // get_entries carries system entries; the wrapper only reads this for the
    // settings page. Resolved lazily would be better; M2 wires get_entries.
    return "";
  }

  // The SDK surface below is intentionally narrow: members pi-web never
  // touches on the RPC path throw, everything else has a real command.

  // The heavy SDK members are absent on the bare protocol engine; the types
  // stay wide so the host-side core (core.ts) can override them, and a wrong
  // direct use still throws at runtime instead of returning undefined.
  get sessionManager(): unknown {
    throw new PiRpcUnsupportedError("sessionManager", "M2: file-based session access (session-reader)");
  }

  get settingsManager(): unknown {
    throw new PiRpcUnsupportedError("settingsManager", "E2: file-based settings access");
  }

  get modelRuntime(): {
    getModel: (provider: string, modelId: string) => ModelLike | undefined;
    refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  } {
    // The cache is an instance field: a per-access literal gave every read a
    // fresh empty cache, so getModel after refresh still found nothing.
    return {
      getModel: (provider, modelId) =>
        this.modelsCache?.find((model) => model.provider === provider && model.id === modelId),
      refresh: async () => {
        // The wire shape is {models: [...]} (docs/rpc-commands.md); a bare
        // array is accepted as a fallback for older builds.
        const result = await this.client.command<{ models?: Array<ModelLike & Record<string, unknown>> } | Array<ModelLike & Record<string, unknown>>>(
          "get_available_models",
          {},
          60_000,
        );
        const models = Array.isArray(result) ? result : result?.models;
        this.modelsCache = Array.isArray(models) ? models : [];
        return this.modelsCache;
      },
    };
  }

  get extensionRunner(): unknown {
    // pi-subagents detection moves to extension events + get_commands (M3).
    throw new PiRpcUnsupportedError("extensionRunner", "M3: extension events / get_commands");
  }

  get promptTemplates(): unknown {
    throw new PiRpcUnsupportedError("promptTemplates", "M3: get_commands(source=prompt/skill)");
  }

  get resourceLoader(): unknown {
    throw new PiRpcUnsupportedError("resourceLoader", "M3: extension events / get_commands");
  }

  get agent(): {
    state?: {
      thinkingLevel?: string;
      streamingMessage?: PiAgentMessage;
    };
    waitForIdle?: () => Promise<void>;
  } {
    // A fresh object each read: `agent.state` is a live view of the event
    // machine, and the wrapper holds it only within one synchronous read.
    return {
      state: {
        thinkingLevel: this.state.thinkingLevel,
        streamingMessage: this.streamingMessage,
      },
      waitForIdle: () => this.waitForIdle(),
    };
  }

  /** The assistant message currently being streamed, as the event stream last reported it. */
  get currentStreamingMessage(): PiAgentMessage | undefined {
    return this.streamingMessage;
  }

  // --- commands ------------------------------------------------------------

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    source?: "interactive" | "rpc";
    preflightResult?: (disposition: "handled" | "queued" | "started") => void;
  }): Promise<void> {
    // pi's prompt command acknowledges admission only; the run completes in
    // the event stream (agent_settled), exactly like the wrapper expects.
    const data: Record<string, unknown> = { message: text };
    if (options?.images?.length) data.images = options.images;
    if (options?.streamingBehavior) {
      data.streamingBehavior = options.streamingBehavior === "steer" ? "steer" : "followUp";
    }
    // Capture the epoch BEFORE sending: the admission response can share its
    // stdout chunk with agent_start, which the dispatcher processes
    // synchronously before this await resumes — a runEpoch read afterwards
    // would already include the run and wait one epoch too many (a hang).
    const epochAtSend = this.runEpoch;
    const response = await this.client.command<{ disposition?: string }>(
      "prompt",
      data,
      120_000,
    );
    const disposition = response?.disposition === "queued" || response?.disposition === "handled"
      ? response.disposition
      : "started";
    options?.preflightResult?.(disposition);
    // The wrapper models the SDK contract, where the prompt promise resolves
    // only once the run is fully idle: a started submission waits for the
    // NEXT run epoch to settle (the admission response arrives before
    // agent_start), a queued one for the current epoch's settle; "handled"
    // (an extension command) starts no run. waitForSettle re-checks
    // settledEpoch against the captured epoch, so a run that started AND
    // settled inside the response chunk is still detected.
    if (disposition === "started") {
      await this.waitForSettle(epochAtSend + 1);
    } else if (disposition === "queued") {
      await this.waitForSettle(epochAtSend);
    }
  }

  /**
   * Resolves once the run of `minEpoch` (or later) has settled; rejects if
   * the child dies mid-wait. Mirrors the SDK prompt promise that resolves
   * only once the run is fully idle.
   */
  waitForSettle(minEpoch = 0): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Initialized before registration: client.onProcessExit calls a
      // listener registered on an already-exited client synchronously, so
      // finish can run before the const declarations below would initialize.
      let offRecord: () => void = () => {};
      let offExit: () => void = () => {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        offRecord();
        offExit();
        if (error) reject(error);
        else resolve();
      };
      offRecord = this.subscribe((record) => {
        if (record.type === "agent_settled" && this.settledEpoch >= minEpoch) finish();
      });
      offExit = this.client.onProcessExit((code) => {
        finish(new Error(`pi process exited during the run (code ${code ?? "?"})`));
      });
      // A settle for minEpoch may already have been processed (a queued
      // message delivered by a run that ended while our command was in
      // flight, or a whole run that fit inside the response chunk); no new
      // agent_start can precede the admission response.
      if (this.settledEpoch >= minEpoch && !this.state.isStreaming) finish();
    });
  }

  /** Resolves once no run, retry backoff or queued continuation is pending. */
  async waitForIdle(): Promise<void> {
    if (this.state.isIdle !== false && !this.state.isStreaming) return;
    await this.waitForSettle(this.runEpoch);
    // agent_settled covers the run; isIdle also flips there in practice, but
    // re-check once for the post-run pipeline. Bounded by the same epoch
    // guard and the child-exit rejection as waitForSettle, so a busy flag
    // nothing will ever clear cannot hang the caller.
    if (this.state.isIdle === false) {
      const afterEpoch = this.settledEpoch;
      await new Promise<void>((resolve, reject) => {
        let done = false;
        let offRecord: () => void = () => {};
        let offExit: () => void = () => {};
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          offRecord();
          offExit();
          if (error) reject(error);
          else resolve();
        };
        offRecord = this.subscribe((record) => {
          if (record.type === "agent_settled" && this.settledEpoch > afterEpoch) finish();
        });
        offExit = this.client.onProcessExit((code) => {
          finish(new Error(`pi process exited while waiting for idle (code ${code ?? "?"})`));
        });
        if (this.state.isIdle !== false || this.settledEpoch > afterEpoch) finish();
      });
    }
  }

  async steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<"handled" | "queued"> {
    const data: Record<string, unknown> = { message: text };
    if (images?.length) data.images = images;
    const result = await this.client.command<{ disposition?: string }>("steer", data, 120_000);
    return result?.disposition === "handled" ? "handled" : "queued";
  }

  async followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<"handled" | "queued"> {
    const data: Record<string, unknown> = { message: text };
    if (images?.length) data.images = images;
    const result = await this.client.command<{ disposition?: string }>("follow_up", data, 120_000);
    return result?.disposition === "handled" ? "handled" : "queued";
  }

  async abort(): Promise<void> {
    await this.client.command("abort", {}, 30_000);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const snapshot: QueuesSnapshot = {
      steering: [...this.state.steeringQueue],
      followUp: [...this.state.followUpQueue],
    };
    // fire-and-forget; the queue events confirm the clear asynchronously
    void this.client.command("clear_queue", {}, 30_000).catch(() => {});
    return snapshot;
  }

  async setModel(model: ModelLike): Promise<void> {
    // The wire contract is a flat {provider, modelId} (docs/rpc-commands.md
    // set_model), not a nested model object.
    await this.client.command("set_model", { provider: model.provider, modelId: model.id }, 30_000);
    this.state.model = { ...model } as RpcAgentSessionState["model"];
  }

  setThinkingLevel(level: string): void {
    void this.client.command("set_thinking_level", { level }, 30_000).catch(() => {});
    this.state.thinkingLevel = level;
  }

  getAvailableThinkingLevels(): string[] {
    // The command exists; it is async while the interface is sync. The wrapper
    // reads it once per model change, so a cached copy from the async command
    // is filled by refreshState(); until then an empty list is honest.
    return this.thinkingLevelsCache;
  }

  private thinkingLevelsCache: string[] = [];

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    void this.client.command("set_steering_mode", { mode }, 30_000).catch(() => {});
    this.state.steeringMode = mode;
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    void this.client.command("set_follow_up_mode", { mode }, 30_000).catch(() => {});
    this.state.followUpMode = mode;
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.state.isCompacting = true;
    try {
      const result = await this.client.command(
        "compact",
        customInstructions === undefined ? {} : { customInstructions },
        600_000,
      );
      // Manual compaction has no agent_settled event. The caller's immediate
      // get_state must not read the pre-compaction cached percentage.
      this.invalidateContextUsage();
      await this.refreshStats().catch(() => {});
      return result;
    } finally {
      // compaction events maintain this too; the finally is a floor for a
      // response-only race where events were missed.
      this.state.isCompacting = false;
    }
  }

  async abortCompaction(): Promise<void> {
    await this.client.command("abort", {}, 30_000);
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    void this.client.command("set_auto_compaction", { enabled }, 30_000).catch(() => {});
    this.state.autoCompactionEnabled = enabled;
  }

  setAutoRetryEnabled(enabled: boolean): void {
    void this.client.command("set_auto_retry", { enabled }, 30_000).catch(() => {});
    this.state.autoRetryEnabled = enabled;
  }

  abortRetry(): void {
    void this.client.command("abort_retry", {}, 30_000).catch(() => {});
    this.state.retryAttempt = 0;
  }

  async executeBash(command: string, onChunk?: (chunk: string) => void, options?: {
    excludeFromContext?: boolean;
  }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }> {
    // Chunks stream as bash_execution_update events carrying our command id;
    // subscribe-once here would race with concurrent calls, so a dedicated
    // listener is attached for the duration of this call.
    const bashId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const off = this.client.onEvent((record) => {
      if (record.type === "bash_execution_update" && record.id === bashId && typeof record.delta === "string") {
        onChunk?.(record.delta);
      }
    });
    this.bashRunning = true;
    try {
      const data: Record<string, unknown> = { command, id: bashId };
      if (options?.excludeFromContext !== undefined) data.excludeFromContext = options.excludeFromContext;
      return await this.client.command<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>("bash", data, 600_000);
    } finally {
      this.bashRunning = false;
      off();
    }
  }

  async abortBash(): Promise<void> {
    await this.client.command("abort_bash", {}, 30_000);
  }

  /**
   * Rename the session in the child and keep the name only after its response:
   * the state field is the host's view of the child's session file, so setting
   * it first would report a rename the child never performed (and a caller
   * that refreshed the list would read the old name back). A failing command
   * rejects to the caller instead of swallowing the error.
   */
  async setSessionName(name: string): Promise<void> {
    await this.client.command("set_session_name", { name }, 30_000);
    this.state.sessionName = name;
  }

  getSessionStats(): Omit<SessionStatsInfo, "sessionName"> {
    // Sync interface, async command: cached by the event loop's settled hook.
    return this.statsCache;
  }

  private statsCache: Omit<SessionStatsInfo, "sessionName"> = {
    sessionId: "",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.statsCache.contextUsage;
  }

  async navigateTree(_targetId: string, _options?: NavigateTreeOptions): Promise<NavigateTreeResult> {
    // get_tree + get_entries cover read-only navigation; the summarize branch
    // and the in-place edit it returns are the gap (see the inventory).
    throw new PiRpcUnsupportedError("navigateTree()", "M2/M3: get_tree + get_entries; summarize needs upstream");
  }

  // --- CLI-authoritative active snapshot (get_entries + get_tree) ---------

  /**
   * One consistent active-session snapshot straight from the child:
   * `entries` (append order) and `leafId` come from ONE `get_entries`
   * response, and `tree` from `get_tree` (labels, orphan roots and child
   * ordering are computed by the CLI itself, never re-derived here).
   *
   * Why this exists: `navigateTree` moves the leaf IN MEMORY
   * (`sessionManager.branch()`); the file's bytes are unchanged, so any
   * disk re-open computes leafId = the file's last entry (the abandoned
   * branch's tail). The desktop must not re-implement that pointer — the
   * child's own answer is the only authoritative active branch.
   *
   * The two responses are separate commands, so a navigation or append
   * between them can make `tree` slightly newer than `entries`; that is
   * harmless (the tree always contains every entry, its shape only changes
   * on append). `leafId` is taken from the entries response so the leaf and
   * the entries the caller slices it from can never disagree.
   *
   * A failure is THROWN and never answered from disk: a live session's
   * active branch read must fail explicitly rather than show the file tail
   * as if it were live.
   */
  async getActiveSnapshot(options: { timeoutMs?: number } = {}): Promise<{
    entries: unknown[];
    tree: unknown[];
    leafId: string | null;
  }> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const [entriesResult, treeResult] = await Promise.all([
      this.getActiveEntries({ timeoutMs }),
      this.client.command<{ tree?: unknown; leafId?: unknown }>("get_tree", {}, timeoutMs),
    ]);
    if (!Array.isArray(treeResult?.tree)) {
      throw new Error("pi RPC 'get_tree' did not return a tree array");
    }
    return { ...entriesResult, tree: treeResult.tree };
  }

  /** Lightweight active projection input; polling need not transfer the tree twice. */
  async getActiveEntries(options: { timeoutMs?: number } = {}): Promise<{ entries: unknown[]; leafId: string | null }> {
    const entriesResult = await this.client.command<{ entries?: unknown; leafId?: unknown }>("get_entries", {}, options.timeoutMs ?? 60_000);
    if (!Array.isArray(entriesResult?.entries)) {
      throw new Error("pi RPC 'get_entries' did not return an entries array");
    }
    const leafId = entriesResult.leafId;
    if (leafId !== null && typeof leafId !== "string") {
      throw new Error("pi RPC 'get_entries' did not return a leafId string or null");
    }
    if (leafId !== null && !entriesResult.entries.some(entry => entry && typeof entry === "object" && entry.id === leafId)) {
      throw new Error("pi RPC 'get_entries' returned a leaf missing from its entries");
    }
    return { entries: entriesResult.entries, leafId };
  }

  getAllTools(): ToolInfo[] {
    return this.toolsCache;
  }

  getActiveToolNames(): string[] {
    return this.toolsCache
      .filter((tool: ToolInfo) => tool.exposure !== "hidden")
      .map((tool: ToolInfo) => tool.name);
  }

  setActiveToolsByName(_names: string[]): void {
    // The single biggest gap: pi's RPC has no active-set command yet.
    throw new PiRpcUnsupportedError("setActiveToolsByName()", "upstream PR set_active_tools");
  }

  async sendCustomMessage(): Promise<void> {
    throw new PiRpcUnsupportedError("sendCustomMessage()", "upstream PR send_custom_message");
  }

  get routedModel(): { model: ModelLike; thinkingLevel?: string } | undefined {
    return this.state.model
      ? { model: this.state.model, thinkingLevel: this.state.thinkingLevel }
      : undefined;
  }

  // --- state maintenance ---------------------------------------------------

  /** Pull `get_state` (and caches) once; the factory calls it after spawn. */
  async refreshState(): Promise<void> {
    const state = await this.client.command<Partial<RpcAgentSessionState>>("get_state", {}, 30_000);
    this.applyState(state);
    void this.client.command<{ levels?: string[] }>("get_available_thinking_levels", {}, 30_000)
      .then((result) => {
        this.thinkingLevelsCache = Array.isArray(result?.levels) ? result.levels : [];
      })
      .catch(() => {});
    void this.refreshStats().catch(() => {});
    // A resumed session shows its last assistant message before any new run;
    // awaited so the wrapper's first get_last_assistant_text cannot race it.
    try {
      const result = await this.client.command<{ text?: string }>("get_last_assistant_text", {}, 30_000);
      if (!this.lastAssistantText && typeof result?.text === "string") {
        this.lastAssistantText = result.text;
      }
    } catch {
      // A fresh session has none; the child may answer empty.
    }
  }

  /**
   * Refresh the stats cache. `epochAtRequest` (the runEpoch when the command
   * was sent) drops a reply that crossed a new agent_start: the next settle
   * re-refreshes, and an out-of-date cache is harmless but a wrong-isIdle flip
   * is not (see the agent_settled hook).
   */
  private statsRequestId = 0;

  private invalidateContextUsage(): void {
    // Invalidate in-flight snapshots too: a reply requested before compaction
    // must not restore old usage after it. Unknown is not zero.
    this.statsRequestId += 1;
    this.statsCache = { ...this.statsCache, contextUsage: undefined };
    this.onRecord({ type: "context_usage", contextUsage: null });
  }

  async refreshStats(epochAtRequest = this.runEpoch): Promise<void> {
    const requestId = ++this.statsRequestId;
    const stats = await this.client.command<Partial<Omit<SessionStatsInfo, "sessionName">>>("get_session_stats", {}, 30_000);
    if (this.disposed || requestId !== this.statsRequestId || this.runEpoch !== epochAtRequest) return;
    this.statsCache = {
      ...this.statsCache,
      ...stats,
      sessionId: this.state.sessionId,
      tokens: stats.tokens ?? this.statsCache.tokens,
      // Omission means the child cannot calculate usage (e.g. no limits model),
      // not permission to retain the last model's percentage.
      contextUsage: stats.contextUsage,
    } as Omit<SessionStatsInfo, "sessionName">;
    this.onRecord({ type: "context_usage", contextUsage: stats.contextUsage ?? null });
  }

  private applyState(patch: Partial<RpcAgentSessionState>, options?: { volatile?: boolean }): void {
    let source: Partial<RpcAgentSessionState> = patch;
    if (options?.volatile === false) {
      // A stale get_state snapshot (a new run started while the reply was in
      // flight) must not flip live-run flags back to idle — dropping isIdle
      // there once evicted a running session's wrapper mid-run. Stable fields
      // (model, sessionName, switches) still apply.
      const stable: Partial<RpcAgentSessionState> = {};
      const patchEntries = Object.entries(patch) as Array<[keyof RpcAgentSessionState, unknown]>;
      for (const [key, value] of patchEntries) {
        if (!VOLATILE_STATE_KEYS.includes(key)) {
          (stable as Record<string, unknown>)[key] = value;
        }
      }
      source = stable;
    }
    if (typeof source.sessionId === "string") this.state.sessionId = source.sessionId;
    if (source.sessionFile !== undefined) this.state.sessionFile = source.sessionFile;
    if (source.sessionName !== undefined) this.state.sessionName = source.sessionName;
    if (typeof source.isStreaming === "boolean") this.state.isStreaming = source.isStreaming;
    if (typeof source.isCompacting === "boolean") this.state.isCompacting = source.isCompacting;
    if (source.isIdle !== undefined) this.state.isIdle = source.isIdle;
    if (typeof source.autoCompactionEnabled === "boolean") this.state.autoCompactionEnabled = source.autoCompactionEnabled;
    if (typeof source.autoRetryEnabled === "boolean") this.state.autoRetryEnabled = source.autoRetryEnabled;
    if (typeof source.retryAttempt === "number") this.state.retryAttempt = source.retryAttempt;
    if (source.steeringMode !== undefined) this.state.steeringMode = source.steeringMode;
    if (source.followUpMode !== undefined) this.state.followUpMode = source.followUpMode;
    if (source.model !== undefined) this.state.model = source.model;
    if (source.thinkingLevel !== undefined) this.state.thinkingLevel = source.thinkingLevel;
    if (typeof source.messageCount === "number") this.state.messageCount = source.messageCount;
    if (typeof source.pendingMessageCount === "number") this.state.pendingMessageCount = source.pendingMessageCount;
  }

  /**
   * Fold one delta-only wire `message_update` into the streaming message
   * (docs/json.md "Reconstruct streaming messages"): text/thinking deltas
   * append, *_end blocks replace with the authoritative content, toolcall_end
   * replaces with the complete ToolCall; message_end replaces the message.
   */
  private applyStreamingDelta(record: PiRpcRecord): void {
    const current = this.streamingMessage as ({ content?: unknown } & Record<string, unknown>) | undefined;
    const event = record.assistantMessageEvent as {
      type?: string;
      contentIndex?: number;
      delta?: string;
      content?: string;
      id?: string;
      toolName?: string;
      toolCall?: Record<string, unknown>;
    } | undefined;
    if (!current || !event || typeof event.type !== "string") return;
    const blocks = (Array.isArray(current.content) ? current.content : []) as Array<Record<string, unknown>>;
    // contentIndex addresses a block; gaps cannot appear in a real stream, so
    // clamp to keep the array dense rather than leave holes a renderer trips on.
    const index = typeof event.contentIndex === "number" && event.contentIndex >= 0 && event.contentIndex <= blocks.length
      ? event.contentIndex
      : blocks.length;
    switch (event.type) {
      case "text_start":
        blocks[index] = { type: "text", text: "" };
        break;
      case "text_delta": {
        const block = blocks[index]?.type === "text" ? blocks[index] : { type: "text", text: "" };
        blocks[index] = { ...block, type: "text", text: `${block.text ?? ""}${event.delta ?? ""}` };
        break;
      }
      case "text_end":
        blocks[index] = { type: "text", text: typeof event.content === "string" ? event.content : "" };
        break;
      case "thinking_start":
        blocks[index] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta": {
        const block = blocks[index]?.type === "thinking" ? blocks[index] : { type: "thinking", thinking: "" };
        blocks[index] = { ...block, type: "thinking", thinking: `${block.thinking ?? ""}${event.delta ?? ""}` };
        break;
      }
      case "thinking_end":
        blocks[index] = { type: "thinking", thinking: typeof event.content === "string" ? event.content : "" };
        break;
      case "toolcall_start":
        blocks[index] = { type: "toolCall", id: event.id ?? "", name: event.toolName ?? "", arguments: {} };
        break;
      case "toolcall_delta": {
        // Serialized argument fragments; toolcall_end carries the parsed call,
        // so the raw accumulation is kept only for partial display.
        const block = blocks[index]?.type === "toolCall" ? blocks[index] : { type: "toolCall", id: "", name: "", arguments: {} };
        blocks[index] = {
          ...block,
          type: "toolCall",
          partialArguments: `${block.partialArguments ?? ""}${event.delta ?? ""}`,
        };
        break;
      }
      case "toolcall_end":
        if (event.toolCall && typeof event.toolCall === "object") blocks[index] = { ...event.toolCall };
        break;
      case "start":
      case "done":
      case "error":
        // Provider stream lifecycle; the agent loop reports these through
        // message_start/message_end instead (docs/json.md).
        break;
      default:
        break;
    }
    current.content = blocks;
    // The wire update carries the latest cumulative usage for the response.
    if (record.usage !== undefined) current.usage = record.usage;
  }

  private async onRecord(record: PiRpcRecord): Promise<void> {
    switch (record.type) {
      case "agent_start":
        this.state.isStreaming = true;
        this.state.isIdle = false;
        this.runEpoch += 1;
        break;
      case "agent_settled": {
        this.state.isStreaming = false;
        this.state.isIdle = true;
        this.state.retryAttempt = 0;
        this.streamingMessage = undefined;
        this.settledEpoch = this.runEpoch;
        // Reconcile counters and stats once the run is over; cheap and
        // authoritative after any amount of missed event bookkeeping. The
        // epoch is captured at request time: if a new run started while the
        // response was in flight, a stale snapshot must not flip the live
        // run back to idle — the next settle refreshes those fields instead.
        const epochAtSettle = this.runEpoch;
        void this.client.command<Partial<RpcAgentSessionState>>("get_state", {}, 30_000)
          .then((state) => this.applyState(state, { volatile: this.runEpoch === epochAtSettle }))
          .catch(() => {});
        void this.refreshStats(epochAtSettle).catch(() => {});
        void this.client.command<{ text?: string }>("get_last_assistant_text", {}, 30_000)
          .then((result) => {
            // A stale reply would overwrite a newer run's text with an older one.
            if (this.runEpoch !== epochAtSettle) return;
            this.lastAssistantText = typeof result?.text === "string" ? result.text : undefined;
          })
          .catch(() => {});
        break;
      }
      case "message_start": {
        const message = (record as { message?: { role?: string; content?: unknown } }).message;
        if (message?.role === "assistant") {
          // The skeleton message_update accumulates into: the wire's updates
          // are delta-only, so own a mutable copy of the start snapshot
          // (content blocks copied; scalars replaced whole).
          const content = Array.isArray(message.content)
            ? message.content.map((block) => ({ ...(block as object) }))
            : [];
          this.streamingMessage = { ...message, content } as unknown as PiAgentMessage;
        }
        break;
      }
      case "message_update": {
        const message = (record as { message?: { role?: string } }).message;
        if (message?.role === "assistant") {
          // In-process SDK snapshots carry the cumulative message; the wire
          // omits it (docs/json.md "Reconstruct streaming messages").
          this.streamingMessage = record.message as PiAgentMessage;
        } else {
          this.applyStreamingDelta(record);
        }
        break;
      }
      case "message_end":
        if ((record.message as { role?: string } | undefined)?.role === "assistant") {
          this.streamingMessage = record.message as PiAgentMessage;
          const content = (record.message as { content?: unknown }).content;
          this.state.messageCount += 1;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text").map((block) => block.text).join("")
              : "";
          if (text) this.lastAssistantText = text;
        } else if ((record.message as { role?: string } | undefined)?.role === "user") {
          this.state.messageCount += 1;
        }
        break;
      case "compaction_start":
        this.state.isCompacting = true;
        break;
      case "compaction_end":
        this.state.isCompacting = false;
        this.invalidateContextUsage();
        void this.refreshStats().catch(() => {});
        break;
      case "queue_update":
      case "steering_queued":
      case "follow_up_queued": {
        const queue = record as { steering?: string[]; followUp?: string[] };
        if (Array.isArray(queue.steering)) this.state.steeringQueue = queue.steering;
        if (Array.isArray(queue.followUp)) this.state.followUpQueue = queue.followUp;
        break;
      }
      case "auto_retry_start":
        // The wire names are auto_retry_start/auto_retry_end with an attempt
        // field (docs/json.md); "retry_started" never exists on the wire. A
        // retry that starts is the child proving its policy is on.
        this.state.autoRetryEnabled = true;
        this.state.retryAttempt = typeof record.attempt === "number" ? record.attempt : this.state.retryAttempt + 1;
        break;
      case "auto_retry_end":
        // agent_settled performs the final reset; a failed last attempt keeps
        // the counter for the UI until the run settles or abortRetry clears it.
        if (record.success === true) this.state.retryAttempt = 0;
        break;
      default:
        break;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // A listener failing must not break the state machine or others.
      }
    }
  }
}
