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

import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionWrapper } from "../rpc-manager";
import type { SessionEntry } from "../types";
import { getLatestModelChange, getLatestResponseModel } from "../session-reader";
import { appendSessionToolSelection, readSessionToolSelection, validateSessionToolSelection } from "../session-tool-selection";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { resolveShellTools } from "../powershell-settings";
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
  /** Skip reading a persisted pin (the caller already resolved selection). */
  resolvedToolNames?: string[] | undefined;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Absolute path of the pi CLI executable. */
  executable: string;
  /** Overrides ~/.pi/agent for settings (tests pass a sandbox). */
  agentDir?: string;
  /**
   * Session storage directory for a NEW session (defaults to
   * ~/.pi/agent/sessions/<encoded-cwd>/). Tests pass a sandbox dir so their
   * sessions never enter the real store the session list reads.
   */
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  /** Completion notifications (startRpcSession wires notifySessionComplete). */
  onAgentRunComplete?: (sessionId: string) => void;
  /**
   * Registration hook for the live path (startRpcSession): when present the
   * factory hands the wrapper over instead of starting it itself —
   * registerRpcWrapper() owns wrapper.start().
   */
  registerWrapper?: (wrapper: AgentSessionWrapper, realSessionId: string) => void;
  /**
   * A chat-only pin (no tools, no extensions/skills/templates/themes, the
   * exact prompt from the session's context files). The factory writes the
   * prompt to a temp file and passes --system-prompt <path>.
   */
  chatOnlyExactPrompt?: string;
  /** Whether the wrapper should adopt the chat-only policy (no tools UI). */
  chatOnly?: boolean;
}

export interface StartedCliSession {
  core: CliAgentSessionCore;
  wrapper: AgentSessionWrapper;
  realSessionId: string;
  sessionFile: string;
}

/** App-shell vars that repoint the SDK's module resolution at the packaged app. */
const STRIP_ENV_KEYS = ["PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", "JITI_ALIAS"];

/**
 * The bridge extension shipped next to the server code. The server root is
 * the process cwd in both dev and the desktop layout; an env override keeps
 * unusual embeds workable.
 */
export function resolveBridgeExtensionPath(): string {
  if (process.env.PI_WEB_BRIDGE_EXTENSION) return process.env.PI_WEB_BRIDGE_EXTENSION;
  const candidates = [
    join(process.cwd(), "lib", "pi-rpc", "assets", "pi-web-bridge.mjs"),
    join(process.cwd(), "resources", "server", "lib", "pi-rpc", "assets", "pi-web-bridge.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `pi-web bridge extension not found (looked at ${candidates.join(", ")}); set PI_WEB_BRIDGE_EXTENSION`,
  );
}

export function buildCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The child's bash tool runs in this environment, so the host runtime
  // variables that lib/project-command-env.ts strips from `!` commands
  // (PORT, NODE_ENV, NEXT_*, PI_WEB_PASSWORD — the web password guards this
  // server and no project command needs it) must not reach it either. The
  // agent-bin PATH prepend is host-side only and stays out.
  const env = sanitizeProjectCommandEnvironment({ ...base });
  for (const key of STRIP_ENV_KEYS) delete env[key];
  return env;
}

/** The coding tool domain, mirroring rpc-manager's CODING_TOOL_NAMES. */
const CODING_TOOL_NAMES = [...PRESET_FULL, "powershell"];
const CODING_TOOL_SET = new Set(CODING_TOOL_NAMES);

/**
 * pi's relative tool syntax for a pinned selection: defaults, plus the
 * selected coding tools, minus the rest of the coding domain. Extension and
 * MCP tools keep whatever the child's defaults gave them.
 *
 * `defaultTools` is the settings.json list the shell mapping reads (the
 * powershell switch maps a selected `bash` onto `powershell`), mirroring
 * resolveActiveToolNames() on the in-process engine. Every coding tool —
 * bash AND powershell — gets an explicit +/- so an unselected shell can never
 * survive through the child's defaults.
 */
export function buildToolArgs(selection: readonly string[], defaultTools?: readonly string[]): string[] {
  return ["--tools", buildToolEntries(selection, defaultTools).join(",")];
}

/** The selection after the shell mapping — what the child actually runs. */
export function resolveSpawnToolNames(selection: readonly string[], defaultTools?: readonly string[]): string[] {
  return buildToolEntries(selection, defaultTools)
    .filter((entry) => entry.startsWith("+"))
    .map((entry) => entry.slice(1));
}

function buildToolEntries(selection: readonly string[], defaultTools?: readonly string[]): string[] {
  const selected = new Set(
    resolveShellTools(
      selection.filter((name) => CODING_TOOL_SET.has(name)),
      defaultTools,
    ),
  );
  // An empty selection (chat-only) is rejected by startCliRpcSession before
  // this point; M3 maps it onto --no-tools (which also drops extension tools,
  // unlike --no-builtin-tools).
  return CODING_TOOL_NAMES.map((name) => (selected.has(name) ? `+${name}` : `-${name}`));
}

/**
 * The pi CLI executable the session engine spawns: PI_CLI_BIN (dev/tests,
 * highest precedence), the packaged resources location, then PATH.
 */
export function resolvePiExecutable(): string {
  if (process.env.PI_CLI_BIN && existsSync(process.env.PI_CLI_BIN)) return process.env.PI_CLI_BIN;
  const packaged = [
    join(process.cwd(), "resources", "pi", process.platform === "win32" ? "pi.exe" : "pi"),
    join(process.cwd(), "pi", process.platform === "win32" ? "pi.exe" : "pi"),
  ].find((candidate) => existsSync(candidate));
  if (packaged) return packaged;
  return "pi"; // resolved from PATH by the spawn itself
}

