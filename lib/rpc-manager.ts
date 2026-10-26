import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionServices, getAgentDir, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { resolvePiExecutable, startCliRpcSessionFromManager } from "./pi-rpc/factory";
import { extractActiveSystemPrompt } from "./system-prompt-snapshot";
import { withSessionWriterLock } from "./session-writer-lock";
import { createProjectCommandBashOperations } from "./project-command-env";
import { invalidateModelsCache } from "./models-cache";
import { cacheSessionPath, getSessionListVersion, invalidateSessionListCache, readLatestSessionEntryId } from "./session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { notifySessionComplete } from "./web-push";
import { hasActiveSessionLivenessProvider } from "./session-liveness";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { PRODUCT_NAME } from "./branding";
import type { AgentSessionLike, ExtensionUiContextLike, NavigateTreeOptions, ToolInfo } from "./pi-types";
import type {
  CacheWarmingInfo,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  RoutedModelInfo,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { getUsageCostBreakdown } from "./usage-breakdown";
import {
  createSessionReplacementActions,
  UNSAVED_SESSION_FORK_ERROR,
  writeForkedSession,
  type ExtensionCommandContextActionsLike,
} from "./session-replacement";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_CONTROL_TOOL_NAMES } from "./subagents";
import type { SubagentEventBus, SubagentRpcTransport } from "./pi-subagents-rpc";
import { createBridgeSubagentTransport, createEventBusSubagentTransport } from "./pi-subagents-rpc";
import { loadResultHasPiSubagentsExtension } from "./subagent-extension";
import { resolveShellTools } from "./powershell-settings";
import { contextFilesSystemPrompt } from "./chat-only";
import type { McpHost } from "./mcp-host";
import { mcpPromptPreparation, type McpCommandCandidate } from "./mcp-command";
import { isNestedToolExecutionEvent } from "./agent-event-wire";
import {
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";
import {
  createChatFolder,
  ensureChatCwd,
  isChatFolderPath,
  isChatRootPath,
  isChatWorkspacePath,
} from "./chat-workspace";
import { appendChatUnlock, readChatUnlocked } from "./chat-unlock";
import type { ScheduledRunMarkerData } from "./scheduled-run-marker";
import { saveAttachedFilesToFolder } from "./chat-attachment-files";
import { deriveSessionPolicy, type SessionPolicy } from "./session-policy";
import { readChatSettings } from "./chat-settings";
import { isNetworkExposedServer } from "./chat-file-access";
import {
  CHAT_FOLDER_TOOL_NAMES,
  CHAT_READ_TOOL_NAME,
  chatBlockedToolNames,
  chatWorkspacePrompt,
  isChatToolAllowed,
} from "./chat-workspace-policy";
import { ComposerQueue } from "./composer-queue";
import type { PendingComposerMessage } from "./composer-queue-types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type AgentRunCompleteListener = (sessionId: string) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};


type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
  /** A non-project chat. Chats reject tool commands, and shell commands unless unlocked. */
  chatWorkspace?: boolean;
  /** The chat owns a folder: its file tools work inside it (a legacy chat has none). */
  chatFolder?: boolean;
  /** The user let this chat use their computer. */
  chatUnlocked?: boolean;
  /**
   * The pi CLI engine has no in-memory tool switch (pi 1.4.0): selection is
   * spawn-time, changes respawn the child, and pi restores a branch's
   * loadout from its transcript on navigate/reload. With this flag the
   * wrapper skips the live re-pin instead of failing the flow.
   */
  noLiveToolSwitch?: boolean;
  onAgentRunComplete?: AgentRunCompleteListener;
  /** CLI-only, targets exactly this wrapper's child, never a replacement. */
  terminateProcess?: () => Promise<void>;
  suppressCompletionNotifications?: boolean;
  /** Connects the session's MCP servers before a prompt starts a run, and lets go of them when it closes (lib/mcp-host.ts). */
  mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  /**
   * The session's extension event bus, created and kept by `startRpcSession()`
   * so the restricted subagents API can speak the pi-subagents package's
   * public event-bus RPC (lib/pi-subagents-rpc.ts). Only normal project
   * sessions get one; chats and subagent children never do.
   */
  subagentsEventBus?: SubagentEventBus;
};

export const MCP_WAIT_STOPPED_MESSAGE = "Stopped while MCP servers were connecting; the message was not sent.";

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "compaction_end",
  // Retry backoffs can wait minutes between events; each schedule/attempt
  // resets the idle timer so a mid-retry wrapper is never disposed.
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Resolves the PI_WEB_SHUTDOWN_DEADLINE_MS environment variable into the time
 * extensions get to handle `session_shutdown` before the wrapper disposes the
 * SDK session anyway. An unset/blank value returns the 5-second default, and
 * positive values up to Node's timer limit (2147483647 ms) are used as-is.
 * `0`, invalid and out-of-range values fall back to the default with a console
 * warning: shutdown always has a deadline.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

const SESSION_REPLACEMENT_COMMAND_TYPES = new Set(["fork", "clone"]);
const COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT = new Set([
  "get_state",
  "get_session_stats",
  "get_last_assistant_text",
  "get_tools",
  "get_commands",
  "extension_ui_response",
  "extension_ui_input",
]);

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  allowInitialModelFallback?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Header `parentSession` of a brand-new session (ignored when opening a file). */
  parentSession?: string;
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
/** The names a chat may keep active (lib/chat-workspace-policy.ts decides which tools those are). */
function restrictToChatTools(session: AgentSessionLike, names: readonly string[], hasFolder: boolean): string[] {
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const extra = new Set(readChatSettings().allowedTools);
  return names.filter((name) => isChatToolAllowed(registered.get(name) ?? { name }, extra, hasFolder));
}

// A tool that hands work to another agent. A chat loads no extension that registers one.
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

// Tools that belong to the session, not to a branch of it: the ones that reach other tools,
// and pi-web's subagent tools, which the built-in subagent setting switches on for the whole
// session. Navigation keeps them although the target branch was recorded without them.
const SESSION_TOOL_NAMES = new Set<string>(["codemode", "tool_search", ...SUBAGENT_CONTROL_TOOL_NAMES]);

