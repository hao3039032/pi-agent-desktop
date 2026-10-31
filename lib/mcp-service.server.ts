import { getAgentDir, type McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  McpActionItemResult,
  McpActionResponse,
  McpErrorResponse,
  McpRefusalReason,
  McpResponse,
  McpScope,
  McpServerRef,
  ProjectMcpListing,
  ProjectTrustStatus,
} from "./api-types";
import {
  insertMcpServer,
  isMcpConfigWriteError,
  removeMcpServer,
  setMcpServerExposure,
  setMcpServersEnabled,
  type McpConfigFileTarget,
  type McpEnabledOutcome,
} from "./mcp-config-file";
import {
  MCP_ADD_MAX_TEXT,
  prepareMcpAdd,
  readMcpAddSecretReferences,
  readMcpAddValues,
  type McpAddRefusal,
  type McpAddRequest,
} from "./mcp-add";
import {
  readMcpOverview,
  readMcpServerConfigs,
  readMcpServerEntry,
  readProjectMcpServers,
} from "./mcp-config-read";
import {
  isMcpEntryRefusal,
  mcpInternalsOrRefusal,
  mcpProjectTrustRefusal,
  validateMcpProject,
  type McpEntryRefusal,
} from "./mcp-entry-request";
import { MCP_EXPOSURES, isMcpExposure, suggestFreeName } from "./mcp-import";
import { mcpOAuthUrl, signOutMcpServer } from "./mcp-sign-in";
import { forgetMcpEntryStatuses } from "./mcp-status";
import { findWebPasswordField } from "./mcp-transport";
import { holdRemovedEntry, returnRemovedEntry, takeRemovedEntry } from "./mcp-undo";
import type { PiSdkInternals } from "./pi-sdk-internals";
import { invalidateModelsCache } from "./models-cache";
import {
  freshFolderTrustBreadth,
  getProjectTrustStatus,
  trustFreshFolderAndWrite,
  trustProject,
} from "./project-trust";
import { resolveRealRoots } from "./path-security";
import { getAllowedFileRoots } from "./file-access";

export class McpServiceError extends Error {
  readonly status: number;
  readonly reason: McpRefusalReason;
  readonly params: Record<string, unknown>;

  constructor(status: number, reason: McpRefusalReason, message: string, params: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpServiceError";
    this.status = status;
    this.reason = reason;
    this.params = params;
  }

  toResponse(): McpErrorResponse {
    return {
      error: this.message,
      reason: this.reason,
      ...this.params,
    };
  }
}

type Project = { cwd: string; allowedRoots: Set<string> };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScope(value: unknown): McpScope | undefined {
  return value === "global" || value === "project" ? value : undefined;
}

function readName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : undefined;
}

const MAX_BULK_SERVERS = 500;

function readServerList(value: unknown): McpServerRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_SERVERS) return undefined;
  const servers = new Map<string, McpServerRef>();
  for (const item of value) {
    const scope = isRecord(item) ? readScope(item.scope) : undefined;
    const name = isRecord(item) ? readName(item.name) : undefined;
    if (!scope || name === undefined) return undefined;
    servers.set(`${scope}\0${name}`, { scope, name });
  }
  return [...servers.values()];
}

async function validateProject(value: unknown, allowedRoots?: Set<string>): Promise<Project> {
  const result = await validateMcpProject(value, allowedRoots);
  if (isMcpEntryRefusal(result)) {
    const { error, reason, ...params } = result.body;
    throw new McpServiceError(result.status, reason, error, params);
  }
  return result;
}

function writeTarget(scope: McpScope, project: Project | undefined, agentDir: string): McpConfigFileTarget {
  if (scope === "global") return { scope: "global", agentDir };
  if (!project) throw new McpServiceError(400, "invalid-request", "A project server needs the project's cwd");
  const refused = mcpProjectTrustRefusal(project.cwd, agentDir, "The project is not trusted, so its .pi/mcp.json is not changed");
  if (refused) {
    const { error, reason, ...params } = refused.body;
    throw new McpServiceError(refused.status, reason, error, params);
  }
  return { scope: "project", cwd: project.cwd, allowedRoots: project.allowedRoots };
}

function writeErrorToMcpServiceError(error: unknown): McpServiceError {
  if (isMcpConfigWriteError(error)) {
    const params = { path: error.path, ...(error.serverName !== undefined ? { name: error.serverName } : {}) };
    if (error.reason === "unreadable") return new McpServiceError(500, "internal", error.message, params);
    return new McpServiceError(409, error.reason, error.message, params);
  }
  if (error instanceof McpServiceError) return error;
  return new McpServiceError(500, "internal", errorMessage(error));
}

