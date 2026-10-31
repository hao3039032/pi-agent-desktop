import type { PluginsResponse } from "../../../lib/api-types";
import { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindPluginsClient(bound: IpcClient): void { client = bound; }
export function listPlugins(cwd: string): Promise<PluginsResponse> {
  if (!client) throw new Error("plugins IPC bridge is not configured");
  return client.request("plugins.list", { cwd }, { timeoutMs: 60_000 });
}
