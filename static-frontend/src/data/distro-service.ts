import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { DistroServiceConfig, DistroServiceStatus } from "../../../lib/distro-service";

let client: IpcClient | null = null;
export function bindDistroService(bound: IpcClient): void { client = bound; }

async function request(op: string, args?: DistroServiceConfig): Promise<DistroServiceStatus> {
  if (!client) throw new Error("the distro service IPC bridge is not configured");
  try {
    const data = await client.request<DistroServiceStatus>(op, args ? { ...args } : undefined, { timeoutMs: 60_000 });
    if (typeof data?.baseUrl !== "string" || typeof data?.providerId !== "string") throw new Error("Invalid distro status");
    return data;
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message || "Distro service failed");
    throw error;
  }
}

export function fetchDistroStatus(): Promise<DistroServiceStatus> { return request("distro.status"); }
export function configureDistroService(config: DistroServiceConfig): Promise<DistroServiceStatus> { return request("distro.configure", config); }