function writeExactPromptFile(prompt: string): string {
  const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const file = join(tmpdir(), `pi-web-exact-prompt-${hash}.txt`);
  if (!existsSync(file)) writeFileSync(file, prompt, "utf8");
  return file;
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
    manager = SessionManager.open(options.sessionFile, options.sessionDir);
  } else {
    if (!options.cwd) throw new Error("startCliRpcSession: cwd is required for a new session");
    manager = SessionManager.create(
      options.cwd,
      options.sessionDir,
      options.parentSession ? { parentSession: options.parentSession } : undefined,
    );
  }
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const persistedToolNames = readSessionToolSelection(entries);
  const requested = options.resolvedToolNames !== undefined ? options.resolvedToolNames : requestedToolNames;
  const selection = persistedToolNames ?? requested;
  // An empty selection is the chat-only pin; it needs the exact prompt. A
  // rejected start must not touch the disk, so the validation stays here.
  if (selection !== undefined && selection.length === 0 && !options.chatOnlyExactPrompt) {
    throw new Error("An empty tool pin needs the exact prompt (chat-only sessions)");
  }
  if (persistedToolNames === undefined && requested !== undefined) {
    // A pinned selection arriving for an unpinned session is persisted
    // before the child opens the file, exactly like startRpcSession.
    appendSessionToolSelection(manager, requested);
  }
  return startCliRpcSessionFromManager(manager, options, selection);
}

/**
 * The spawn half for callers that already own the session manager
 * (startRpcSession routes project sessions here after its own policy work).
 * `selection` is the effective pinned selection (persisted pin wins).
 */
export async function startCliRpcSessionFromManager(
  manager: SessionManager,
  options: StartCliSessionOptions,
  selection: string[] | undefined,
): Promise<StartedCliSession> {
  const { executable } = options;
  if (!executable) throw new Error("startCliRpcSession: executable is required");
  const sessionFile = ensureSessionFile(manager);
  const sessionCwd = manager.getCwd();

  // 2. Spawn args.
  const args: string[] = ["--session", sessionFile];
  // Keep the child's own session storage (/new, /branch, fork targets) on the
  // same dir pi-web chose — otherwise the child reverts to the global store.
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.chatOnlyExactPrompt !== undefined) {
    // The chat-only pin mirrors CHAT_ONLY_RESOURCE_LOADER_OPTIONS: no tools,
    // no discoverable resources, and the exact prompt (built from the
    // session's context files) replaces pi's own — so context files must not
    // be added a second time. The bridge stays: navigate/reload remain live.
    args.push(
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt", writeExactPromptFile(options.chatOnlyExactPrompt),
    );
  }
  // The bridge owns tree navigation and reload inside the child; without it
  // the wrapper's navigate_tree would send literal command text to the model.
  args.push("--extension", resolveBridgeExtensionPath());
  // The shell mapping reads the same settings.json the in-process engine
  // reads (resolveActiveToolNames), so a pinned `bash` follows the powershell
  // switch instead of enabling both shells.
  const settings = SettingsManager.create(sessionCwd, options.agentDir ?? getAgentDir());
  // A chat-only pin has NO tools active; otherwise the shell-mapped selection.
  const spawnToolNames = options.chatOnlyExactPrompt !== undefined
    ? []
    : selection === undefined
      ? undefined
      : resolveSpawnToolNames(selection, settings.getDefaultTools());
  if (selection !== undefined && options.chatOnlyExactPrompt === undefined) {
    args.push(...buildToolArgs(selection, settings.getDefaultTools()));
  }
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);

  const client = new PiRpcClient(executable, {
    args,
    cwd: sessionCwd,
    env: buildCliEnv({
      ...(options.agentDir ? ({ PI_CODING_AGENT_DIR: options.agentDir } as Record<string, string>) : {}),
      ...(options.env ?? {}),
    } as NodeJS.ProcessEnv),
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
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      // Post-mapping names: the picker must show the shell the child actually
      // runs (bash → powershell under the switch), and the coding domain
      // includes powershell so both shells are listed.
      spawnToolNames,
      knownToolNames: CODING_TOOL_NAMES,
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    });
    await core.refreshState();
    await core.refreshCommands();
    // The bridge is load-bearing (navigate/reload go through it); a missing
    // command means the extension failed to load, and the literal command
    // text would reach the model. Fail the session instead.
    if (!core.hasBridgeCommand("pi-web:navigate")) {
      throw new Error("pi-web bridge extension did not register its commands; refusing to start the session");
    }

    // 4. Restore the saved model unless the child already runs it. pi-web's
    // in-process engine only restores a model the user can authenticate; the
    // child stays on its default when set_model fails, which mirrors that.
    const savedModel = getLatestModelChange(manager.getEntries() as unknown as SessionEntry[])
      ?? getLatestResponseModel(manager.getEntries() as unknown as SessionEntry[]);
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
    const wrapper = new AgentSessionWrapper(core as unknown as AgentSessionLike, {
      noLiveToolSwitch: true,
      ...(options.chatOnly ? { chatOnly: true } : {}),
      ...(options.chatOnlyExactPrompt !== undefined
        ? { exactSystemPrompt: () => options.chatOnlyExactPrompt! }
        : {}),
      ...(options.onAgentRunComplete ? { onAgentRunComplete: options.onAgentRunComplete } : {}),
    });
    core.attachUiRelay({
      relayExternalUiRequest: (request) => wrapper.relayExternalUiRequest(request as never),
      relayExternalUiEvent: (event) => wrapper.relayExternalUiEvent(event as never),
    });
    if (options.registerWrapper) {
      // The live path (startRpcSession) owns start() through registerRpcWrapper.
      options.registerWrapper(wrapper, core.sessionId);
    } else {
      wrapper.start();
    }

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
