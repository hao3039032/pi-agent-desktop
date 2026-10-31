import type { PluginsResponse } from "@/lib/api-types";

export async function listPlugins(cwd: string): Promise<PluginsResponse> {
  const response = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
  const data = await response.json() as PluginsResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
