import { isMcpDisabledByOperator } from "./builtin-extensions";
import { isMcpEntryRefusal, mcpProjectTrustRefusal, readConnectableMcpBody } from "./mcp-entry-request";
import { McpServiceError } from "./mcp-service.server";
import { signInMcpWithHostedCallback, type McpHostedCallbackFactory } from "./mcp-oauth-hosted.server";
export { McpOAuthBroker } from "./mcp-oauth-broker.server";
import {
  cancelMcpSignIn,
  createMcpSignInDeps,
  mcpOAuthUrl,
  mcpSignInCompletion,
  pasteMcpSignInRedirect,
  readMcpSignIn,
  startMcpSignIn,
} from "./mcp-sign-in";

/** Start against a disk entry checked with the host's authorized roots. */
export async function startManagedMcpSignIn(options: { body: unknown; agentDir: string; allowedRoots: Set<string>; callbackFactory?: McpHostedCallbackFactory }) {
  const entry = await readConnectableMcpBody(options.body, options);
  if (isMcpEntryRefusal(entry)) {
    const { error, reason, ...params } = entry.body;
    throw new McpServiceError(entry.status, reason, error, params);
  }
  const { scope, name, sourcePath, configKey, config, cwd, project, agentDir, internals } = entry;
  const url = mcpOAuthUrl(config);
  if (url === undefined) throw new McpServiceError(409, "sign-in-not-oauth", `MCP server "${name}" does not use OAuth: only an HTTP server without an Authorization header does`, { name });
  const mayConnect = () => !isMcpDisabledByOperator()
    && (scope !== "project" || !project || mcpProjectTrustRefusal(project.cwd, agentDir) === undefined);
  const deps = createMcpSignInDeps(internals);
  if (options.callbackFactory) {
    const factory = options.callbackFactory;
    deps.signIn = (request, signal) => signInMcpWithHostedCallback(request, factory, signal);
  }
  const { flow, joined } = startMcpSignIn({ scope, name, sourcePath, configKey, config, cwd, url, mayConnect }, deps);
  return { ...flow, ...(joined ? { joined: true as const } : {}) };
}

const UNKNOWN = "No sign-in has that id: it ended over a minute ago, or Pi Web restarted";

export function waitManagedMcpSignIn(flowId: string): Promise<void> {
  const completion = mcpSignInCompletion(flowId);
  if (!completion) throw new McpServiceError(404, "sign-in-unknown", UNKNOWN);
  return completion;
}

export function readManagedMcpSignIn(flowId: string) {
  const flow = readMcpSignIn(flowId);
  if (!flow) throw new McpServiceError(404, "sign-in-unknown", UNKNOWN);
  return flow;
}

export function submitManagedMcpSignIn(flowId: string, redirectUrl: unknown) {
  const result = pasteMcpSignInRedirect(flowId, redirectUrl);
  if (!result.ok) throw new McpServiceError(result.status, result.reason, result.error);
  return result.flow;
}

export function cancelManagedMcpSignIn(flowId: string) {
  const flow = cancelMcpSignIn(flowId);
  if (!flow) throw new McpServiceError(404, "sign-in-unknown", UNKNOWN);
  return flow;
}
