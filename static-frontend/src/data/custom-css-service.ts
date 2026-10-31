/**
 * The IPC-backed custom-css service (the static build's alias target for
 * lib/custom-css-service.ts): custom stylesheet read and ensure go through
 * appearance.customCssGet / appearance.customCssSet over pi_ipc.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  CustomCssGetResult,
  CustomCssSetResult,
} from "../../../lib/custom-css-service";

export type { CustomCssGetResult, CustomCssSetResult };

let client: IpcClient | null = null;

export function bindCustomCssService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the custom-css service IPC bridge is not configured (bindCustomCssService)");
  }
  return client;
}

/** Load custom stylesheet text over IPC. */
export async function fetchCustomCss(): Promise<CustomCssGetResult> {
  try {
    const res = await ensureClient().request<{ css: string; path?: string }>(
      "appearance.customCssGet",
      undefined,
      { timeoutMs: 15_000 },
    );
    return { css: res.css ?? "", path: res.path };
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to load custom css");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Ensure user stylesheet exists on disk and return its path over IPC. */
export async function ensureCustomCss(): Promise<CustomCssSetResult> {
  try {
    const res = await ensureClient().request<{ path: string; created: boolean }>(
      "appearance.customCssSet",
      undefined,
      { timeoutMs: 15_000 },
    );
    if (!res.path) throw new Error("Missing stylesheet path");
    return { path: res.path, created: res.created === true };
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to ensure custom css");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/**
 * In the static frontend, fetch and apply custom.css into a top-level
 * `<style data-custom-css="">` element. Never injects into sandboxed preview frames.
 */
export async function applyCustomCssToDocument(): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    const { css } = await fetchCustomCss();
    if (!css.trim()) return;
    let style = document.querySelector<HTMLStyleElement>("style[data-custom-css]");
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-custom-css", "");
      document.head.appendChild(style);
    }
    style.textContent = css;
  } catch {
    // Non-critical: missing or unreadable custom.css never breaks startup.
  }
}
