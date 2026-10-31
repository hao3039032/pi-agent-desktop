import { isMcpEntryRefusal, readConnectableMcpBody } from "./mcp-entry-request";
import { McpServiceError } from "./mcp-service.server";
import { testMcpServer } from "./mcp-test";

/** A host-authorized connection probe; the entry itself always comes from disk. */
export async function probeMcpServer(options: {
  body: unknown;
  agentDir: string;
  allowedRoots: Set<string>;
  signal?: AbortSignal;
}) {
  const entry = await readConnectableMcpBody(options.body, options);
  if (isMcpEntryRefusal(entry)) {
    const { error, reason, ...params } = entry.body;
    throw new McpServiceError(entry.status, reason, error, params);
  }
  const { scope, name, sourcePath, configKey, config, cwd, internals } = entry;
  const result = await testMcpServer({ scope, name, sourcePath, configKey, config, cwd }, internals, { signal: options.signal });
  return { scope, name, configKey, result };
}