/**
 * The active tools for a coding tool selection. The selection replaces only the coding
 * tools: every other tool named in `carry` that is still registered and not withdrawn stays
 * active, so a tool an extension, `tool_search`, or `defaultTools` activated survives, and a
 * tool one switched off stays off. Nothing else is added: pi itself activates the extension
 * tools it registers (all of them when it builds or reloads a session, then each new one), so
 * `carry` already holds them. An empty selection is Chat only.
 */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    const tool = registered.get(name);
    return tool !== undefined && !codingToolNames.has(name) && tool.exposure !== "hidden";
  });

  return [...new Set([...selectedToolNames, ...carriedToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  // A Set, not an array: an SSE stream unsubscribes from inside emit() when it
  // closes on session_shutdown, and splicing an array mid-iteration made the
  // next stream miss that same event.
  private listeners = new Set<EventListener>();
  private activeToolEvents = new Map<string, AgentEvent>();
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionUiAbortController = new AbortController();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  private pendingPromptPreview: { text: string; timestamp: number } | null = null;
  private activeMutatingCommands = 0;
  private sessionReplacement: "fork" | "clone" | null = null;
  private agentRunNeedsCompletion = false;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private readonly exactSystemPrompt?: () => string;
  /** What this session may reach; computed once at start (lib/session-policy.ts). */
  private readonly policy: SessionPolicy;
  private readonly chatFolder: boolean;
  private readonly noLiveToolSwitch: boolean;
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private readonly suppressCompletionNotifications: boolean;
  private readonly mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  private readonly subagentsEventBus?: SubagentEventBus;
  private mcpHostDisposed = false;
  // The MCP wait of the prompt being admitted; Stop ends it.
  private mcpPromptWait: { controller: AbortController; done: Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  // The armed idle timer is the forced cleanup Stop scheduled.
  private forcedIdleTimerArmed = false;
  private _alive = true;
  private resolveDisposed: () => void = () => {};
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  // Set when shutdown() starts. The SDK session stays usable until destroy(),
  // but lookups must treat the wrapper as gone from this point on.
  private closing = false;
  private readonly composerQueue: ComposerQueue;
  // Aborted when shutdown() or destroy() starts: in-flight subagent RPC on the
  // wrapper's extension bus must not outlive the session it belongs to
  // (lib/pi-subagents-rpc.ts takes it as its AbortSignal).
  private readonly lifecycleAbort = new AbortController();
  readonly instanceId = randomUUID();
  private stopRequested = false;
  private readonly terminateProcess?: () => Promise<void>;

  constructor(
    public readonly inner: AgentSessionLike,
    options: AgentSessionWrapperOptions = {},
  ) {
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.policy = deriveSessionPolicy({
      chatOnly: options.chatOnly,
      chatWorkspace: options.chatWorkspace,
      chatUnlocked: options.chatUnlocked,
    });
    this.chatFolder = options.chatFolder === true;
    this.noLiveToolSwitch = options.noLiveToolSwitch === true;
    this.onAgentRunComplete = options.onAgentRunComplete;
    this.terminateProcess = options.terminateProcess;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.mcpHost = options.mcpHost;
    this.composerQueue = new ComposerQueue(inner.sessionId, {
      canDeliver: () => this.isAlive() && !this.isRunning(),
      deliver: (item, steer) => this.send({
        type: "prompt", message: item.message, images: item.images,
        streamingBehavior: steer ? "steer" : "followUp",
      }),
      changed: (items, pendingVersion) => this.emit({ type: "composer_queue_update", items, pendingVersion }),
      failed: error => this.emit({
        type: "prompt_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    });
    this.subagentsEventBus = options.subagentsEventBus;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  /**
   * False from the moment shutdown() or destroy() begins, not only once the SDK
   * session is disposed: extensions may take up to the shutdown deadline to
   * handle session_shutdown, and a prompt routed here meanwhile would be lost.
   */
  isAlive(): boolean {
    return this._alive && !this.closing;
  }

  isRunning(): boolean {
    // `isIdle` (pi ≥ 0.86) spans the whole post-run pipeline — auto-retry
    // backoff, branch summaries, queued continuations — which the four flags
    // below cannot see (an agent_end with willRetry=false on the flags looks
    // idle until the next agent_start). Older SDKs fall back to the flags.
    const sdkIdle = this.inner.isIdle;
    return this._alive && (
      this.pendingPromptCount > 0
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
      || sdkIdle === false
    );
  }

  /**
   * Drop this idle wrapper when the on-disk JSONL has an entry the in-memory
   * index never saw (another pi process appended). Rechecks isRunning() so a
   * prompt that started during the probe cannot be disposed.
   */
  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning()) return false;
    const diskLatestId = readLatestSessionEntryId(this.sessionFile);
    if (!diskLatestId || this.inner.sessionManager.getEntry(diskLatestId)) return false;
    if (this.isRunning()) return false;
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  getPendingPromptPreview() {
    return this.pendingPromptPreview;
  }

  /** A project session pinned to an empty tool list (exact prompt, nothing loaded). */
  private get chatOnly(): boolean {
    return this.policy.kind === "chat-only";
  }

  /** A non-project chat that is still limited (no shell; files only in its own folder, if it has one). */
  private get chatWorkspace(): boolean {
    return this.policy.kind === "chat";
  }

  /** A chat the user let use their computer. */
  private get chatUnlocked(): boolean {
    return this.policy.kind === "chat-unlocked";
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  /** Limited chat: no shell, and file tools only in its own folder. */
  isChatWorkspace(): boolean {
    return this.chatWorkspace;
  }

  /** Any chat, limited or unlocked; a chat's tool preset is not the user's to change. */
  isChat(): boolean {
    return this.chatWorkspace || this.chatUnlocked;
  }

  isChatUnlocked(): boolean {
    return this.chatUnlocked;
  }

  /** False on the pi CLI engine: tool changes need a session restart. */
  canLiveSwitchTools(): boolean {
    return !this.noLiveToolSwitch;
  }

  /**
   * This session's extension event bus, when the wrapper was given one — the
   * transport the pi-subagents extension's `subagents:rpc:v1` bridge listens
   * on. Absent for chats, subagent children and wrappers started before the
   * bridge existed; callers treat that as "not available".
   */
  getSubagentsEventBus(): SubagentEventBus | undefined {
    return this.subagentsEventBus;
  }

  /**
   * The restricted pi-subagents RPC transport for this session. On the CLI
   * engine the package's listener lives in the pi child, so the call goes
   * through that child's bridge; the in-process bus is the fallback for an
   * engine that owns the bus here. Absent when neither path exists.
   */
  getSubagentsRpcTransport(): SubagentRpcTransport | undefined {
    const inner = this.inner;
    if (typeof inner.requestSubagentsRpc === "function") {
      const request = inner.requestSubagentsRpc.bind(inner);
      return createBridgeSubagentTransport((method, params, options) => request(method, params, options));
    }
    if (this.subagentsEventBus) return createEventBusSubagentTransport(this.subagentsEventBus);
    return undefined;
  }

  /**
   * Whether pi-subagents is loaded in this session, by extension source/path
   * (never by tool name). `unknown` means this engine cannot tell — it must
   * never be reported as "not installed".
   */
  piSubagentsExtensionState(): "loaded" | "not-loaded" | "unknown" {
    const inner = this.inner;
    if (typeof inner.piSubagentsExtensionState === "function") return inner.piSubagentsExtensionState();
    const extensions = inner.resourceLoader?.getExtensions?.().extensions;
    if (!extensions || !Array.isArray(extensions)) return "unknown";
    return loadResultHasPiSubagentsExtension(extensions) ? "loaded" : "not-loaded";
  }

  /** Aborts once shutdown() or destroy() starts; scoped subagent RPC uses it as its cancellation signal. */
  getLifecycleAbortSignal(): AbortSignal {
    return this.lifecycleAbort.signal;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }


  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") {
        this.stopRequested = false;
        this.agentRunNeedsCompletion = true;
        // Cross-window liveness: idle → running must reach other windows'
        // sidebars through the running-events stream, not just this one's SSE.
        notifyRunningChange();
      }
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        notifyRunningChange();
        // Every tool call of the run has finished; nothing is left to replay.
        this.activeToolEvents.clear();
      }
      // Renames (this window, another window, or an extension) bump the list
      // version so every sidebar refetches titles. The running-events frame is
      // the delivery channel for the version, so broadcast even though the
      // running set itself is unchanged.
      if (event.type === "session_info_changed") {
        invalidateSessionListCache();
        notifyRunningChange();
      }
      this.trackActiveToolEvent(event);
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      // `agent_end` fires before the post-run pipeline (compaction, branch
      // summaries, queued continuations) completes, so the running set can
      // only shrink at `agent_settled` — or when the RPC prompt itself
      // settles (see finishPrompt). Compaction also flips `isCompacting`
      // outside any run (manual compact).
      if (
        event.type === "agent_settled"
        || event.type === "compaction_start"
        || event.type === "compaction_end"
      ) {
        notifyRunningChange();
      }
      if (event.type === "agent_settled") {
        this.composerQueue.wake();
        this.notifyAgentRunCompleteIfIdle();
      }
    });
    this.resetIdleTimer();
    // A reopened wrapper may already be running (restored mid-run); make
    // connected sidebars reconcile instead of waiting for the next event.
    notifyRunningChange();
    this.composerQueue.wake();
  }

  /**
   * Keep the latest start or update of each running tool call for onEvent() to
   * replay. Calls a tool makes itself (a codemode script's, which carry
   * `parentToolCallId`) are left out: a reconnecting client would show each as a
   * top-level tool, and the parent's own update already reports them. A nested
   * end can still arrive after its parent's, and is ignored like the rest.
   */
  private trackActiveToolEvent(event: AgentEvent): void {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || isNestedToolExecutionEvent(event)) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeToolEvents.set(toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeToolEvents.delete(toolCallId);
      const nestedPrefix = `${toolCallId}/`;
      for (const id of this.activeToolEvents.keys()) {
        if (id.startsWith(nestedPrefix)) this.activeToolEvents.delete(id);
      }
    }
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.isAlive() || !this.agentRunNeedsCompletion || this.isRunning() || this.composerQueue.snapshot().length) return;
    this.agentRunNeedsCompletion = false;
    if (this.suppressCompletionNotifications) return;
    try {
      this.onAgentRunComplete?.(this.sessionId);
    } catch (error) {
      console.error("[pi-web] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  beginExtensionBinding(): void {
    void this.ensureExtensionsBound().catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(): Promise<void> {
    if (this.extensionsBound) return Promise.resolve();
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: `Extension requested shutdown, but shutdown is not supported in ${PRODUCT_NAME}.`,
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  /** The session's extension commands as pi looks them up: by invocation name, with the extension's path. */
  private extensionCommandCandidates(): McpCommandCandidate[] {
    try {
      return this.inner.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        sourceInfo: command.sourceInfo,
      }));
    } catch {
      // Unreadable: treat the prompt as one that may start a run, as before.
      return [];
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "get_commands"
      || type === "get_state";
  }

  private async withFinalIdleReset<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      // Abort/compact settle outside the run broadcasts above when the
      // session was idle beforehand (nothing to abort, compact finished
      // without touching a run).
      notifyRunningChange();
    }
  }

  /** Apply a coding tool selection; `carry` defaults to the tools active now. */
  async setActiveToolSelection(toolNames: string[], carry?: readonly string[]): Promise<void> {
    if (this.noLiveToolSwitch) {
      // The child restored the target branch's loadout itself; the pin
      // re-applies at the next respawn (setRpcSessionTools).
      return;
    }
    if (carry === undefined) {
      // The carry must reflect the engine's live state: a tool registered
      // since the last query (a late MCP server) would otherwise be switched
      // off by the loadout change.
      await this.inner.refreshTools?.();
      carry = this.inner.getActiveToolNames();
    }
    const names = resolveActiveToolNames(this.inner, toolNames, carry);
    await this.inner.setActiveToolsByName(this.chatWorkspace ? restrictToChatTools(this.inner, names, this.chatFolder) : names);
  }

  /** Persist the session's tool-selection pin (the engine's writer when it has one). */
  async persistToolSelection(toolNames: string[] | undefined): Promise<void> {
    if (typeof this.inner.persistToolSelection === "function") {
      await this.inner.persistToolSelection(toolNames);
      return;
    }
    if (toolNames === undefined) appendClearedSessionToolSelection(this.inner.sessionManager);
    else appendSessionToolSelection(this.inner.sessionManager, toolNames);
  }

  /**
   * Tag this session as a scheduled run's output through the engine's single
   * writer. The tag must be confirmed before the run's prompt is sent, so a
   * failure rejects and the runner fails the run instead of proceeding with an
   * untagged session. The host never appends this entry beside a live child.
   */
  async markScheduledRun(data: ScheduledRunMarkerData): Promise<void> {
    if (typeof this.inner.appendScheduledRunMarker !== "function") {
      throw new Error("this engine cannot tag a scheduled run before its prompt starts");
    }
    await this.inner.appendScheduledRunMarker(data);
  }

  /**
   * The live set_tools path: resolve the selection against the engine's real
   * state, then persist the pin AND apply the set in one engine transaction
   * when it has one (the CLI child confirms and appends atomically). The
   * in-process engine keeps its two steps (pin, then apply).
   */
  async applyToolSelectionWithPin(toolNames: string[]): Promise<void> {
    if (this.noLiveToolSwitch) return;
    await this.inner.refreshTools?.();
    const carry = this.inner.getActiveToolNames();
    const names = resolveActiveToolNames(this.inner, toolNames, carry);
    if (typeof this.inner.applyToolSelection === "function") {
      await this.inner.applyToolSelection(names, toolNames);
      return;
    }
    await this.persistToolSelection(toolNames);
    await this.inner.setActiveToolsByName(names);
  }

  /**
   * pi restores the target branch's loadout from its transcript when it navigates the tree,
   * which can bring back coding tools the pinned preset leaves out and drop codemode, so a
   * normal session applies its selection again. Chat only declares no tools, and a
   * subagent's tools are fixed by its profile; both keep what pi restored.
   */
  private async navigateTreeKeepingToolSelection(
    targetId: string,
    options: NavigateTreeOptions,
  ): Promise<{ cancelled: boolean; aborted?: boolean }> {
    const activeBefore = this.inner.getActiveToolNames();
    const result = await this.inner.navigateTree(targetId, options);
    if (result.cancelled || this.chatOnly || this.chatUnlocked) {
      return { cancelled: result.cancelled, ...(result.aborted ? { aborted: true } : {}) };
    }
    if (this.chatWorkspace) {
      // The target branch's transcript may declare coding tools a chat must not have.
      const activeAfter = this.inner.getActiveToolNames();
      await this.setActiveToolSelection(
        this.chatFolder ? [...CHAT_FOLDER_TOOL_NAMES] : [CHAT_READ_TOOL_NAME],
        [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
      );
      return { cancelled: false };
    }

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (!readSubagentSessionResources(entries)) {
      const activeAfter = this.inner.getActiveToolNames();
      await this.setActiveToolSelection(
        readSessionToolSelection(entries) ?? activeAfter,
        [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
      );
    }
    return { cancelled: false };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[pi-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private resetIdleTimer(): void {
    if (!this._alive) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      return;
    }
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    // A stuck user reloads, reopens the session or presses Stop again, and
    // each of those commands lands here. Moving the forced deadline for them
    // would keep a run that Stop cannot unwind alive indefinitely.
    if (this.forceShutdownOnIdle && this.forcedIdleTimerArmed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A resolved timeout of 0 disables idle shutdown, but a run that Stop could
    // not unwind is still reaped after the default delay; otherwise it stays
    // running until the server restarts (#656).
    const timeoutMs = SESSION_IDLE_TIMEOUT_MS
      || (this.forceShutdownOnIdle ? DEFAULT_SESSION_IDLE_TIMEOUT_MS : 0);
    this.forcedIdleTimerArmed = timeoutMs !== 0 && this.forceShutdownOnIdle;
    if (timeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.forceShutdownOnIdle && (this.isRunning() || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, timeoutMs);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi delays the first flush until a user or assistant message exists.
    // A leading shell command is neither, so mark this SDK manager as
    // flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    for (const event of this.activeToolEvents.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Resolves `true` once the SDK session is disposed, or `false` after `timeoutMs`:
   * shutdown() waits for extension binding without a deadline.
   */
  waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.disposed.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }

  private async withSessionReplacement<T>(
    replacement: "fork" | "clone",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionReplacement) throw new Error("Session is already being copied");
    this.sessionReplacement = replacement;
    try {
      return await operation();
    } finally {
      if (this._alive) this.sessionReplacement = null;
    }
  }

  private isSessionRunningForReplacement(): boolean {
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPromptCount > 0;
  }

  private async shutdownAfterSessionReplacement(replacement: "fork" | "clone"): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      console.error(
        `[pi-web] ${replacement} succeeded, but source session shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    const allowedDuringReplacement = COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT.has(type);
    if (this.sessionReplacement && !allowedDuringReplacement) {
      throw new Error("Session is being copied to a new session");
    }
    if (!this.isAlive()) throw new Error("Session process is closed; send a new prompt to restart it");
    if (SESSION_REPLACEMENT_COMMAND_TYPES.has(type) && this.activeMutatingCommands > 0) {
      throw new Error(`Cannot ${type} while another session command is running`);
    }

    const tracksMutation = !allowedDuringReplacement;
    if (tracksMutation) this.activeMutatingCommands += 1;

    try {
      // Status reconciliation must not postpone forced cleanup after Stop.
      if (type !== "get_state") this.resetIdleTimer();
      if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
      if (!this.isAlive()) throw new Error("Session process is closed");
      if (this.sessionReplacement && !allowedDuringReplacement) {
        throw new Error("Session is being copied to a new session");
      }

      if (type === "prompt" || type === "steer" || type === "follow_up" || type === "queue_composer") {
        const imageError = validateAgentImages(command.images);
        if (imageError) throw new Error(imageError);
      }

      switch (type) {
      case "queue_composer":
        return this.composerQueue.enqueue(command.message as string, command.images as PendingComposerMessage["images"]);
      case "take_composer_message":
        return {
          item: this.composerQueue.take(command.id as string),
          pending: this.composerQueue.snapshot(), pendingVersion: this.composerQueue.version,
        };
      case "send_composer_message":
        await this.composerQueue.sendNow(command.id as string);
        return { item: null, pending: this.composerQueue.snapshot(), pendingVersion: this.composerQueue.version };
      case "prompt": {
        // A chat's folder keeps a copy of the text files attached to the message.
        if (this.chatFolder && typeof command.message === "string") {
          saveAttachedFilesToFolder(this.cwd, command.message);
        }
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          if (this.extensionUiAbortController.signal.aborted) {
            this.extensionUiAbortController = new AbortController();
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              this.agentRunNeedsCompletion = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            if (this.pendingPromptCount === 0) {
              this.pendingPromptPreview = null;
              invalidateSessionListCache();
            }
            this.resetIdleTimer();
            // The prompt promise settles AFTER agent_end/agent_settled were
            // broadcast (the SDK resolves it only once the run is fully idle),
            // and pendingPromptCount kept isRunning() true until now. Without
            // this broadcast the last frame on the running-events stream still
            // contains the session id and the sidebar spinner never stops.
            notifyRunningChange();
            this.composerQueue.wake();
            this.notifyAgentRunCompleteIfIdle();
          };

          this.pendingPromptCount += 1;
          // A submitted prompt belongs in the list before MCP/preflight or the
          // SDK's first message. Composer warm-up never enters this path.
          this.pendingPromptPreview ??= {
            text: typeof command.message === "string" ? command.message : "",
            timestamp: Date.now(),
          };
          invalidateSessionListCache();
          // Admission already makes isRunning() true; the SDK's agent_start
          // (and its broadcast) may lag behind preflight by a beat.
          notifyRunningChange();
          // A prompt that may start a run first connects the session's MCP servers and
          // waits for the ones still connecting. The SDK runs before_agent_start before a
          // run has an abort signal, so Stop is honoured here: it ends the wait, and the
          // message is rejected unsent, which returns it to the composer. pi runs an
          // extension command before anything else and starts no run for it: another
          // extension's command skips this, and the built-in `/mcp`, which acts on the
          // registered servers, registers them without waiting (`mcpPromptPreparation()`).
          const mcpPreparation = this.mcpHost && !this.inner.isStreaming
            ? mcpPromptPreparation(typeof command.message === "string" ? command.message : "", this.extensionCommandCandidates())
            : "none";
          if (this.mcpHost && mcpPreparation !== "none") {
            const controller = new AbortController();
            const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: mcpPreparation === "wait" })
              .catch((error: unknown) => {
                console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
              })
              .then(() => {
                if (!controller.signal.aborted) return;
                finishPrompt();
                throw new Error(MCP_WAIT_STOPPED_MESSAGE);
              });
            const wait = { controller, done: waited.then(() => undefined, () => undefined) };
            this.mcpPromptWait = wait;
            try {
              await waited;
            } finally {
              if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
            }
          }
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              // Every disposition (handled, queued, started) is an acceptance; a
              // rejected prompt never calls this and rejects `prompt` instead.
              preflightResult: () => acceptPreflight(),
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort_retry":
        // Cancel an in-flight auto-retry backoff without aborting the whole run.
        this.inner.abortRetry?.();
        return null;

      case "abort":
        this.stopRequested = true;
        this.composerQueue.pause();
        this.forceShutdownOnIdle = true;
        // Arm the forced cleanup now: the reset above ran before this flag,
        // and the final reset only runs once the SDK run has unwound.
        this.resetIdleTimer();
        // Stop must unwind extension commands that have not started the agent yet.
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        // A prompt still waiting for MCP servers is withdrawn before it starts a run.
        if (this.mcpPromptWait) {
          const wait = this.mcpPromptWait;
          wait.controller.abort();
          await wait.done;
        }
        try {
          await this.withFinalIdleReset(() => this.inner.abort());
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        // Replay the CLI's active projection, not the disk tail. A failed
        // query means unknown, never "no record" or a different branch.
        const promptSnapshot = await this.readSystemPromptSnapshot();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          streamingMessage: this.inner.agent.state?.streamingMessage,
          isPromptRunning: this.pendingPromptCount > 0,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          steeringMode: this.inner.steeringMode,
          followUpMode: this.inner.followUpMode,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: (this.inner.pendingMessageCount ?? 0) + this.composerQueue.snapshot().length,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
            pending: this.composerQueue.snapshot(),
            pendingVersion: this.composerQueue.version,
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          // Recorded CLI composition, configured base only, confirmed absence,
          // or unknown on a failed read. A transcript is not provider receipt.
          systemPrompt: promptSnapshot.text,
          systemPromptStatus: promptSnapshot.status,
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          routedModel: this.getRoutedModel(),
          cacheWarming: this.getCacheWarming(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        // Forking copies finished entries from disk into a new file and never
        // touches this AgentSession, so a running source keeps its run. Only an
        // idle source is shut down, because the browser moves to the child.
        const keepSource = this.isSessionRunningForReplacement();
        return this.withSessionReplacement("fork", async () => {
          const entryId = command.entryId as string;
          const sessionManager = this.inner.sessionManager;
          const currentSessionFile = this.inner.sessionFile;

          if (!sessionManager.isPersisted()) return { cancelled: true };
          if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

          const entry = sessionManager.getEntry(entryId);
          if (!entry) throw new Error("Invalid entry ID for forking");

          const { newSessionId } = this.writeForkedSession(entry.parentId ?? null);
          if (!keepSource) await this.shutdownAfterSessionReplacement("fork");
          return { cancelled: false, newSessionId };
        });
      }

      case "fork_branch": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");
        if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");

        const newSessionId = SessionManager.open(forkedPath, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, forkedPath);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "clone": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot clone while the session is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId
          : this.inner.getActiveEntries ? (await this.inner.getActiveEntries()).leafId
          : sessionManager.getLeafId();
        const branchHasAssistant = leafId && sessionManager.getBranch(leafId).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (!currentSessionFile || !existsSync(currentSessionFile)) return { cancelled: true };
        if (!leafId || !branchHasAssistant) return { cancelled: true };

        return this.withSessionReplacement("clone", async () => {
          const sessionDir = sessionManager.getSessionDir();
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const clonedPath = sourceManager.createBranchedSession(leafId);
          if (!clonedPath || !existsSync(clonedPath)) throw new Error("Failed to clone current session branch");

          const newSessionId = SessionManager.open(clonedPath, sessionDir).getSessionId();
          cacheSessionPath(newSessionId, clonedPath);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("clone");
          return { cancelled: false, newSessionId };
        });
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        // `summarize` asks pi to summarize the branch being left onto the target (pi's
        // "Summarize branch?" in /tree); the request blocks until the summary is written,
        // and abort_branch_summary answers it with { cancelled: true, aborted: true }.
        return this.navigateTreeKeepingToolSelection(command.targetId as string, {
          ...(command.summarize === true ? { summarize: true } : {}),
          ...(typeof command.customInstructions === "string" && command.customInstructions.trim()
            ? { customInstructions: command.customInstructions.trim() }
            : {}),
        });
      }

      case "abort_branch_summary": {
        this.inner.abortBranchSummary?.();
        return null;
      }

      case "set_thinking_level": {
        // 0.86: setThinkingLevel clamps to getAvailableThinkingLevels() and
        // DeepSeek-compat models include their mapped levels in that list —
        // no manual state force-back needed anymore.
        this.inner.setThinkingLevel(command.level as string);
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalIdleReset(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        // The CLI engine answers only after the child wrote the name; awaiting
        // it keeps the list refresh from republishing the old name and makes a
        // rejected rename reach the caller instead of looking successful.
        await this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
          costBreakdown: getUsageCostBreakdown(this.inner.sessionManager.getEntries() as unknown as SessionEntry[]),
          cacheWarming: this.getCacheWarming(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        // The CLI engine's list comes from the child's real state: refresh
        // before answering so the picker never shows a stale universe.
        await this.inner.refreshTools?.();
        // A hidden tool is withdrawn: pi ignores it when setting the active tools. A chat
        // never lists the coding tools it blocks.
        const all: ToolInfo[] = this.inner.getAllTools().filter((t) => (
          t.exposure !== "hidden" && !(this.chatWorkspace && chatBlockedToolNames(this.chatFolder).has(t.name))
        ));
        const active = new Set<string>(this.inner.getActiveToolNames());
        // The definition's description is not always what the model gets: `prepareLoadout`
        // hooks rewrite the declared ones (codemode lists its nested tools and the MCP types).
        const declared = new Map((this.inner.agent.state?.tools ?? []).map((t) => [t.name, t.description]));
        // Active and callable, but requests leave the declaration out: codemode's "only" mode
        // does this to active `direct` tools. The set is private to pi 0.99's AgentSession.
        const hiddenDeclarations: unknown = Reflect.get(this.inner, "_hiddenDeclarations");
        const hidden = hiddenDeclarations instanceof Set ? hiddenDeclarations : new Set<unknown>();
        return all.map((t) => ({
          ...t,
          description: declared.get(t.name) ?? t.description,
          active: active.has(t.name),
          declarationHidden: hidden.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        if (this.chatWorkspace || this.chatUnlocked) {
          throw new Error("Chats have no tools. Open a project to change the tool preset.");
        }
        const toolNames = command.toolNames as string[];
        await this.setActiveToolSelection(toolNames);
        return null;
      }

      case "reload": {
        if (this.extensionUiAbortController.signal.aborted) {
          this.extensionUiAbortController = new AbortController();
        }
        const activeToolNames = this.inner.getActiveToolNames();
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        // pi rebuilds from the tools active before, then extensions adjust them as they start
        // again; carry that result so a tool one switched off during reload stays off.
        await this.setActiveToolSelection(activeToolNames);
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.stopRequested = true;
        await this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "set_steering_mode": {
        this.inner.setSteeringMode?.(command.mode as "all" | "one-at-a-time");
        return null;
      }

      case "set_follow_up_mode": {
        this.inner.setFollowUpMode?.(command.mode as "all" | "one-at-a-time");
        return null;
      }

      case "bash": {
        if (this.chatWorkspace) {
          throw new Error("Shell commands are unavailable in chats. Open a project to run one.");
        }
        if (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          // executeBash emits no start/end SDK events (only output deltas);
          // keep the running-events stream in sync from the RPC boundary.
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.stopRequested = true;
        this.composerQueue.pause();
        this.forceShutdownOnIdle = true;
        this.resetIdleTimer();
        await this.inner.abortBash();
        return null;
      }

        default:
          throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
    }
  }

  /**
   * Once, as closing starts and before extensions hear session_shutdown: the
   * MCP host's own handler runs after every other extension's, and one that
   * never returns would leave its records behind (lib/mcp-host.ts).
   */
  private disposeMcpHost(): void {
    if (this.mcpHostDisposed) return;
    this.mcpHostDisposed = true;
    try {
      this.mcpHost?.dispose();
    } catch (error) {
      console.error("[pi-web] MCP host dispose failed:", error instanceof Error ? error.message : error);
    }
  }

  /** Transport failure is terminal, not a successful agent completion. */
  handleProcessExit(code: number | null, signal?: string | null): void {
    if (!this.isAlive()) return;
    this.composerQueue.pause();
    this.agentRunNeedsCompletion = false;
    this.emit({ type: "session_process_exit", code, signal: signal ?? null });
    this.destroy();
    invalidateSessionListCache();
    notifyRunningChange();
  }

  async forceStop(expectedInstanceId: unknown): Promise<void> {
    if (expectedInstanceId !== this.instanceId || !this.isAlive()) {
      throw new Error("Session process changed; refusing to terminate a replacement");
    }
    if (!this.stopRequested || !this.terminateProcess) {
      throw new Error("Request Stop before forcing this session process to terminate");
    }
    this.composerQueue.pause();
    await this.terminateProcess();
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.composerQueue.dispose();
    if (!this.lifecycleAbort.signal.aborted) this.lifecycleAbort.abort(new Error("AgentSessionWrapper destroyed"));
    this.disposeMcpHost();
    // Tell attached SSE listeners to drop this instance so the browser
    // EventSource errors and reconnects instead of staying OPEN on a dead wrapper.
    this.emit({ type: "session_shutdown" });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) void Promise.resolve(this.inner.abortBash()).catch(() => {});
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeToolEvents.clear();
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        this.onDestroyCallback?.();
        this.resolveDisposed();
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void this.emitSessionShutdown(emit)
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;
    // Closing starts before the first await, so a request that arrives while
    // extensions shut down starts a fresh wrapper instead of prompting this one.
    this.closing = true;
    if (!this.lifecycleAbort.signal.aborted) this.lifecycleAbort.abort(new Error("AgentSessionWrapper shutting down"));

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        // After binding, so the host's session_start has run and finds nothing to record later.
        this.disposeMcpHost();
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          const emit = this.inner.extensionRunner?.emit;
          if (typeof emit === "function") await this.emitSessionShutdown(emit);
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Gives extensions at most SESSION_SHUTDOWN_DEADLINE_MS to handle
   * session_shutdown, then returns so the SDK session is disposed and
   * unregistered anyway. Closing an MCP connection has no upper bound: it waits
   * for a token refresh in flight and for a stdio child whose daemonized
   * grandchild may never close stdout.
   */
  private async emitSessionShutdown(
    emit: NonNullable<AgentSessionLike["extensionRunner"]["emit"]>,
  ): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), SESSION_SHUTDOWN_DEADLINE_MS);
      // A quitting process must not wait for an extension's cleanup.
      deadlineTimer.unref?.();
    });
    // A synchronous throw becomes a rejection, and a rejection that arrives
    // after the deadline is still handled by the race below.
    const handled = (async () => {
      await emit.call(this.inner.extensionRunner, { type: "session_shutdown", reason: "quit" });
      return "handled" as const;
    })();
    try {
      if (await Promise.race([handled, deadline]) === "timeout") {
        console.warn(
          `[pi-web] extensions did not finish session_shutdown for session ${this.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms; disposing it anyway`,
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  /**
   * RPC-engine bridge: a dialog raised by an extension inside the pi child.
   * Reuses the pending-UI maps, so a late SSE subscriber sees the dialog on
   * replay and Stop cancels it, exactly like an in-process extension dialog;
   * the caller (lib/pi-rpc/core.ts) returns the response to the child. A
   * timeout or abort resolves with `cancelled` so the child never blocks.
   */
  relayExternalUiRequest(request: {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    timeout?: number;
    [key: string]: unknown;
  }): Promise<ExtensionUiResponse> {
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted || !this.isAlive()) {
      return Promise.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
    const cancelled = (): ExtensionUiResponse => ({ type: "extension_ui_response", id: request.id, cancelled: true });
    // The child enforces its own timeout (it auto-resolves with a default),
    // so the local one only bounds the stale replay window: give it slack.
    const timeout = typeof request.timeout === "number" && request.timeout > 0 ? request.timeout + 2_000 : undefined;

    const fullRequest = {
      type: "extension_ui_request",
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    } as AgentEvent;

    return new Promise<ExtensionUiResponse>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        stopSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(request.id);
        this.pendingUiResponses.delete(request.id);
        if (this.isAlive()) this.emit({ type: "extension_ui_closed", id: request.id });
      };
      const settle = (value: ExtensionUiResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(stopSignal.aborted ? cancelled() : value);
      };
      const onAbort = () => settle(cancelled());

      if (timeout) timeoutId = setTimeout(() => settle(cancelled()), timeout);
      stopSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(request.id, fullRequest);
      this.pendingUiResponses.set(request.id, {
        resolve: (response) => settle(response),
        cancel: () => settle(cancelled()),
      });
      this.emit(fullRequest);
    });
  }

  /**
   * RPC-engine bridge: fire-and-forget UI from the child's extensions
   * (notify / setStatus / setWidget / setTitle / set_editor_text). The record
   * is emitted as-is — the wire shape is the same family as the in-process
   * events — while status and widget maps stay in sync for `get_state`.
   */
  relayExternalUiEvent(event: AgentEvent & { method?: string }): void {
    if (!this.isAlive()) return;
    switch (event.method) {
      case "setStatus": {
        const key = event.statusKey;
        if (typeof key === "string") {
          const text = event.statusText;
          if (typeof text === "string") this.extensionStatuses.set(key, text);
          else this.extensionStatuses.delete(key);
        }
        break;
      }
      case "setWidget": {
        const key = event.widgetKey;
        if (typeof key === "string") {
          this.extensionWidgetGenerations.set(key, (this.extensionWidgetGenerations.get(key) ?? 0) + 1);
          const lines = event.widgetLines;
          if (Array.isArray(lines) && lines.every((line) => typeof line === "string")) {
            this.extensionWidgets.set(key, {
              key,
              lines,
              placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
            });
          } else {
            this.extensionWidgets.delete(key);
          }
        }
        break;
      }
      default:
        // notify / setTitle / set_editor_text: stateless, the event carries everything.
        break;
    }
    this.emit(event);
  }

  private getRoutedModel(): RoutedModelInfo | undefined {
    const routed = this.inner.routedModel;
    if (!routed) return undefined;
    return {
      provider: routed.model.provider,
      id: routed.model.id,
      ...(routed.thinkingLevel ? { thinkingLevel: routed.thinkingLevel } : {}),
    };
  }

  private async readSystemPromptSnapshot(): Promise<{ status: "recorded" | "configured" | "none" | "unknown"; text: string }> {
    try {
      const snapshot = this.inner.getActiveEntries
        ? await this.inner.getActiveEntries({ timeoutMs: 10_000 })
        : { entries: this.inner.sessionManager.getEntries(), leafId: this.inner.sessionManager.getLeafId() };
      const replayed = extractActiveSystemPrompt(snapshot.entries as Parameters<typeof extractActiveSystemPrompt>[0], snapshot.leafId);
      // Recorded CLI composition takes precedence, even for custom bases.
      if (replayed.recorded) return { status: "recorded", text: replayed.text };
      if (this.exactSystemPrompt) return { status: "configured", text: this.exactSystemPrompt() };
      return { status: "none", text: "" };
    } catch {
      // Liveness polling must still work if prompt inspection is unavailable.
      return { status: "unknown", text: "" };
    }
  }

  private getCacheWarming(): CacheWarmingInfo | undefined {
    // Structural fakes and pre-0.86 sessions have no cache warming to report.
    const mode = this.inner.settingsManager?.getCacheWarmingMode?.();
    if (!mode) return undefined;
    const status = this.inner.cacheWarmingStatus;
    return {
      mode,
      ...(status ? { status: structuredClone(status) } : {}),
    };
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => completed ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        this.emit({ type: "extension_ui_closed", id });
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: `Theme switching is not supported in ${PRODUCT_NAME} extension UI yet` }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private writeForkedSession(targetLeafId: string | null): { newSessionId: string; newSessionFile: string } {
    return writeForkedSession(this.inner, targetLeafId);
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    const { newSession, fork, switchSession } = createSessionReplacementActions({
      inner: this.inner,
      cwd: this.cwd,
      emit: (event) => this.emit(event as unknown as AgentEvent),
      startSession: startRpcSession,
    });
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession,
      fork,
      navigateTree: (targetId, options) => this.navigateTreeKeepingToolSelection(targetId, options ?? {}),
      switchSession,
      reload: async () => {
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piChildExitWaits: Map<string, Promise<void>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const destroy = () => globalThis.__piSessions?.forEach((session) => session.destroy());
    const shutdown = () => {
      const sessions = Array.from(globalThis.__piSessions?.values() ?? []);
      void Promise.allSettled(sessions.map((session) => session.shutdown()));
    };
    // Node cannot await work from an exit handler; direct destruction starts
    // extension cleanup synchronously as a final best effort.
    process.once("exit", destroy);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piSessions;
}

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  // A closing wrapper reports itself dead while extensions shut down, so the
  // next request registers a replacement under the same id. Finishing later,
  // the closing wrapper must not unregister that replacement.
  wrapper.onDestroy(() => {
    if (registry.get(sessionId) !== wrapper) return;
    registry.delete(sessionId);
    // A destroyed wrapper leaves the running set (idle shutdown, branch
    // switch, fork/clone replacement); push the new set so sidebars clear
    // its spinner instead of waiting for the next broadcast.
    notifyRunningChange();
    // Its child may still be in its exit grace; later host appends and
    // replacement starts for this id wait for the real exit.
    recordChildExitWait(sessionId, wrapper);
  });
  // A wrapper registered before a hot reload still unregisters by id alone.
  const previous = registry.get(sessionId);
  if (previous && previous !== wrapper && typeof previous.onDestroy === "function") {
    previous.onDestroy(() => {});
  }
  registry.set(sessionId, wrapper);
  wrapper.start();
  wrapper.beginExtensionBinding();
}

// The builtin subagent controller is gone (M4): sessions run on the pi CLI
// child, where the pi-subagents package spawns its own children natively.
// Legacy subagent-child session files still carry their marker (the session
// routes read it); there is no live run behind them to steer or abort.
export function getSubagentRun(_sessionId: string): undefined {
  void _sessionId;
  return undefined;
}

export async function steerSubagent(_sessionId: string, _message: string): Promise<undefined> {
  void _sessionId; void _message;
  return undefined;
}

export async function abortSubagent(_sessionId: string): Promise<void> {
  void _sessionId;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

const CLOSING_SESSION_WAIT_MARGIN_MS = 1_000;
const closingSessionWaits = new WeakMap<AgentSessionWrapper, { done: boolean; promise: Promise<void> }>();

/**
 * The wait for a wrapper of `sessionId` that is shutting down, or null when there is none
 * left to wait for. Until it is disposed the closing wrapper still owns the session: an
 * extension's session_shutdown may append to the file, which a replacement opened earlier
 * would branch away from, and dispose() releases provider resources (a Codex websocket) by
 * session id, which the replacement shares. The wait is bounded so a shutdown stuck in
 * extension binding cannot keep the session from starting again. One wait per closing
 * wrapper: its bound runs from the first caller and later callers share it, so a
 * shutdown still binding extensions can be overtaken only after its CLI exits.
 */
function closingRpcSessionWait(sessionId: string): Promise<void> | null {
  const closing = getRegistry().get(sessionId);
  // A wrapper from before a hot reload may lack waitUntilDisposed.
  if (!closing || closing.isAlive() || typeof closing.waitUntilDisposed !== "function") return null;
  let wait = closingSessionWaits.get(closing);
  if (!wait) {
    const entry = { done: false, promise: Promise.resolve() };
    entry.promise = closing.waitUntilDisposed(SESSION_SHUTDOWN_DEADLINE_MS + CLOSING_SESSION_WAIT_MARGIN_MS)
      .then(async (disposed) => {
        // Even if wrapper disposal times out, a live CLI is still a writer.
        // Never overtake it. An exit timeout rejects and remains fail-closed.
        await closing.inner.waitForChildExit?.();
        if (!disposed) console.warn(`[pi-web] session ${sessionId} is still disposing; its child has exited`);
        entry.done = true;
      });
    closingSessionWaits.set(closing, entry);
    wait = entry;
  }
  return wait.done ? null : wait.promise;
}

/** Live child-exit waits for wrappers already destroyed (globalThis: survives hot reload). */
function getChildExitWaits(): Map<string, Promise<void>> {
  globalThis.__piChildExitWaits ??= new Map();
  return globalThis.__piChildExitWaits;
}

/**
 * Remember a destroyed wrapper's child exit under its session id. A disposed
 * wrapper is not an exited process — dispose fire-and-forgets the child's
 * close (its grace kill can take seconds) — so any host-side append or
 * replacement spawn for that id must first await the real exit this records.
 */
function recordChildExitWait(sessionId: string, wrapper: AgentSessionWrapper): void {
  const waitForChildExit = wrapper.inner.waitForChildExit;
  if (typeof waitForChildExit !== "function") return;
  let wait: Promise<void>;
  try {
    wait = waitForChildExit.call(wrapper.inner);
  } catch (error) {
    wait = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  // The recorded wait is awaited by callers that must not proceed beside a
  // live writer; nobody else observes it, so it must not surface as an
  // unhandled rejection when no caller is waiting.
  void wait.catch(() => undefined);
  const exits = getChildExitWaits();
  exits.set(sessionId, wait);
  void wait.then(
    () => { if (exits.get(sessionId) === wait) exits.delete(sessionId); },
    () => { /* Fail closed: a timeout does not prove the writer exited. */ },
  );
}

/**
 * Wait for a destroyed wrapper's child to really be gone, so the host is the
 * session file's only writer. No record means no child this process knows of
 * (a cold open, or one that already exited and was cleaned up). A child that
 * outlives the engine's own wait rejects here, which callers surface instead
 * of appending beside it.
 */
function waitForRecentChildExit(sessionId: string): Promise<void> {
  return getChildExitWaits().get(sessionId) ?? Promise.resolve();
}

/**
 * Append the chat unlock/lock entry through the engine's after-exit writer.
 * The guards that authorize the change (local-only, chat folder, not running,
 * file persisted) have already run in setRpcChatUnlock; the entry lands only
 * once the engine's child process really exited, never beside a live writer
 * and never through a bridge op that could bypass those guards.
 */
async function appendChatUnlockAfterChildExit(
  existing: AgentSessionWrapper,
  unlocked: boolean,
): Promise<void> {
  const inner = existing.inner;
  if (typeof inner.appendChatUnlockAfterExit === "function") {
    await inner.appendChatUnlockAfterExit(unlocked);
    return;
  }
  // Capability absence alone does not prove there is no child.
  await inner.waitForChildExit?.();
  appendChatUnlock(inner.sessionManager, unlocked);
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/** Which writer appends the tool pin for a session that must restart. */
export type ToolPinRestartPhase =
  /** The engine's live runtime appends it (a CLI child, single writer). */
  | "engine-live"
  /** The host appends it, but only after the engine's child exited. */
  | "host-after-exit"
  /** An in-process engine: the host appends through the session manager. */
  | "host-manager";

/**
 * The pin's writer for a restart. This asks the engine's PERSISTENCE capability
 * (`canPersistToolPinLive`), never its switching policy: a chat-only session
 * refuses live tool switches but its child still appends the pin itself, and a
 * CLI child whose bridge knows no tool operations can only be written to once
 * it exited.
 */
export function toolPinRestartPhase(
  engine: Pick<AgentSessionLike, "persistToolSelection" | "canPersistToolPinLive">,
): ToolPinRestartPhase {
  if (typeof engine.persistToolSelection !== "function") return "host-manager";
  return engine.canPersistToolPinLive?.() === true ? "engine-live" : "host-after-exit";
}

/**
 * Persist a normal session's tool selection and rebuild when resource policy changes.
 * An undefined requestedToolNames returns the session to pi's configured defaults:
 * the pin is retracted and the session is rebuilt, because the loadout that
 * settings.json defaultTools resolves to is only known once pi builds the session.
 */
export function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  return withSessionWriterLock(sessionId, () => setRpcSessionToolsLocked(sessionId, sessionFile, requestedToolNames));
}

async function setRpcSessionToolsLocked(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    // A wrapper still closing, or a start already under way, owns the file: wait for it and
    // apply the selection to whatever it left, or a start that opened the file first would
    // come up without the selection while this call reported success.
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending;
      return setRpcSessionToolsLocked(sessionId, sessionFile, requestedToolNames);
    }
    // A just-destroyed wrapper's child may still be exiting; the pin is only
    // the host's to write once that process is really gone.
    await waitForRecentChildExit(sessionId);
    const manager = SessionManager.open(sessionFile, undefined);
    if (isChatWorkspacePath(manager.getCwd())) {
      throw new Error("Chats have no tools. Open a project to change the tool preset.");
    }
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    if (toolNames === undefined) appendClearedSessionToolSelection(manager);
    else appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSessionLocked(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (existing.isChat()) {
    throw new Error("Chats have no tools. Open a project to change the tool preset.");
  }
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  // The pi CLI engine switches tools live through the bridge when its probe
  // succeeded; otherwise (old bridge asset, or a protocol failure) a
  // same-boundary pin change must respawn the child for the new selection.
  // Chat-only sessions always restart here (their spawn flags differ), even
  // though their bridge does answer tool operations.
  const needsRestart = crossesChatOnlyBoundary
    || (typeof existing.canLiveSwitchTools === "function" && !existing.canLiveSwitchTools());

  if (toolNames !== undefined && !needsRestart) {
    // Live path: one engine transaction (apply + confirm + pin) when present.
    await existing.applyToolSelectionWithPin(toolNames);
    invalidateSessionListCache();
    return { session: existing, sessionId, recreated: false };
  }

  // Which writer owns the pin on the restart path, and when. This is the
  // engine's PERSISTENCE capability, not its switching policy: a chat-only
  // session cannot switch live but its child still appends the pin itself.
  const pinPhase = toolPinRestartPhase(existing.inner);

  if (pinPhase !== "host-after-exit") {
    // The live child appends the pin itself (single writer) or this is an
    // in-process engine's own manager: write before the restart.
    await existing.persistToolSelection(toolNames);
    invalidateSessionListCache();
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (pinPhase === "host-after-exit") {
    // The engine cannot write the pin while its child lives (no tool ops in the
    // bridge): the host appends it, and only now that the child exited.
    await existing.persistToolSelection(toolNames);
    invalidateSessionListCache();
  }

  if (persistedFile) {
    const started = await startRpcSessionLocked(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSessionLocked(`__recreate__${randomUUID()}`, "", sessionCwd, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    allowInitialModelFallback: true,
    ...(currentThinkingLevel && THINKING_LEVEL_NAMES.has(currentThinkingLevel as ThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel as ThinkingLevel }
      : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

/**
 * Let one chat use the user's computer (a shell, files anywhere), or take that back. The
 * choice is a session entry, so it outlives the process; the session restarts to apply it.
 * Only a chat with a folder that has been saved can be unlocked, and never on a server other
 * machines can reach.
 */
export function setRpcChatUnlock(
  sessionId: string,
  sessionFile: string | undefined,
  unlocked: boolean,
): Promise<SetRpcSessionToolsResult> {
  return withSessionWriterLock(sessionId, () => setRpcChatUnlockLocked(sessionId, sessionFile, unlocked));
}

async function setRpcChatUnlockLocked(
  sessionId: string,
  sessionFile: string | undefined,
  unlocked: boolean,
): Promise<SetRpcSessionToolsResult> {
  if (unlocked && isNetworkExposedServer()) {
    throw new Error("A chat cannot use this computer while the server is open to other machines.");
  }
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending;
      return setRpcChatUnlockLocked(sessionId, sessionFile, unlocked);
    }
    // No wrapper is alive, but a just-destroyed one may still have a child in
    // its exit grace: the host may only append once that process is really
    // gone (a disposed wrapper is not an exited child).
    await waitForRecentChildExit(sessionId);
    const manager = SessionManager.open(sessionFile, undefined);
    if (!isChatFolderPath(manager.getCwd())) throw new Error("Only a chat with its own folder can use the computer.");
    appendChatUnlock(manager, unlocked);
    invalidateSessionListCache();
    const started = await startRpcSessionLocked(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Wait for the chat to finish first");
  if (!isChatFolderPath(existing.cwd)) throw new Error("Only a chat with its own folder can use the computer.");
  if (existing.isChatUnlocked() === unlocked) return { session: existing, sessionId, recreated: false };
  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  // pi writes a session out only once it has an assistant message; an entry added before
  // that would be lost with the restart.
  if (!persistedFile) throw new Error("Send a message first, then this chat can use the computer.");
  // The entry is host-written, and only after the child the shutdown just
  // stopped has really exited: while it lives, the child is the file's writer
  // (its exit can flush for seconds after the wrapper is disposed).
  await existing.shutdown();
  await appendChatUnlockAfterChildExit(existing, unlocked);
  invalidateSessionListCache();
  const started = await startRpcSessionLocked(sessionId, persistedFile, undefined);
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const pendingPrompt = session.getPendingPromptPreview?.();
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Show submitted prompts even before the SDK records them.
    if (!persisted && !options.includeTransient && (!session.isRunning() || (!firstUserMessage && !pendingPrompt))) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = pendingPrompt?.timestamp ?? (Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp);
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: (firstUserMessage ? runtimeMessageText(firstUserMessage) : pendingPrompt?.text) || "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

declare global {
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  // List changes (including an unpersisted prompt appearing/disappearing)
  // must reach every window even when the running id set stays unchanged.
  const snapshot = JSON.stringify({ ids: [...ids].sort(), version: getSessionListVersion() });
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  return withSessionWriterLock(sessionId, () => startRpcSessionLocked(sessionId, sessionFile, cwd, options));
}

async function startRpcSessionLocked(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { initialModel, thinkingLevel } = options;
  void (options as { allowInitialModelFallback?: boolean }).allowInitialModelFallback;
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const closingWait = closingRpcSessionWait(sessionId);
  if (closingWait) {
    // Concurrent starts share this lock, then the one start that follows it.
    const waiting: Promise<{ session: AgentSessionWrapper; realSessionId: string }> = (async () => {
      try {
        await closingWait;
      } finally {
        // Release the start lock on failure too. The child-exit gate remains
        // responsible for fail-closed safety; a stale rejected start is not.
        if (locks.get(sessionId) === waiting) locks.delete(sessionId);
      }
      return startRpcSessionLocked(sessionId, sessionFile, cwd, options);
    })();
    locks.set(sessionId, waiting);
    return waiting;
  }

  // A wrapper destroyed a moment ago (idle eviction, restart) leaves a child
  // in its exit grace; opening or appending to the file before that process is
  // really gone would race its final flush (and a replacement spawn would
  // overlap two children on one file). The wait holds the start lock (the
  // closingWait shape above): a start that arrives while the child is dying
  // shares this one instead of racing beside it. No record means no child this
  // process knows of, and the original synchronous path is kept.
  const childExitGate = getChildExitWaits().get(sessionId);
  if (childExitGate) {
    const gated: Promise<{ session: AgentSessionWrapper; realSessionId: string }> = (async () => {
      try {
        await childExitGate;
      } finally {
        if (locks.get(sessionId) === gated) locks.delete(sessionId);
      }
      return startRpcSessionLocked(sessionId, sessionFile, cwd, options);
    })();
    locks.set(sessionId, gated);
    return gated;
  }

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    // A new chat is requested with the chat root; it gets a folder of its own.
    sessionManager = SessionManager.create(
      isChatRootPath(cwd) ? await createChatFolder() : cwd,
      undefined,
      options.parentSession ? { parentSession: options.parentSession } : undefined,
    );
  }
  const sessionCwd = sessionManager.getCwd();
  const chatWorkspace = isChatWorkspacePath(sessionCwd);
  const chatFolder = isChatFolderPath(sessionCwd);
  if (chatWorkspace) await ensureChatCwd(sessionCwd);
  // Unlocking lets a chat use the computer, so it is a local choice: a server that other
  // machines can reach never honours it.
  const chatUnlocked = chatFolder
    && !isNetworkExposedServer()
    && readChatUnlocked(sessionManager.getEntries() as unknown as SessionEntry[]);
  // The builtin subagent system is gone (the pi-subagents package runs its
  // own children inside the CLI child); legacy subagent-child session files
  // open as ordinary sessions. The marker reader stays for the session routes.
  const persistedToolNames = readSessionToolSelection(sessionManager.getEntries() as unknown as SessionEntry[]);
  // A chat has no tool preset to pick: it loads what a project session loads, and the
  // chat policy extension withholds the coding tools (lib/chat-workspace-policy.ts).
  const selectedToolNames = chatWorkspace
    ? undefined
    : persistedToolNames ?? requestedToolNames;
  if (!chatWorkspace && persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(sessionManager, requestedToolNames);
  }
  const sessionPolicy = deriveSessionPolicy({
    chatWorkspace,
    chatUnlocked,
    chatOnly: selectedToolNames?.length === 0,
  });
  const chatOnly = sessionPolicy.kind === "chat-only";
  const finishStartingSession = trackStartingSession(sessionCwd);
  const starting = (async () => {
    // The CLI engine: every session runs on a `pi --mode rpc` child (M4:
    // the in-process path is gone; the pi-subagents package spawns its own
    // children inside the CLI child).
    {
      if (chatWorkspace) {
        const chatFilesEnabled = chatWorkspace && !isNetworkExposedServer();
        // A new chat starts on the model and reasoning level picked in
        // Settings › Chats (an explicit pick for this session still wins);
        // the factory resolves the model against the child's own catalog,
        // falling back to its default when unconfigured (mirrors the
        // in-process hasConfiguredAuth guard).
        const branch = sessionManager.getBranch();
        const chatHasMessages = branch.some((entry) => entry.type === "message" && entry.message.role !== "system");
        const chatSettings = !chatHasMessages ? readChatSettings() : null;
        const chatInitialModel = initialModel ?? chatSettings?.model ?? undefined;
        const chatThinking = thinkingLevel ?? chatSettings?.thinkingLevel ?? undefined;
        const started = await startCliRpcSessionFromManager(sessionManager, {
          sessionId,
          executable: resolvePiExecutable(),
          chatWorkspace: {
            folder: chatFolder,
            unlocked: chatUnlocked,
            filesEnabled: chatFilesEnabled,
            systemPrompt: chatWorkspacePrompt(chatFilesEnabled, { folder: chatFolder, unlocked: chatUnlocked }),
          },
          ...(chatInitialModel ? { initialModel: chatInitialModel } : {}),
          ...(chatThinking ? { thinkingLevel: chatThinking } : {}),
          onAgentRunComplete: (completedSessionId) => {
            void notifySessionComplete(completedSessionId).catch((error) => {
              console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
            });
          },
          registerWrapper: (wrapper, realSessionId) => {
            registerRpcWrapper(wrapper);
            void realSessionId;
          },
        }, undefined);
        return { session: started.wrapper, realSessionId: started.realSessionId };
      }
      // A chat-only pin sends the exact prompt built from the session cwd's
      // context files (the same material the in-process extension reads).
      let chatOnlyExactPrompt: string | undefined;
      if (chatOnly) {
        const offline = await createAgentSessionServices({
          cwd: sessionCwd,
          agentDir: getAgentDir(),
          ...(projectTrustReloadOptions(sessionCwd, getAgentDir())
            ? { resourceLoaderReloadOptions: projectTrustReloadOptions(sessionCwd, getAgentDir()) }
            : {}),
        });
        chatOnlyExactPrompt = contextFilesSystemPrompt(
          offline.resourceLoader.getAgentsFiles().agentsFiles,
        );
      }
      const started = await startCliRpcSessionFromManager(sessionManager, {
        sessionId,
        executable: resolvePiExecutable(),
        ...(chatOnlyExactPrompt !== undefined ? { chatOnlyExactPrompt, chatOnly: true } : {}),
        ...(initialModel ? { initialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        onAgentRunComplete: (completedSessionId) => {
          void notifySessionComplete(completedSessionId).catch((error) => {
            console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
          });
        },
        registerWrapper: (wrapper, realSessionId) => {
          registerRpcWrapper(wrapper);
          void realSessionId;
        },
      }, selectedToolNames);
      return { session: started.wrapper, realSessionId: started.realSessionId };
    }

  })().finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}
