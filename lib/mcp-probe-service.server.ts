import { isMcpEntryRefusal, readConnectableMcpBody } from "./mcp-entry-request";
import { McpServiceError } from "./mcp-service.server";
import { testMcpServer } from "./mcp-test";
import { McpCredentialAdmissionError } from "./mcp-sign-out";

/** A host-authorized connection probe; the entry itself always comes from disk. */
export async function probeMcpServer(options: {
  body: unknown;
  agentDir: string;
  allowedRoots: Set<string>;
  signal?: AbortSignal;
  credentialAdmission?: unknown;
}) {
  const entry = await readConnectableMcpBody(options.body, options);
  if (isMcpEntryRefusal(entry)) {
    const { error, reason, ...params } = entry.body;
    throw new McpServiceError(entry.status, reason, error, params);
  }
  const { scope, name, sourcePath, configKey, config, cwd, internals } = entry;
  try {
    const result = await testMcpServer({ scope, name, sourcePath, configKey, config, cwd }, internals, { signal: options.signal, credentialAdmission: options.credentialAdmission });
    return { scope, name, configKey, result };
  } catch (error) {
    if (error instanceof McpCredentialAdmissionError) throw new McpServiceError(409, "invalid-request", error.message);
    throw error;
  }
}