async function mcpWritable(): Promise<PiSdkInternals> {
  const internals = await mcpInternalsOrRefusal("changes no MCP server");
  if (isMcpEntryRefusal(internals)) {
    const { error, reason, ...params } = internals.body;
    throw new McpServiceError(internals.status, reason, error, params);
  }
  return internals;
}

function webPasswordRefusal(internals: PiSdkInternals) {
  return (_name: string, entry: Record<string, unknown>) => (findWebPasswordField(entry, internals) ? ("web-password" as const) : undefined);
}

function outcomeRefusal(outcome: McpEnabledOutcome<"web-password">, path: string): McpServiceError | undefined {
  const name = outcome.name;
  switch (outcome.outcome) {
    case "missing":
      return new McpServiceError(409, "server-missing", `${path} does not define MCP server "${name}"`, { path, name });
    case "not-an-object":
      return new McpServiceError(409, "entry-not-object", `${path} defines MCP server "${name}" as something other than an object, so it has nothing to switch`, { path, name });
    case "refused":
      return new McpServiceError(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not turn it on`, { name });
    default:
      return undefined;
  }
}

async function buildOverview(
  agentDir: string,
  project: Project | undefined,
  extra: Omit<McpActionResponse, keyof McpResponse> = {},
): Promise<McpActionResponse> {
  const overview = await readMcpOverview({ agentDir, project });
  return { ...overview, ...extra };
}

async function switchServer(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  server: McpServerRef,
  enabled: boolean,
): Promise<McpActionResponse> {
  const target = writeTarget(server.scope, project, agentDir);
  try {
    const {
      value: [outcome],
      path,
    } = await setMcpServersEnabled(
      target,
      [server.name],
      enabled,
      enabled ? webPasswordRefusal(internals) : undefined,
    );
    const refused = outcomeRefusal(outcome, path);
    if (refused) throw refused;
  } catch (error) {
    throw writeErrorToMcpServiceError(error);
  }
  return buildOverview(agentDir, project);
}

async function setServerExposure(
  agentDir: string,
  project: Project | undefined,
  server: McpServerRef,
  exposure: McpExposure,
): Promise<McpActionResponse> {
  const target = writeTarget(server.scope, project, agentDir);
  try {
    const { value: outcome, path } = await setMcpServerExposure(target, server.name, exposure);
    const refused = outcomeRefusal(outcome, path);
    if (refused) throw refused;
  } catch (error) {
    throw writeErrorToMcpServiceError(error);
  }
  return buildOverview(agentDir, project);
}

async function switchServers(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  servers: McpServerRef[],
  enabled: boolean,
): Promise<McpActionResponse> {
  const results = new Map<string, McpActionItemResult>();
  const key = (server: McpServerRef) => `${server.scope}\0${server.name}`;
  for (const scope of ["global", "project"] as const) {
    const group = servers.filter((server) => server.scope === scope);
    if (group.length === 0) continue;
    let target: McpConfigFileTarget;
    try {
      target = writeTarget(scope, project, agentDir);
    } catch (err) {
      if (err instanceof McpServiceError) {
        for (const server of group) results.set(key(server), { ...server, error: err.message, reason: err.reason });
        continue;
      }
      throw err;
    }
    try {
      const { value: outcomes, path } = await setMcpServersEnabled(
        target,
        group.map((server) => server.name),
        enabled,
        enabled ? webPasswordRefusal(internals) : undefined,
      );
      for (const outcome of outcomes) {
        const server = { scope, name: outcome.name };
        const ref = outcomeRefusal(outcome, path);
        results.set(key(server), ref ? { ...server, error: ref.message, reason: ref.reason } : server);
      }
    } catch (error) {
      const failure = writeErrorToMcpServiceError(error);
      for (const server of group) results.set(key(server), { ...server, error: failure.message, reason: failure.reason });
    }
  }
  return buildOverview(agentDir, project, { results: servers.map((server) => results.get(key(server)) ?? server) });
}

async function removeServer(
  agentDir: string,
  project: Project | undefined,
  server: McpServerRef,
): Promise<McpActionResponse> {
  const target = writeTarget(server.scope, project, agentDir);
  let removed: Awaited<ReturnType<typeof removeMcpServer>>;
  try {
    removed = await removeMcpServer(target, server.name);
  } catch (error) {
    throw writeErrorToMcpServiceError(error);
  }
  const { token, expiresAt } = holdRemovedEntry({
    ...server,
    path: removed.path,
    ...(target.scope === "project" ? { cwd: target.cwd } : {}),
    entry: removed.value.entry,
    index: removed.value.index,
  });
  return buildOverview(agentDir, project, {
    undo: { ...server, token, path: removed.path, expiresInMs: Math.max(0, expiresAt - Date.now()) },
  });
}

async function undoRemoval(
  agentDir: string,
  project: Project | undefined,
  token: string,
): Promise<McpActionResponse> {
  const held = takeRemovedEntry(token);
  if (!held) {
    throw new McpServiceError(410, "undo-unavailable", "Nothing to undo: the removal is unknown, already undone, or older than 60 seconds");
  }
  const server = { scope: held.scope, name: held.name };
  let failure: McpServiceError | undefined;
  try {
    let heldProject: Project | undefined;
    if (held.scope === "project") {
      heldProject = await validateProject(held.cwd);
    }
    const target = writeTarget(held.scope, heldProject, agentDir);
    await insertMcpServer(target, held.name, held.entry, held.index);
  } catch (error) {
    failure = isMcpConfigWriteError(error) && error.reason === "name-taken"
      ? new McpServiceError(409, "undo-name-taken", `${error.path} defines "${held.name}" again, so the removal is not undone`, {
          path: error.path,
          name: held.name,
        })
      : writeErrorToMcpServiceError(error);
  }
  if (failure) {
    returnRemovedEntry(held);
    throw failure;
  }
  return buildOverview(agentDir, project, { restored: server });
}

async function signOutServer(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  server: McpServerRef,
): Promise<McpActionResponse> {
  writeTarget(server.scope, project, agentDir);
  const { name } = server;
  const read = readMcpServerEntry({ agentDir, scope: server.scope, name, project });
  if (!read.ok) {
    const params = { path: read.path, ...(read.reason === "server-missing" ? { name } : {}) };
    if (read.reason === "unreadable") throw new McpServiceError(500, "internal", read.error, params);
    throw new McpServiceError(409, read.reason, read.error, params);
  }
  if (!isRecord(read.value)) {
    throw new McpServiceError(409, "entry-not-object", `${read.sourcePath} defines MCP server "${name}" as something other than an object`, { name });
  }
  const config = internals.validateMcpServerConfig(name, read.value);
  if (typeof config === "string") throw new McpServiceError(409, "server-invalid", config, { name });
  const url = mcpOAuthUrl(config);
  if (url === undefined) {
    throw new McpServiceError(409, "sign-in-not-oauth", `MCP server "${name}" does not use OAuth: only an HTTP server without an Authorization header does`, { name });
  }
  const removed = signOutMcpServer(name, url, agentDir, internals);
  forgetMcpEntryStatuses({ scope: server.scope, sourcePath: read.sourcePath, name });
  return buildOverview(agentDir, project, { signedOut: { ...server, removed } });
}

function namesInFile(agentDir: string, project: Project | undefined, scope: McpScope, internals: PiSdkInternals): string[] {
  try {
    const { servers } = readMcpServerConfigs({ agentDir, project: scope === "project" ? project : undefined, internals });
    return servers.filter((server) => server.scope === scope).map((server) => server.name);
  } catch {
    return [];
  }
}

function addRefusal({ status, reason, error, name, suggestedName, notes, names, fields }: McpAddRefusal): McpServiceError {
  return new McpServiceError(status, reason, error, {
    ...(name !== undefined ? { name } : {}),
    ...(suggestedName !== undefined ? { suggestedName } : {}),
    ...(notes ? { notes } : {}),
    ...(names ? { names } : {}),
    ...(fields ? { fields } : {}),
  });
}

function insertRefusal(
  error: unknown,
  agentDir: string,
  project: Project | undefined,
  scope: McpScope,
  internals: PiSdkInternals,
): McpServiceError {
  if (isMcpConfigWriteError(error) && error.reason === "name-taken" && error.serverName !== undefined) {
    const suggestedName = suggestFreeName(error.serverName, namesInFile(agentDir, project, scope, internals));
    return new McpServiceError(409, "name-taken", error.message, { path: error.path, name: error.serverName, suggestedName });
  }
  return writeErrorToMcpServiceError(error);
}

function readAddRequest(body: Record<string, unknown>): McpAddRequest {
  const scope = readScope(body.scope);
  const values = readMcpAddValues(body.values);
  const secretReferences = readMcpAddSecretReferences(body.secretReferences);
  const server = body.server === undefined ? 0 : body.server;
  const confirm = body.confirmHostEnv === undefined ? [] : body.confirmHostEnv;
  if (
    typeof body.text !== "string" || body.text.length > MCP_ADD_MAX_TEXT || !scope || !values || !secretReferences
    || typeof server !== "number" || !Number.isInteger(server) || server < 0
    || (body.name !== undefined && readName(body.name) === undefined)
    || (body.rawPi !== undefined && typeof body.rawPi !== "boolean")
    || (body.trustFolder !== undefined && typeof body.trustFolder !== "boolean")
    || !Array.isArray(confirm) || confirm.length > 100 || !confirm.every((name) => typeof name === "string")
  ) {
    throw new McpServiceError(400, "invalid-request", `add needs text (at most ${MCP_ADD_MAX_TEXT} characters), scope, and optionally values, secretReferences, server, name, rawPi, trustFolder and confirmHostEnv`);
  }
  return {
    text: body.text,
    values,
    secretReferences,
    server,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    scope,
    rawPi: body.rawPi === true,
    confirmHostEnv: confirm as string[],
  };
}

function trustAfterWrite(cwd: string, agentDir: string): ProjectTrustStatus | undefined {
  try {
    const status = getProjectTrustStatus(cwd, agentDir);
    return status.decisionError === undefined ? status : undefined;
  } catch {
    return undefined;
  }
}

async function addServer(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  body: Record<string, unknown>,
  onBeforeTrustWrite?: () => void,
): Promise<McpActionResponse> {
  const request = readAddRequest(body);
  const { scope } = request;
  if (scope === "project" && !project) throw new McpServiceError(400, "invalid-request", "A project server needs the project's cwd");
  const trustFolder = scope === "project" && body.trustFolder === true && project !== undefined;
  const target = trustFolder ? undefined : writeTarget(scope, project, agentDir);
  if (trustFolder && project) {
    const breadth = freshFolderTrustBreadth(project.cwd, { agentDir, knownFolders: project.allowedRoots });
    if (breadth) throw new McpServiceError(409, "trust-too-broad", `Trusting ${project.cwd} would also trust ${breadth.path}`, { breadth });
  }
  const prepared = prepareMcpAdd(request, { takenNames: namesInFile(agentDir, project, scope, internals), internals });
  if (!prepared.ok) throw addRefusal(prepared);
  const { name, entry } = prepared;

  if (trustFolder && project) {
    const projectTarget = { scope: "project" as const, cwd: project.cwd, allowedRoots: project.allowedRoots };
    const result = await trustFreshFolderAndWrite(
      project.cwd,
      agentDir,
      () => insertMcpServer(projectTarget, name, entry),
      { knownFolders: project.allowedRoots, onBeforeTrustWrite },
    );
    if (!result.ok) {
      switch (result.reason) {
        case "trust-too-broad":
          throw new McpServiceError(409, "trust-too-broad", result.error, { breadth: result.breadth });
        case "folder-not-fresh":
          throw new McpServiceError(409, "folder-not-fresh", result.error, result.status ? { trust: result.status } : {});
        case "trust-unreadable":
          throw new McpServiceError(409, "trust-unreadable", result.error);
        case "write-failed": {
          const failure = insertRefusal(result.writeError, agentDir, project, scope, internals);
          if (result.rollbackError === undefined) throw failure;
          throw new McpServiceError(failure.status, failure.reason, `${failure.message}; the folder stays trusted, since taking the trust back failed: ${result.rollbackError}`, {
            ...failure.params,
            trustKept: true,
            ...(result.status ? { trust: result.status } : {}),
          });
        }
      }
    }
    invalidateModelsCache();
    return buildOverview(agentDir, project, {
      added: { scope, name, path: result.value.path },
      trust: result.status,
      trustedFolder: true,
    });
  }

  if (!target) throw new McpServiceError(500, "internal", "No file to write to");
  let path: string;
  try {
    ({ path } = await insertMcpServer(target, name, entry));
  } catch (error) {
    throw insertRefusal(error, agentDir, project, scope, internals);
  }
  const trust = scope === "project" && project ? trustAfterWrite(project.cwd, agentDir) : undefined;
  return buildOverview(agentDir, project, { added: { scope, name, path }, ...(trust ? { trust } : {}) });
}

// ---------------------------------------------------------------------------
// Public exported API for both Next routes and Management extension
// ---------------------------------------------------------------------------

export async function getMcpConfig(options: {
  agentDir?: string;
  cwd?: string | null;
  allowedRoots?: Set<string>;
}): Promise<McpResponse> {
  const agentDir = options.agentDir ?? getAgentDir();
  let project: Project | undefined;
  if (options.cwd) {
    project = await validateProject(options.cwd, options.allowedRoots);
  }
  return readMcpOverview({ agentDir, project });
}

export async function executeMcpAction(options: {
  agentDir?: string;
  cwd?: string | null;
  allowedRoots?: Set<string>;
  body: Record<string, unknown>;
  onBeforeTrustWrite?: () => void;
}): Promise<McpActionResponse> {
  const agentDir = options.agentDir ?? getAgentDir();
  const body = options.body;
  if (!isRecord(body)) throw new McpServiceError(400, "invalid-request", "Expected a JSON object");

  let project: Project | undefined;
  const projectCwd = typeof body.cwd === "string" ? body.cwd : (typeof options.cwd === "string" ? options.cwd : undefined);
  if (projectCwd) {
    project = await validateProject(projectCwd, options.allowedRoots);
  }

  const internals = await mcpWritable();

  switch (body.action) {
    case "enable":
    case "disable":
    case "remove":
    case "sign-out": {
      const scope = readScope(body.scope);
      const name = readName(body.name);
      if (!scope || name === undefined) {
        throw new McpServiceError(400, "invalid-request", "scope must be \"global\" or \"project\", and name a server name");
      }
      if (body.action === "remove") return await removeServer(agentDir, project, { scope, name });
      if (body.action === "sign-out") return await signOutServer(agentDir, project, internals, { scope, name });
      return await switchServer(agentDir, project, internals, { scope, name }, body.action === "enable");
    }
    case "set-enabled": {
      const servers = readServerList(body.servers);
      if (typeof body.enabled !== "boolean" || !servers) {
        throw new McpServiceError(400, "invalid-request", `enabled must be a boolean, and servers a list of 1 to ${MAX_BULK_SERVERS} { scope, name }`);
      }
      return await switchServers(agentDir, project, internals, servers, body.enabled);
    }
    case "set-exposure": {
      const scope = readScope(body.scope);
      const name = readName(body.name);
      if (!scope || name === undefined || !isMcpExposure(body.exposure)) {
        throw new McpServiceError(400, "invalid-request", `scope must be "global" or "project", name a server name, and exposure one of ${MCP_EXPOSURES.join(", ")}`);
      }
      return await setServerExposure(agentDir, project, { scope, name }, body.exposure);
    }
    case "undo": {
      if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 100) {
        throw new McpServiceError(400, "invalid-request", "token must be the token a remove answered with");
      }
      return await undoRemoval(agentDir, project, body.token);
    }
    case "add":
      return await addServer(agentDir, project, internals, body, options.onBeforeTrustWrite);
    default:
      throw new McpServiceError(400, "invalid-request", "action must be add, enable, disable, remove, set-enabled, set-exposure, undo or sign-out");
  }
}

export async function getProjectMcpListing(options: {
  agentDir?: string;
  cwd: string;
  allowedRoots?: Set<string>;
}): Promise<ProjectMcpListing> {
  const agentDir = options.agentDir ?? getAgentDir();
  const allowedRoots = resolveRealRoots(options.allowedRoots ?? await getAllowedFileRoots());
  try {
    const { file, servers } = await readProjectMcpServers({
      agentDir,
      cwd: options.cwd,
      allowedRoots,
    });
    return { mcpFile: file, mcpServers: servers };
  } catch (error) {
    return { mcpServers: [], mcpError: errorMessage(error) };
  }
}

export async function trustProjectFolder(options: {
  agentDir?: string;
  cwd: string;
  onBeforeTrustWrite?: () => void;
}): Promise<ProjectTrustStatus> {
  const agentDir = options.agentDir ?? getAgentDir();
  const current = getProjectTrustStatus(options.cwd, agentDir);
  if (!current.requiresTrust) {
    throw new McpServiceError(409, "trust-not-required", "This project has no resources that require trust");
  }
  const status = trustProject(options.cwd, agentDir, options.onBeforeTrustWrite);
  invalidateModelsCache();
  return status;
}
