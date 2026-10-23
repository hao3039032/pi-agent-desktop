/**
 * The session factory for the pi CLI RPC engine: builds the child process,
 * the CliAgentSessionCore and the real AgentSessionWrapper around it, the
 * way `startRpcSession()` builds the in-process engine (M1 scope: normal
 * project sessions; chats, subagent children and chat-only pins stay on the
 * in-process path until their milestones).
 *
 * File ownership: pi-web creates the session file (its id, cwd,
 * parentSession, pinned tool selection), then the child opens it with
 * `--session <path>` and appends the conversation. Both sides read fresh
 * from disk; pi-web appends only while no run is active.
 *
 * Tool selection maps onto spawn args with pi's relative syntax: the
 * defaults plus the pinned coding tools minus the remaining coding tools,
 * so extension and MCP tools the child registered stay available — the same
 * shape `resolveActiveToolNames()` produces for the in-process engine.
 *
 * Project trust needs no flag: pi-web and the CLI share `trust.json`, so
 * the child honours the decision the pi-web trust dialog saved.
 */

import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper } from "../rpc-manager";
import type { SessionEntry } from "../types";
import { getLatestModelChange, getLatestResponseModel } from "../session-reader";
import { appendSessionToolSelection, readSessionToolSelection, validateSessionToolSelection } from "../session-tool-selection";
import { PRESET_FULL } from "../tool-presets";
import { PiRpcClient } from "./client";
import { CliAgentSessionCore, ensureSessionFile, initialCoreState } from "./core";
import type { AgentSessionLike } from "../pi-types";

export interface StartCliSessionOptions {
  /** pi-web's registry key (the URL session id), not the child's session id. */
  sessionId: string;
  /** Existing session file to resume; mutually exclusive with cwd. */
  sessionFile?: string;
  /** Working folder for a new session; required when sessionFile is absent. */
  cwd?: string;
  /** Parent session file recorded in a fork's header. */
  parentSession?: string;
  /** Pinned tool selection for a new session (built-in names only). */
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Absolute path of the pi CLI executable. */
  executable: string;
  /** Overrides ~/.pi/agent for settings (tests pass a sandbox). */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}

export interface StartedCliSession {
  core: CliAgentSessionCore;
  wrapper: AgentSessionWrapper;
  realSessionId: string;
  sessionFile: string;
}

/** App-shell vars that repoint the SDK's module resolution at the packaged app. */
const STRIP_ENV_KEYS = ["PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", "JITI_ALIAS"];

export function buildCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIP_ENV_KEYS) delete env[key];
  return env;
}

/**
 * pi's relative tool syntax for a pinned selection: defaults, plus the
 * selected coding tools, minus the rest of the coding preset. Extension and
 * MCP tools keep whatever the child's defaults gave them.
 */
export function buildToolArgs(selection: readonly string[]): string[] {
  if (selection.length === 0) return ["--no-builtin-tools"];
  const selected = new Set(selection);
  const entries: string[] = [];
  for (const name of PRESET_FULL) {
    entries.push(selected.has(name) ? `+${name}` : `-${name}`);
  }
  return ["--tools", entries.join(",")];
}

