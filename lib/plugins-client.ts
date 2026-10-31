import type { PluginsResponse, PluginsBulkResponse, PluginScope, PluginUpdateResult } from "@/lib/api-types";

export async function checkPlugins(cwd: string, source?: string, scope?: PluginScope): Promise<PluginUpdateResult[]> {
  const response = await fetch("/api/plugins/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, source, scope }) });
  const data = await response.json() as { updates?: PluginUpdateResult[]; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.updates ?? [];
}

export async function setPluginsEnabled(cwd: string, action: "enable" | "disable", packages: { source: string; scope: PluginScope }[], single = false): Promise<PluginsResponse | PluginsBulkResponse> {
  const response = await fetch("/api/plugins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(single ? { cwd, action, ...packages[0] } : { cwd, action, packages }) });
  const data = await response.json() as PluginsBulkResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export async function installPluginPackage(cwd: string, source: string, scope: PluginScope, signal: AbortSignal, onProgress: (phase: string) => void): Promise<PluginsResponse> {
  try {
    onProgress("running");
    const response = await fetch("/api/plugins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, source, scope, action: "install" }), signal });
    const data = await response.json() as PluginsResponse & { error?: string };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (signal.aborted) throw new Error("Installation cancelled; outcome unknown");
    throw error;
  }
}

export async function listPlugins(cwd: string): Promise<PluginsResponse> {
  const response = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
  const data = await response.json() as PluginsResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
