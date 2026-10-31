/**
 * The static app's project-trust status client (the vite alias for
 * `@/lib/project-trust-client`): `trust.status` over IPC — the Rust host's
 * port of `getProjectTrustStatus` (requiresTrust/trusted plus the nearest
 * decision and whether it was inherited). No HTTP server exists to ask.
 *
 * The MCP listing and the trust WRITE (the dialog's POST) are not migrated
 * yet (M3); this client covers exactly the mount probe AppShell performs.
 */

import { IpcClient } from "../ipc/client.ts";
import type { ProjectTrustStatusResult } from "../../../lib/project-trust-client";

// The bound client (app-main binds every domain to the ONE transport before
// the tree mounts; tests inject a MockTransport).
let boundClient: IpcClient | null = null;

export function bindProjectTrustClient(client: IpcClient): void {
  boundClient = client;
}

export async function fetchProjectTrustStatus(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustStatusResult> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  if (boundClient === null) throw new Error("the project-trust IPC bridge is not configured (bindProjectTrustClient)");
  const status = await boundClient.request<import("../../../lib/api-types").ProjectTrustStatus>(
    "trust.status",
    { cwd },
  );
  return { ok: true, ...status };
}