export async function startCliRpcSession(options: StartCliSessionOptions): Promise<StartedCliSession> {
  const { executable } = options;
  if (!executable) throw new Error("startCliRpcSession: executable is required");
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);

  // 1. The session file: pi-web owns header and custom entries.
  let manager: SessionManager;
  if (options.sessionFile) {
    manager = SessionManager.open(options.sessionFile, undefined);
  } else {
    if (!options.cwd) throw new Error("startCliRpcSession: cwd is required for a new session");
    manager = SessionManager.create(
      options.cwd,
      undefined,
      options.parentSession ? { parentSession: options.parentSession } : undefined,
    );
  }
  const sessionCwd = manager.getCwd();
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const persistedToolNames = readSessionToolSelection(entries);
  const selection = persistedToolNames ?? requestedToolNames;
  if (persistedToolNames === undefined && requestedToolNames !== undefined && options.sessionFile) {
    // A pinned selection arriving for an existing unpinned session is
    // persisted before the child opens the file, exactly like startRpcSession.
    appendSessionToolSelection(manager, requestedToolNames);
  } else if (persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(manager, requestedToolNames);
  }
  if (selection !== undefined && selection.length === 0) {
    throw new Error("Chat-only tool pins are not supported on the pi CLI engine yet (M3)");
  }
  const sessionFile = ensureSessionFile(manager);

  // 2. Spawn args.
  const args: string[] = ["--session", sessionFile];
  if (selection !== undefined) args.push(...buildToolArgs(selection));
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);

  const client = new PiRpcClient(executable, {
    args,
    cwd: sessionCwd,
    env: options.env ?? buildCliEnv(),
    onLog: (line) => options.onLog?.(line),
    onExit: (code) => {
      options.onLog?.(`[pi-rpc] child exited (code ${code ?? "?"})`);
    },
  });

  try {
    // 3. Handshake; the child must have adopted OUR session file.
    const state = await client.command<{ sessionId?: string; sessionFile?: string }>("get_state", {}, 90_000);
    const header = manager.getHeader();
    if (state.sessionId && header?.id && state.sessionId !== header.id) {
      throw new Error(
        `pi child opened session ${state.sessionId} instead of ${header.id}; refusing to run a stray session`,
      );
    }

    const core = new CliAgentSessionCore({
      client,
      initialState: initialCoreState(state),
      sessionFile,
      cwd: sessionCwd,
      spawnToolNames: selection,
      knownToolNames: PRESET_FULL,
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    });
    await core.refreshState();
    await core.refreshCommands();

    // 4. Restore the saved model unless the child already runs it. pi-web's
    // in-process engine only restores a model the user can authenticate; the
    // child stays on its default when set_model fails, which mirrors that.
    const savedModel = getLatestModelChange(entries) ?? getLatestResponseModel(entries);
    const wanted = savedModel ?? (options.initialModel ?? null);
    if (wanted) {
      const current = core.model;
      if (!current || current.provider !== wanted.provider || current.id !== wanted.modelId) {
        await applyModel(core, wanted.provider, wanted.modelId, options.onLog);
      }
    }

    // 5. The wrapper over the RPC core, with the UI relay wired in.
    // M1 bridge: the wrapper consumes AgentSessionLike; the core satisfies
    // it structurally (every member it reads is implemented). The assertion
    // collapses when the wrapper's consumption narrows in M2.
    const wrapper = new AgentSessionWrapper(core as unknown as AgentSessionLike, {});
    core.attachUiRelay({
      relayExternalUiRequest: (request) => wrapper.relayExternalUiRequest(request as never),
      relayExternalUiEvent: (event) => wrapper.relayExternalUiEvent(event as never),
    });
    wrapper.start();

    return {
      core,
      wrapper,
      realSessionId: core.sessionId,
      sessionFile,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function applyModel(
  core: CliAgentSessionCore,
  provider: string,
  modelId: string,
  onLog?: (line: string) => void,
): Promise<void> {
  try {
    let model = core.modelRuntime.getModel(provider, modelId);
    if (!model) {
      await core.modelRuntime.refresh({ allowNetwork: false });
      model = core.modelRuntime.getModel(provider, modelId);
    }
    if (!model) {
      onLog?.(`[pi-rpc] saved model ${provider}/${modelId} is not configured; keeping the child's default`);
      return;
    }
    await core.setModel(model);
  } catch (error) {
    onLog?.(`[pi-rpc] restoring model ${provider}/${modelId} failed: ${error instanceof Error ? error.message : String(error)}; keeping the child's default`);
  }
}

/** Convenience for tests and the future M2 wiring: agentDir resolution. */
export function defaultAgentDir(): string {
  return getAgentDir();
}
