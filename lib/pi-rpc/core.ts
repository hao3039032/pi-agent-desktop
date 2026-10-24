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
 * Tool listing: pi 1.4.0 has no `get_tools` RPC, so `getAllTools()` reports
 * the built-in coding tool names (the preset universe) and the active set is
 * the selection the factory spawned the child with. Extension tools the
 * child activated (subagents, MCP) stay invisible to the picker until pi
 * grows a tools listing command (upstream PR candidate).
 */

import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PiAgentMessage, SlashCommandInfo, ToolInfo } from "../pi-types";
import { PiRpcClient, type PiRpcRecord } from "./client";
import { PiRpcUnsupportedError, RpcAgentSession, type RpcAgentSessionOptions, type RpcAgentSessionState } from "./session";

/** The subset of the SDK's SessionManager pi-web touches on a live wrapper. */
export class FileSessionManagerView {
  constructor(
    private readonly file: string,
    private readonly fallbackCwd: string,
  ) {}

  private open(): SessionManager {
    return SessionManager.open(this.file, undefined);
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
  // paths reach: unsupported on this engine, and loudly so — a silent
  // TypeError from a missing member reads like a protocol bug.
  isPersisted(): boolean {
    throw new PiRpcUnsupportedError("sessionManager.isPersisted()", "M2: session tree");
  }

  getLeafId(): string | null {
    throw new PiRpcUnsupportedError("sessionManager.getLeafId()", "M2: session tree");
  }

  getSessionDir(): string {
    throw new PiRpcUnsupportedError("sessionManager.getSessionDir()", "M2: session tree");
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
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

interface GetCommandsResult {
  commands?: Array<SlashCommandInfo & { source?: string }>;
}

export class CliAgentSessionCore extends RpcAgentSession {
  private readonly coreSessionFile: string;
  private readonly sessionCwd: string;
  private readonly spawnToolNames: string[] | undefined;
  private readonly knownToolNames: readonly string[];
  private readonly localSettings: SettingsManager;
  private readonly view: FileSessionManagerView;
  private commandsCache: GetCommandsResult["commands"];
  private uiRelay: UiRelayTarget | undefined;
  private offUiRelay: Array<() => void> = [];

  constructor(options: CliAgentSessionCoreOptions) {
    super(options);
    this.coreSessionFile = options.sessionFile;
    this.sessionCwd = options.cwd;
    this.spawnToolNames = options.spawnToolNames;
    this.knownToolNames = options.knownToolNames;
    this.view = new FileSessionManagerView(this.coreSessionFile, this.sessionCwd);
    this.localSettings = SettingsManager.create(this.sessionCwd, options.agentDir ?? getAgentDir());
  }

  /** Wire the wrapper in after it exists; registers the child-UI subprotocol handlers. */
  attachUiRelay(relay: UiRelayTarget): void {
    this.uiRelay = relay;
    const client: PiRpcClient = this.rpc;
    for (const method of DIALOG_METHODS) {
      this.offUiRelay.push(client.onUi(method, (record) => {
        if (!this.uiRelay) return { cancelled: true };
        // A relay failure (Stop, wrapper gone) must still answer the child.
        return this.uiRelay.relayExternalUiRequest(record).catch(() => ({ cancelled: true }));
      }));
    }
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      this.offUiRelay.push(client.onUi(method, (record) => {
        this.uiRelay?.relayExternalUiEvent(record);
        return undefined;
      }));
    }
    // Anything the relay does not cover must not block the child.
  }

  dispose(): void {
    for (const off of this.offUiRelay.splice(0)) {
      try {
        off();
      } catch {
        // unsubscribe races are harmless at dispose
      }
    }
    this.uiRelay = undefined;
    super.dispose();
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

  get extensionRunner(): {
    getRegisteredCommands(): Array<{
      invocationName: string;
      description?: string;
      sourceInfo: SlashCommandInfo["sourceInfo"];
    }>;
    setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
    emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  } {
    return {
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

  // --- degraded tool listing ----------------------------------------------

  getAllTools(): ToolInfo[] {
    return this.knownToolNames.map((name) => ({
      name,
      description: "",
      exposure: "direct" as const,
    }));
  }

  getActiveToolNames(): string[] {
    return this.spawnToolNames ?? [...this.knownToolNames];
  }

  setActiveToolsByName(names: string[]): void {
    void names;
    // Tool changes respawn the child (the factory restarts the session with
    // new --tools args); there is no live-switch command in pi 1.4.0.
    throw new Error("Tool changes on the pi CLI engine restart the session; use the session factory");
  }

  // --- commands cache ------------------------------------------------------

  /** Refresh the get_commands-backed views; called by the factory after spawn. */
  async refreshCommands(): Promise<void> {
    const result = await this.rpc.command<GetCommandsResult>("get_commands", {}, 60_000);
    this.commandsCache = Array.isArray(result?.commands) ? result.commands : [];
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
    // get_state reports no autoRetryEnabled field, so the initial value is
    // unverified: true keeps the UI from reporting a disabled retry while the
    // first auto_retry_start/auto_retry_end events (or a set_auto_retry)
    // correct it from the event stream.
    autoRetryEnabled: true,
    retryAttempt: 0,
    messageCount: 0,
    pendingMessageCount: 0,
    steeringQueue: [],
    followUpQueue: [],
    ...state,
  };
}
