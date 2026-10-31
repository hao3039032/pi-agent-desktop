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
export async function installPluginPackage(cwd: string, source: string, scope: PluginScope, signal: AbortSignal, onProgress: (phase: string) => void): Promise<PluginsResponse> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  const bound = client;
  if (signal.aborted) throw new Error("Installation cancelled before it started");
  const { handle } = await bound.request<{ handle: string }>("plugins.install.start", { cwd, source, scope });
  let cancellationSent = false;
  for (;;) {
    if (signal.aborted && !cancellationSent) {
      cancellationSent = true;
      await bound.request("plugins.install.cancel", { handle });
    }
    const task = await bound.request<{ status: string; progress?: { phase?: string }; result?: PluginsResponse; error?: string }>("plugins.install.status", { handle });
    if (task.progress?.phase) onProgress(task.progress.phase);
    if (task.status === "succeeded" && task.result) return task.result;
    if (task.status !== "running") throw new Error(task.error || `Installation ${task.status}; outcome may be unknown`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
export function listPlugins(cwd: string): Promise<PluginsResponse> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  return client.request("plugins.list", { cwd }, { timeoutMs: 60_000 });
}
