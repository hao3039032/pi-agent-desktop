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

import type { ContextUsage, ModelLike, NavigateTreeOptions, NavigateTreeResult, SessionStatsInfo, ToolInfo } from "../pi-types";
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
  autoRetryEnabled: boolean;
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

export interface RpcAgentSessionOptions {
  client: PiRpcClient;
  /** Resolved by the factory from `get_state` when the child is ready. */
  initialState: RpcAgentSessionState;
  /** Diagnostic sink for protocol-level notes (defaults to console). */
  onLog?: (line: string) => void;
}

export class RpcAgentSession {
  private listeners = new Set<SessionEventListener>();
  private disposed = false;
  private state: RpcAgentSessionState;
  private readonly client: PiRpcClient;
  private readonly offEvents: () => void;
  private toolsCache: ToolInfo[] = [];

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

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this.state.isCompacting;
  }

  get isIdle(): boolean | undefined {
    return this.state.isIdle;
  }

  get autoCompactionEnabled(): boolean {
    return this.state.autoCompactionEnabled;
  }

  get autoRetryEnabled(): boolean {
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

  get sessionManager(): never {
    throw new PiRpcUnsupportedError("sessionManager", "M2: file-based session access (session-reader)");
  }

  get settingsManager(): never {
    throw new PiRpcUnsupportedError("settingsManager", "E2: file-based settings access");
  }

  get modelRuntime(): {
    getModel: (provider: string, modelId: string) => ModelLike | undefined;
    refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  } {
    // Model enumeration comes from get_available_models; the cache lives here.
    const cache: { models?: Array<ModelLike & Record<string, unknown>> } = {};
    return {
      getModel: (provider, modelId) =>
        cache.models?.find((model) => model.provider === provider && model.id === modelId),
      refresh: async () => {
        const models = await this.client.command<Array<ModelLike & Record<string, unknown>>>("get_available_models", {}, 60_000);
        cache.models = Array.isArray(models) ? models : [];
        return cache.models;
      },
    };
  }

  get extensionRunner(): never {
    // pi-subagents detection moves to extension events + get_commands (M3).
    throw new PiRpcUnsupportedError("extensionRunner", "M3: extension events / get_commands");
  }

  get promptTemplates(): never {
    throw new PiRpcUnsupportedError("promptTemplates", "M3: get_commands(source=prompt/skill)");
  }

  get resourceLoader(): never {
    throw new PiRpcUnsupportedError("resourceLoader", "M3: extension events / get_commands");
  }

  get agent(): {
    state?: {
      thinkingLevel?: string;
    };
  } {
    const thinkingLevel = () => this.state.thinkingLevel;
    return { state: { get thinkingLevel() { return thinkingLevel(); } } };
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
    const response = await this.client.command<{ disposition?: string }>(
      "prompt",
      data,
      120_000,
    );
    const disposition = response?.disposition === "queued" || response?.disposition === "handled"
      ? response.disposition
      : "started";
    options?.preflightResult?.(disposition);
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
    await this.client.command("set_model", { model }, 30_000);
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
      return await this.client.command(
        "compact",
        customInstructions === undefined ? {} : { customInstructions },
        600_000,
      );
    } finally {
      // compaction events maintain this too; the finally is a floor for a
      // response-only race where events were missed.
      this.state.isCompacting = false;
    }
  }

  abortCompaction(): void {
    void this.client.command("abort", { reason: "compaction" }, 30_000).catch(() => {});
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
    try {
      const data: Record<string, unknown> = { command, id: bashId };
      if (options?.excludeFromContext !== undefined) data.excludeFromContext = options.excludeFromContext;
      return await this.client.command<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>("bash", data, 600_000);
    } finally {
      off();
    }
  }

  abortBash(): void {
    void this.client.command("abort_bash", {}, 30_000).catch(() => {});
  }

  get isBashRunning(): boolean {
    return this.bashRunning;
  }

  private bashRunning = false;

  setSessionName(name: string): void {
    void this.client.command("set_session_name", { name }, 30_000).catch(() => {});
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

  private lastAssistantText: string | undefined;

  getContextUsage(): ContextUsage | undefined {
    return this.statsCache.contextUsage;
  }

  async navigateTree(_targetId: string, _options?: NavigateTreeOptions): Promise<NavigateTreeResult> {
    // get_tree + get_entries cover read-only navigation; the summarize branch
    // and the in-place edit it returns are the gap (see the inventory).
    throw new PiRpcUnsupportedError("navigateTree()", "M2/M3: get_tree + get_entries; summarize needs upstream");
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
    void this.client.command<{ tools?: ToolInfo[] }>("get_commands", {}, 30_000)
      .then(() => {})
      .catch(() => {});
    void this.refreshStats().catch(() => {});
  }

  async refreshStats(): Promise<void> {
    const stats = await this.client.command<Partial<Omit<SessionStatsInfo, "sessionName">>>("get_session_stats", {}, 30_000);
    this.statsCache = {
      ...this.statsCache,
      ...stats,
      sessionId: this.state.sessionId,
      tokens: stats.tokens ?? this.statsCache.tokens,
    } as Omit<SessionStatsInfo, "sessionName">;
  }

  private applyState(patch: Partial<RpcAgentSessionState>): void {
    if (typeof patch.sessionId === "string") this.state.sessionId = patch.sessionId;
    if (patch.sessionFile !== undefined) this.state.sessionFile = patch.sessionFile;
    if (patch.sessionName !== undefined) this.state.sessionName = patch.sessionName;
    if (typeof patch.isStreaming === "boolean") this.state.isStreaming = patch.isStreaming;
    if (typeof patch.isCompacting === "boolean") this.state.isCompacting = patch.isCompacting;
    if (patch.isIdle !== undefined) this.state.isIdle = patch.isIdle;
    if (typeof patch.autoCompactionEnabled === "boolean") this.state.autoCompactionEnabled = patch.autoCompactionEnabled;
    if (typeof patch.autoRetryEnabled === "boolean") this.state.autoRetryEnabled = patch.autoRetryEnabled;
    if (typeof patch.retryAttempt === "number") this.state.retryAttempt = patch.retryAttempt;
    if (patch.steeringMode !== undefined) this.state.steeringMode = patch.steeringMode;
    if (patch.followUpMode !== undefined) this.state.followUpMode = patch.followUpMode;
    if (patch.model !== undefined) this.state.model = patch.model;
    if (patch.thinkingLevel !== undefined) this.state.thinkingLevel = patch.thinkingLevel;
    if (typeof patch.messageCount === "number") this.state.messageCount = patch.messageCount;
    if (typeof patch.pendingMessageCount === "number") this.state.pendingMessageCount = patch.pendingMessageCount;
  }

  private async onRecord(record: PiRpcRecord): Promise<void> {
    switch (record.type) {
      case "agent_start":
        this.state.isStreaming = true;
        this.state.isIdle = false;
        break;
      case "agent_settled":
        this.state.isStreaming = false;
        this.state.isIdle = true;
        this.state.retryAttempt = 0;
        // Reconcile counters and stats once the run is over; cheap and
        // authoritative after any amount of missed event bookkeeping.
        void this.client.command<Partial<RpcAgentSessionState>>("get_state", {}, 30_000)
          .then((state) => this.applyState(state))
          .catch(() => {});
        void this.refreshStats().catch(() => {});
        void this.client.command<{ text?: string }>("get_last_assistant_text", {}, 30_000)
          .then((result) => {
            this.lastAssistantText = typeof result?.text === "string" ? result.text : undefined;
          })
          .catch(() => {});
        break;
      case "message_end":
        if ((record.message as { role?: string } | undefined)?.role === "assistant") {
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
        break;
      case "queue_update":
      case "steering_queued":
      case "follow_up_queued": {
        const queue = record as { steering?: string[]; followUp?: string[] };
        if (Array.isArray(queue.steering)) this.state.steeringQueue = queue.steering;
        if (Array.isArray(queue.followUp)) this.state.followUpQueue = queue.followUp;
        break;
      }
      case "retry_started":
        this.state.retryAttempt = typeof record.attempt === "number" ? record.attempt : this.state.retryAttempt + 1;
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
