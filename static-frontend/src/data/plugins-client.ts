import type { PluginsResponse, PluginsBulkResponse, PluginScope, PluginUpdateResult } from "../../../lib/api-types";
import { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindPluginsClient(bound: IpcClient): void { client = bound; }
export async function checkPlugins(cwd: string, source?: string, scope?: PluginScope): Promise<PluginUpdateResult[]> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  const result = await client.request<{ updates: PluginUpdateResult[] }>("plugins.check", { cwd, source, scope }, { timeoutMs: 65_000 });
  return result.updates;
}
export function setPluginsEnabled(cwd: string, action: "enable" | "disable", packages: { source: string; scope: PluginScope }[], single = false): Promise<PluginsResponse | PluginsBulkResponse> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  return client.request("plugins.setEnabled", { cwd, action, packages, single }, { timeoutMs: 60_000 });
}
export function listPlugins(cwd: string): Promise<PluginsResponse> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  return client.request("plugins.list", { cwd }, { timeoutMs: 60_000 });
}
