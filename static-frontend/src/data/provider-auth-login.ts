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
const generations = new Map<string, number>();
const uncertain = new Set<string>();
function setUncertain(provider: string, value: boolean): void {
  if (value) uncertain.add(provider); else uncertain.delete(provider);
  try {
    if (value) sessionStorage.setItem(`pi:provider-login-unknown:${provider}`, "1");
    else sessionStorage.removeItem(`pi:provider-login-unknown:${provider}`);
  } catch { /* storage is optional */ }
}
function isUncertain(provider: string): boolean {
  try { return uncertain.has(provider) || sessionStorage.getItem(`pi:provider-login-unknown:${provider}`) === "1"; }
  catch { return uncertain.has(provider); }
}

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
  const original = taskFor(provider);
  if (!original && isUncertain(provider)) {
    onError(new Error("Original login task is unavailable; outcome unknown"));
    return () => {};
  }
  if (!original) setUncertain(provider, true);
  const generation = (generations.get(provider) ?? 0) + 1;
  generations.set(provider, generation);
  let cancelPending = false;
  let cancelSent = false;
  let detached = false;
  let terminal = false;
  let invalid = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let subscriptionId: string | undefined;
  let ackSubscriptionId: string | undefined;
  let snapshotTask: LoginTask | undefined;
  let ackTask: LoginTask | undefined;
  let seq = 0;
  const latest = () => generations.get(provider) === generation;
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
  const sameTask = (a: LoginTask, b: LoginTask) => a.flowId === b.flowId && a.taskHandle === b.taskHandle;
  const acceptTask = (task: LoginTask) => {
    if ((original && !sameTask(original, task)) || (snapshotTask && !sameTask(snapshotTask, task)) || (ackTask && !sameTask(ackTask, task))) {
      invalid = true;
      return false;
    }
    return true;
  };
  const requestCancel = (task: LoginTask) => {
    if (cancelSent || invalid) return;
    cancelSent = true;
    void bound.request("auth.loginCancel", { taskHandle: task.taskHandle }).catch(() => {});
  };
  const dispose = bound.subscribe<OAuthLoginEvent>(
    "auth.loginStream",
    { provider, ...original },
    (message) => {
      if (detached || invalid || terminal || !latest()) return;
      if (!validId(message.subscriptionId) || message.epoch !== 1 || !Number.isSafeInteger(message.seq) || message.seq !== seq + 1
        || (subscriptionId && subscriptionId !== message.subscriptionId) || (ackSubscriptionId && ackSubscriptionId !== message.subscriptionId)) {
        invalid = true; onError(new Error("Login observation invalid; outcome unknown")); return;
      }
      if (seq === 0) {
        const payload: unknown = message.payload;
        if (message.kind !== "snapshot" || typeof payload !== "object" || payload === null || !("flowId" in payload) || !("taskHandle" in payload)
          || !validId(payload.flowId) || !validId(payload.taskHandle)) {
          invalid = true; onError(new Error("Login observation invalid; outcome unknown")); return;
        }
        const task = { flowId: payload.flowId, taskHandle: payload.taskHandle };
        if (!acceptTask(task)) { onError(new Error("Login observation invalid; outcome unknown")); return; }
        subscriptionId = message.subscriptionId;
        snapshotTask = task;
        seq = message.seq;
        rememberTask(provider, task);
        setUncertain(provider, false);
        if (cancelPending) { cancelPending = false; clearTimeout(cancelTimer); requestCancel(task); dispose(); }
        return;
      }
      if (!["event", "heartbeat", "reset", "terminal", "unknown"].includes(message.kind)) {
        invalid = true; onError(new Error("Login observation invalid; outcome unknown")); return;
      }
      seq = message.seq;
      if (cancelPending || message.kind === "heartbeat") return;
      if (message.kind === "event" && message.payload && ["success", "cancelled"].includes(message.payload.type)) {
        invalid = true; onError(new Error("Login observation invalid; outcome unknown")); return;
      }
      if (message.kind === "terminal") {
        if (!message.payload || !["success", "error", "cancelled"].includes(message.payload.type)) {
          invalid = true; onError(new Error("Login observation invalid; outcome unknown")); return;
        }
        terminal = true; rememberTask(provider, undefined);
      }
      if (message.kind === "reset") {
        const payload: unknown = message.payload;
        if (typeof payload !== "object" || payload === null || !("events" in payload) || !Array.isArray(payload.events)
          || payload.events.length > 16 || new TextEncoder().encode(JSON.stringify(payload)).byteLength > 60 * 1024
          || payload.events.some((event: unknown) => typeof event !== "object" || event === null || !("type" in event)
            || !["auth", "device_code", "prompt_request", "select_request"].includes(String(event.type))
            || (event.type !== "device_code" && (!("token" in event) || !validId(event.token))))) {
          invalid = true; onError(new Error("Login recovery unavailable; outcome unknown")); return;
        }
        for (const event of payload.events) onEvent(event as OAuthLoginEvent);
      } else if (message.payload) onEvent(message.payload);
    },
    (err) => {
      const details = err.details;
      if (details && validId(details.subscriptionId) && validId(details.flowId) && validId(details.taskHandle)) {
        const task = { flowId: details.flowId, taskHandle: details.taskHandle };
        if ((!subscriptionId || subscriptionId === details.subscriptionId) && (!ackSubscriptionId || ackSubscriptionId === details.subscriptionId) && acceptTask(task)) {
          if (latest() && !terminal) { rememberTask(provider, task); setUncertain(provider, false); }
          if (cancelPending) { cancelPending = false; clearTimeout(cancelTimer); requestCancel(task); }
        }
      }
      if (latest() && !taskFor(provider) && ["busy", "invalid_args", "management_unavailable"].includes(err.code)) setUncertain(provider, false);
      if (!detached && latest()) onError(new Error(err.message || "Connection lost"));
    },
    (metadata) => {
      if (!validId(metadata.subscriptionId) || !validId(metadata.flowId) || !validId(metadata.taskHandle)) return;
      const task = { flowId: metadata.flowId, taskHandle: metadata.taskHandle };
      if ((subscriptionId && subscriptionId !== metadata.subscriptionId) || !acceptTask(task)) {
        invalid = true;
        if (!detached && latest()) onError(new Error("Login observation invalid; outcome unknown"));
        return;
      }
      ackTask = task;
      ackSubscriptionId = metadata.subscriptionId;
      if (latest() && !terminal) { rememberTask(provider, task); setUncertain(provider, false); }
      if (cancelPending) { cancelPending = false; clearTimeout(cancelTimer); requestCancel(task); dispose(); }
    },
  );
  return Object.assign(() => {
    detached = true;
    if (cancelPending) cancelTimer = setTimeout(dispose, 35_000);
    else { clearTimeout(cancelTimer); dispose(); }
  }, { cancel: () => {
    const task = ackTask ?? snapshotTask ?? original;
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
