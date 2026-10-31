"use client";

/**
 * The project-trust status client (migration M3 seam): the workspace mount
 * probe AppShell performs on every project switch — `GET /api/project-trust`
 * — lives here so the static build can swap it for the typed IPC bridge
 * (`trust.status`) through a vite alias. The Next app keeps HTTP until M5.
 *
 * Only the STATUS half moved: the trust dialog's server listing and the
 * POST (trusting a folder) stay on the HTTP route until their M3 ops land;
 * in the static build those paths fail loudly rather than fake a result.
 */

import type { ProjectTrustStatus } from "./api-types";

/** The mount probe's answer: the status, or the route's error payload. */
export type ProjectTrustStatusResult =
  | ({ ok: true } & ProjectTrustStatus)
  | { ok: false; error: string };

export async function fetchProjectTrustStatus(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustStatusResult> {
  const res = await fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, {
    ...(signal ? { signal } : {}),
  });
  const data = await res.json().catch(() => ({})) as Partial<ProjectTrustStatus> & { error?: string };
  if (!res.ok || data.error) {
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  return { ok: true, ...(data as ProjectTrustStatus) };
}
