import { isMcpEntryRefusal, readConnectableMcpBody, type McpConnectableEntry } from "./mcp-entry-request";
import { McpServiceError } from "./mcp-service.server";
import { runsShellCommand, testMcpServer } from "./mcp-test";
import { mcpOAuthStoreKeys, mcpOAuthUrl, mcpSignOutCount, McpCredentialAdmissionError } from "./mcp-sign-out";
import { McpProbeCredentialFence } from "./mcp-probe-receipt";

type ProbeRequest = { body: unknown; agentDir: string; allowedRoots: Set<string> };

async function readProbeEntry(options: ProbeRequest): Promise<McpConnectableEntry> {
  const entry = await readConnectableMcpBody(options.body, options);
  if (isMcpEntryRefusal(entry)) {
    const { error, reason, ...params } = entry.body;
    throw new McpServiceError(entry.status, reason, error, params);
  }
  return entry;
}

function probeTarget(entry: McpConnectableEntry) {
  const { config, internals, name, configKey } = entry;
  const url = mcpOAuthUrl(config);
  const broad = !("url" in config) || Boolean(config.auth) || runsShellCommand(config, internals);
  const kind = broad ? "broad" as const : url === undefined ? "http-no-mcp-oauth" as const : "mcp-oauth" as const;
  if (url === undefined) return { schema: 1 as const, probeAdmissionSchema: 1 as const, kind, configKey };
  const { key: canonicalKey, legacyKey } = mcpOAuthStoreKeys(name, url);
  return { schema: 1 as const, probeAdmissionSchema: 1 as const, kind, configKey, canonicalKey, legacyKey, generation: mcpSignOutCount(canonicalKey) };
}

/** Host-only preflight: validated disk entry, no connection or command execution. */
export async function managedMcpProbeTarget(options: ProbeRequest) {
  return probeTarget(await readProbeEntry(options));
}

/** A host-authorized connection probe; the entry itself always comes from disk. */
export async function probeMcpServer(options: {
  body: unknown;
  agentDir: string;
  allowedRoots: Set<string>;
  signal?: AbortSignal;
  credentialAdmission?: unknown;
  probeAdmission?: unknown;
}) {
  const entry = await readProbeEntry(options);
  const { scope, name, sourcePath, configKey, config, cwd, internals } = entry;
  const target = probeTarget(entry);
  const admission = options.probeAdmission;
  if (admission !== undefined) {
    if (typeof admission !== "object" || admission === null || Array.isArray(admission)) throw new McpServiceError(409, "invalid-request", "MCP probe admission is invalid or stale");
    const given = admission as Record<string, unknown>;
    if (given.schema !== 1 || given.kind !== target.kind || given.configKey !== target.configKey) {
      throw new McpServiceError(409, "invalid-request", "MCP probe admission is invalid or stale");
    }
  }
  const fence = admission === undefined ? undefined : new McpProbeCredentialFence();
  try {
    const credentialAdmission = admission !== undefined && mcpOAuthUrl(config) !== undefined ? admission : options.credentialAdmission;
    const result = await testMcpServer({ scope, name, sourcePath, configKey, config, cwd }, internals, { signal: options.signal, credentialAdmission, probeFence: fence });
    const receipt = fence?.close();
    if (receipt && target.kind === "broad") receipt.remoteToken = "unknown";
    return { scope, name, configKey, result, ...(receipt ? { _probeReceipt: receipt } : {}) };
  } catch (error) {
    if (error instanceof McpCredentialAdmissionError) throw new McpServiceError(409, "invalid-request", error.message);
    throw error;
  } finally {
    fence?.close();
  }
}
