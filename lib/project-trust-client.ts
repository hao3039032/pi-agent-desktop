"use client";

/**
 * The project-trust status client (migration M3 seam): the workspace mount
 * probe AppShell performs on every project switch — `GET /api/project-trust`
 * and `POST /api/project-trust` — lives here so the static build can swap it
 * for the typed IPC bridge (`trust.status` and `trust.set`) through a vite alias.
 * The Next app keeps HTTP until M5.
 */

import type {
  McpErrorResponse,
  ProjectMcpListing,
  ProjectTrustResponse,
  ProjectTrustStatus,
} from "./api-types";

/** The mount probe's answer: the status, or the route's error payload. */
export type ProjectTrustStatusResult =
  | ({ ok: true } & ProjectTrustStatus)
  | { ok: false; error: string };

export interface ProjectTrustOverviewResult {
  ok: boolean;
  status: number;
  data: Partial<ProjectTrustResponse & McpErrorResponse>;
}

export interface ProjectTrustMutationResult {
  ok: boolean;
  status: number;
  data: Partial<ProjectTrustStatus & McpErrorResponse>;
}

export async function fetchProjectTrustStatus(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustStatusResult> {
  const res = await fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, {
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<ProjectTrustStatus> & { error?: string };
  if (!res.ok || data.error) {
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  return { ok: true, ...(data as ProjectTrustStatus) };
}

export async function fetchProjectTrustOverview(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustOverviewResult> {
  try {
    const res = await fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, {
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ProjectTrustResponse & McpErrorResponse>;
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function setProjectTrust(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustMutationResult> {
  try {
    const res = await fetch("/api/project-trust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
      ...(signal ? { signal } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ProjectTrustStatus & McpErrorResponse>;
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
