import type { PluginsResponse, PluginScope, PluginUpdateResult } from "@/lib/api-types";

export async function checkPlugins(cwd: string, source?: string, scope?: PluginScope): Promise<PluginUpdateResult[]> {
  const response = await fetch("/api/plugins/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, source, scope }) });
  const data = await response.json() as { updates?: PluginUpdateResult[]; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.updates ?? [];
}

export async function listPlugins(cwd: string): Promise<PluginsResponse> {
  const response = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
  const data = await response.json() as PluginsResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
