/**
 * The IPC-backed OAuth login service (the static build's alias target for
 * lib/provider-auth-login.ts): the Models panel's OAuth login stream
 * (auth.loginStream over a Tauri Channel) and manual code/selection submission
 * (auth.loginManualCode over pi_ipc).
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { OAuthLoginEvent } from "../../../lib/provider-auth-login";

export type { OAuthLoginEvent };

let client: IpcClient | null = null;
type LoginTask = { flowId: string; taskHandle: string };
const tasks = new Map<string, LoginTask>();

function taskFor(provider: string): LoginTask | undefined {
  const cached = tasks.get(provider);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(`pi:provider-login:${provider}`);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (typeof value === "object" && value !== null && "flowId" in value && "taskHandle" in value
      && typeof value.flowId === "string" && typeof value.taskHandle === "string") {
      const task = { flowId: value.flowId, taskHandle: value.taskHandle };
      tasks.set(provider, task);
      return task;
    }
  } catch { /* storage is optional */ }
  return undefined;
}

function rememberTask(provider: string, task: LoginTask | undefined): void {
  if (task) tasks.set(provider, task); else tasks.delete(provider);
  try {
    if (task) sessionStorage.setItem(`pi:provider-login:${provider}`, JSON.stringify(task));
    else sessionStorage.removeItem(`pi:provider-login:${provider}`);
  } catch { /* storage is optional */ }
}

export function bindProviderAuthLogin(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the provider-auth login IPC bridge is not configured (bindProviderAuthLogin)");
  }
  return client;
}

/**
 * Open the OAuth login stream for a provider over IPC (auth.loginStream).
 * Returns a teardown function that ends observation, not the credential writer.
 */
export function subscribeOAuthLogin(
  provider: string,
  onEvent: (event: OAuthLoginEvent) => void,
  onError: (error: Error) => void,
): (() => void) & { cancel?: () => void } {
  const bound = ensureClient();
  let cancelPending = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const requestCancel = (task: LoginTask) => {
    void bound.request("auth.loginCancel", { taskHandle: task.taskHandle }).catch(() => {});
  };
  const dispose = bound.subscribe<OAuthLoginEvent>(
    "auth.loginStream",
    { provider, ...taskFor(provider) },
    (message) => {
      if (message.kind === "snapshot") {
        const payload: unknown = message.payload;
        if (typeof payload === "object" && payload !== null && "flowId" in payload && "taskHandle" in payload
          && typeof payload.flowId === "string" && typeof payload.taskHandle === "string") {
          const task = { flowId: payload.flowId, taskHandle: payload.taskHandle };
          rememberTask(provider, task);
          if (cancelPending) {
            cancelPending = false;
            clearTimeout(cancelTimer);
            requestCancel(task);
            dispose();
          }
        }
        return;
      }
      if (cancelPending || message.kind === "heartbeat") return;
      if (message.kind === "terminal") rememberTask(provider, undefined);
      if (message.payload) onEvent(message.payload);
    },
    (err) => {
      const details = err.details;
      if (details && typeof details.flowId === "string" && typeof details.taskHandle === "string") {
        const task = { flowId: details.flowId, taskHandle: details.taskHandle };
        rememberTask(provider, task);
        if (cancelPending) { cancelPending = false; clearTimeout(cancelTimer); requestCancel(task); }
      }
      onError(new Error(err.message || "Connection lost"));
    },
  );
  return Object.assign(() => {
    if (cancelPending) {
      cancelTimer = setTimeout(dispose, 35_000);
    } else {
      clearTimeout(cancelTimer);
      dispose();
    }
  }, { cancel: () => {
    const task = taskFor(provider);
    if (task) requestCancel(task); else cancelPending = true;
  } });
}

/**
 * Submit a manual code, prompt answer, or select choice over IPC (auth.loginManualCode).
 */
export async function submitOAuthLoginCode(
  provider: string,
  token: string,
  code: string,
): Promise<void> {
  try {
    await ensureClient().request<{ ok: boolean }>(
      "auth.loginManualCode",
      { provider, token, code: code.trim() },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) {
      throw new Error(caught.error.message || "Failed to submit login code");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
