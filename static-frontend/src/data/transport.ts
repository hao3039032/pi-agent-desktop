/**
 * The single IPC transport wiring point for the static app. The plan (§四)
 * keeps the LOW-LEVEL Tauri wiring in ONE place — `lib/desktop-native.ts` —
 * so this module only decides between:
 *
 * - the real host bridge (Tauri runtime): `pi_ipc` requests over
 *   `tauriHostInvoke`, event streams over `pi_ipc_subscribe_events` with the
 *   official Channel, explicit host-side unsubscribe, cancellable timeouts;
 * - NO bridge (a plain browser): an explicit, always-failing transport. The
 *   app never pretends to work without its host — the boot page explains it.
 *
 * Mock transports exist only as an injectable test seam (`MockTransport` in
 * ../ipc/client.ts); `detectTransport()` never silently installs one.
 */

import { tauriHostChannel, tauriHostInvoke, hasTauriHostBridge } from "../../../lib/desktop-native";
import { IpcTimeoutError, MockTransport, type IpcTransport } from "../ipc/client.ts";
import {
  IPC_ERROR_CODES,
  IPC_PROTOCOL_VERSION,
  type IpcError,
  type IpcErrorCode,
  type IpcRequest,
  type IpcStreamMessage,
} from "../ipc/protocol.ts";

/** A transport without a host: every request fails with a diagnosable code. */
export class MissingHostTransport implements IpcTransport {
  public readonly reason = "no Tauri host bridge (this build runs inside the desktop app)";

  send(request: IpcRequest): Promise<unknown> {
    return Promise.reject(new Error(`ipc '${request.op}' unusable: ${this.reason}`));
  }

  subscribe(
    op: string,
    _args: Record<string, unknown> | undefined,
    _onMessage: (message: IpcStreamMessage) => void,
    onError: (error: IpcError) => void,
  ): () => void {
    onError({ code: "no_host", message: this.reason, retryable: false });
    return () => {};
  }
}

/** One open event-stream subscription over a host channel. */
interface HostSubscription {
  stopLocalDelivery(): void;
  unsubscribe(): Promise<void>;
}

let cached: { transport: IpcTransport; label: string } | null = null;

export function detectTransport(): { transport: IpcTransport; label: string } {
  if (cached) return cached;
  cached = hasTauriHostBridge()
    ? { transport: new HostBridgeTransport(), label: "tauri" }
    : { transport: new MissingHostTransport(), label: MissingHostTransport.name };
  return cached;
}

/** Test seam: force a transport (mock tests inject theirs; resets on undefined). */
export function overrideTransportForTests(replacement: { transport: IpcTransport; label: string } | undefined): void {
  cached = replacement ?? null;
}

/** Parse a subscribe command's ACK.
 *
 * The host's subscribe commands resolve (never throw) with EITHER the
 * success shape (`{subscriptionId, ...}`) OR a full protocol error envelope
 * (`{ok:false, error:{code,message,retryable}}` — a missing session, a
 * relay that could not start). The transport must route the latter to
 * `onError`: treating it as "no subscriptionId yet" parks the subscription
 * in CONNECTING forever, with no reconnect and no error surface.
 */
export function parseSubscribeAck(ack: unknown): { subscriptionId: string } | { error: IpcError } {
  if (isRecord(ack) && ack.ok === false && isRecord(ack.error)) {
    // The subscribe commands' envelopes are built outside dispatch's code
    // table (e.g. an "internal" relay failure), so the code maps through the
    // same tolerance parseIpcResponse applies: an unrecognized code reads as
    // `io` (the message still says what happened).
    const rawCode = typeof ack.error.code === "string" ? ack.error.code : "";
    const code = IPC_ERROR_CODES.includes(rawCode as IpcErrorCode)
      ? (rawCode as IpcErrorCode)
      : "io";
    return {
      error: {
        code,
        message: typeof ack.error.message === "string"
          ? ack.error.message
          : "the stream was refused by the host",
        retryable: ack.error.retryable === true,
        ...(isRecord(ack.error.details) ? { details: ack.error.details } : {}),
      },
    };
  }
  if (isRecord(ack) && typeof ack.subscriptionId === "string") {
    return { subscriptionId: ack.subscriptionId };
  }
  return {
    error: {
      code: "io",
      message: "the stream ack carried no subscriptionId",
      retryable: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The real host-bridge transport. */
class HostBridgeTransport implements IpcTransport {
  send(request: IpcRequest, timeoutMs: number): Promise<unknown> {
    const invoke = tauriHostInvoke();
    if (invoke === null) {
      return Promise.reject(new Error(`ipc '${request.op}' unusable: no Tauri host bridge`));
    }
    // A cancellable timeout: the timer must not outlive the request (the
    // old Promise.race leaked one timer per call), and a timeout NEVER
    // auto-resends — the operation may still have happened.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new IpcTimeoutError(request.op, request.id)),
        timeoutMs,
      );
    });
    return Promise.race([
      invoke("pi_ipc", { request }).finally(() => clearTimeout(timer)),
      timeout,
    ]);
  }

  subscribe(
    op: string,
    args: Record<string, unknown> | undefined,
    onMessage: (message: IpcStreamMessage) => void,
    onError: (error: IpcError) => void,
    onSubscribe?: (metadata: { subscriptionId: string; flowId: string; taskHandle: string }) => void,
  ): () => void {
    const invoke = tauriHostInvoke();
    if (invoke === null) {
      onError({ code: "no_host", message: "no Tauri host bridge", retryable: false });
      return () => {};
    }
    let subscription: HostSubscription | null = null;
    let closed = false;
    let boundedAckInFlight = false;
    let pendingBoundedAck: { subscriptionId: string; epoch: number; seq: number } | null = null;
    let loginLiveness: ReturnType<typeof setTimeout> | undefined;
    type LoginBinding = { subscriptionId: string; flowId: string; taskHandle: string };
    let loginBinding: LoginBinding | undefined;
    let loginSnapshot: LoginBinding | undefined;
    let pendingLoginFrame: IpcStreamMessage | undefined;
    let loginSeq = 0;
    let loginInvalid = false;
    const boundedId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
    const matchesRequested = (binding: LoginBinding) =>
      (args?.flowId == null && args?.taskHandle == null) || (args?.flowId === binding.flowId && args?.taskHandle === binding.taskHandle);
    const sameBinding = (a: LoginBinding, b: LoginBinding) => a.subscriptionId === b.subscriptionId && a.flowId === b.flowId && a.taskHandle === b.taskHandle;
    const validInteraction = (event: unknown): boolean => {
      if (!isRecord(event)) return false;
      if (event.type === "auth") return boundedId(event.token) && typeof event.url === "string" && (event.instructions === null || typeof event.instructions === "string");
      if (event.type === "device_code") return typeof event.userCode === "string" && typeof event.verificationUri === "string";
      if (event.type === "prompt_request") return boundedId(event.token) && typeof event.message === "string" && (event.placeholder === null || typeof event.placeholder === "string");
      if (event.type === "select_request") return boundedId(event.token) && typeof event.message === "string" && Array.isArray(event.options)
        && event.options.every((option: unknown) => isRecord(option) && typeof option.id === "string" && typeof option.label === "string");
      return false;
    };
    const validLoginPayload = (kind: unknown, payload: unknown) => {
      if (kind === "heartbeat") return payload === null;
      if (!isRecord(payload)) return false;
      if (kind === "reset") return Array.isArray(payload.events) && payload.events.length <= 16
        && new TextEncoder().encode(JSON.stringify(payload)).byteLength <= 60 * 1024 && payload.events.every(validInteraction);
      if (kind === "event") return validInteraction(payload) || ((payload.type === "progress" || payload.type === "error") && typeof payload.message === "string");
      if (kind === "terminal") return payload.type === "success" || payload.type === "cancelled" || (payload.type === "error" && typeof payload.message === "string");
      return kind === "unknown" && payload.type === "error" && typeof payload.message === "string";
    };
    const failLogin = () => {
      if (closed) return;
      closed = true;
      clearTimeout(loginLiveness);
      pendingBoundedAck = null;
      void subscription?.unsubscribe();
      onError({ code: "io", message: "Login observation invalid; outcome unknown", retryable: false });
    };
    const armLoginLiveness = () => {
      if (op !== "auth.loginStream") return;
      clearTimeout(loginLiveness);
      loginLiveness = setTimeout(() => {
        if (closed) return;
        closed = true;
        pendingBoundedAck = null;
        void subscription?.unsubscribe();
        onError({ code: "io", message: "Login observation lost; outcome unknown", retryable: false });
      }, 35_000);
    };
    const flushBoundedAck = () => {
      if (closed || boundedAckInFlight || !pendingBoundedAck) return;
      const ack = pendingBoundedAck;
      pendingBoundedAck = null;
      boundedAckInFlight = true;
      void invoke("pi_ipc", { request: { v: IPC_PROTOCOL_VERSION, id: `ack-${ack.subscriptionId}-${ack.seq}`, op: op === "tasks.subscribeEvents" ? "tasks.ackEvents" : op === "auth.loginStream" ? "auth.ackLogin" : "agent.ackRunning", args: ack } })
        .catch(() => {})
        .finally(() => { boundedAckInFlight = false; flushBoundedAck(); });
    };
    // The channel exists before the subscribe invoke fires (messages may
    // race the invoke's own response); the disposer works even mid-open.
    void (async () => {
      try {
        const deliver = (message: unknown) => {
          if (closed) return;
          if (op === "auth.loginStream") {
            if (!isRecord(message) || !boundedId(message.subscriptionId) || message.epoch !== 1
              || !Number.isSafeInteger(message.seq) || message.seq !== loginSeq + 1) { failLogin(); return; }
            if (loginSeq === 0) {
              if (pendingLoginFrame) { failLogin(); return; }
              const payload = message.payload;
              if (message.kind !== "snapshot" || !isRecord(payload) || !boundedId(payload.flowId) || !boundedId(payload.taskHandle)) { failLogin(); return; }
              const binding = { subscriptionId: message.subscriptionId, flowId: payload.flowId, taskHandle: payload.taskHandle };
              if (!matchesRequested(binding) || (loginBinding && !sameBinding(binding, loginBinding))) { loginInvalid = true; failLogin(); return; }
              loginSnapshot = binding;
              if (!loginBinding) { pendingLoginFrame = message as unknown as IpcStreamMessage; return; }
            } else if (!loginSnapshot || message.subscriptionId !== loginSnapshot.subscriptionId
              || !validLoginPayload(message.kind, message.payload)) { failLogin(); return; }
            loginSeq = message.seq as number;
            armLoginLiveness();
          }
          onMessage(message as IpcStreamMessage);
          if (!closed && (op === "agent.subscribeEvents" || op === "tasks.subscribeEvents" || op === "agent.subscribeRunning" || op === "auth.loginStream") && isRecord(message)
              && typeof message.subscriptionId === "string" && Number.isSafeInteger(message.seq)
              && typeof message.seq === "number" && message.seq > 0 && (message.kind !== "reset" || op === "auth.loginStream")
              && (op === "agent.subscribeEvents" || (typeof message.epoch === "number" && Number.isSafeInteger(message.epoch)))) {
            // ACK only after local delivery; the frame can precede the subscribe response.
            if (op === "agent.subscribeEvents") {
              void invoke("pi_ipc", { request: { v: IPC_PROTOCOL_VERSION, id: `ack-${message.subscriptionId}-${message.seq}`, op: "agent.ackEvents", args: { subscriptionId: message.subscriptionId, seq: message.seq } } }).catch(() => {});
            } else {
              pendingBoundedAck = { subscriptionId: message.subscriptionId, epoch: message.epoch as number, seq: message.seq };
              flushBoundedAck();
            }
          }
        };
        const handle = await tauriHostChannel(deliver);
        if (closed) {
          handle.stopLocalDelivery();
          return;
        }
        // Which host command carries this stream is part of THIS layer's
        // wiring (the plan: subscriptions are host commands, not generic).
        const command =
          op === "agent.subscribeEvents"
            ? "pi_ipc_subscribe_events"
            : op === "agent.subscribeRunning"
              ? "pi_ipc_subscribe_running"
              : op === "terminal.subscribeOutput"
                ? "pi_ipc_subscribe_terminal"
                : op === "auth.loginStream"
                  ? "pi_ipc_login_stream"
                : op === "tasks.subscribeEvents"
                  ? "pi_ipc_subscribe_scheduled"
                  : null;
        if (command === null) {
          handle.stopLocalDelivery();
          onError({ code: "unknown_op", message: `no stream handler for '${op}'`, retryable: false });
          return;
        }
        const payload: Record<string, unknown> =
          command === "pi_ipc_subscribe_events"
            ? { session: args?.session, onEvent: handle.channel }
            : command === "pi_ipc_subscribe_running"
              ? { onFrame: handle.channel }
              : command === "pi_ipc_login_stream"
                ? { provider: args?.provider, flowId: args?.flowId ?? null, taskHandle: args?.taskHandle ?? null, onEvent: handle.channel }
              : command === "pi_ipc_subscribe_scheduled"
                ? { onEvent: handle.channel }
                : { id: args?.id, cursor: args?.cursor ?? 0, onOutput: handle.channel };
        armLoginLiveness();
        const ack = await invoke(command, payload);
        if (op === "auth.loginStream" && isRecord(ack) && ack.ok !== false) {
          if (!boundedId(ack.subscriptionId) || !boundedId(ack.flowId) || !boundedId(ack.taskHandle)) {
            failLogin();
          } else {
            const binding = { subscriptionId: ack.subscriptionId, flowId: ack.flowId, taskHandle: ack.taskHandle };
            if (!matchesRequested(binding) || (loginSnapshot && !sameBinding(binding, loginSnapshot))) {
              loginInvalid = true;
              failLogin();
            } else {
              loginBinding = binding;
              if (!loginInvalid) onSubscribe?.(binding);
              if (!closed && pendingLoginFrame) { const pending = pendingLoginFrame; pendingLoginFrame = undefined; deliver(pending); }
            }
          }
        }
        if (closed) {
          handle.stopLocalDelivery();
          const parsed = parseSubscribeAck(ack);
          if ("subscriptionId" in parsed && parsed.subscriptionId !== null) {
            try {
              await invoke("pi_ipc", { request: { v: IPC_PROTOCOL_VERSION, id: `unsubscribe-${parsed.subscriptionId}`, op: command === "pi_ipc_subscribe_terminal" ? "terminal.unsubscribe" : command === "pi_ipc_subscribe_scheduled" ? "tasks.unsubscribe" : "agent.unsubscribeEvents", args: { subscriptionId: parsed.subscriptionId } } });
            } catch { /* the host may already be gone */ }
          }
          return;
        }
        const parsed = parseSubscribeAck(ack);
        if ("error" in parsed) {
          handle.stopLocalDelivery();
          clearTimeout(loginLiveness);
          if (!closed) onError(parsed.error);
          return;
        }
        const subscriptionId = parsed.subscriptionId;
        subscription = {
          stopLocalDelivery: () => handle.stopLocalDelivery(),
          unsubscribe: async () => {
            handle.stopLocalDelivery();
            // The host-side relay ends here: `agent.unsubscribeEvents`
            // detaches the session subscriber and reaps the relay thread.
            // The running-set stream unsubscribes the same way (its relay
            // keys the same registry by subscriptionId). A terminal stream
            // ends with its terminal (or page reload).
            if (subscriptionId !== null) {
              const request: IpcRequest = {
                v: IPC_PROTOCOL_VERSION,
                id: `unsubscribe-${subscriptionId}`,
                op: command === "pi_ipc_subscribe_terminal" ? "terminal.unsubscribe" : command === "pi_ipc_subscribe_scheduled" ? "tasks.unsubscribe" : "agent.unsubscribeEvents",
                args: { subscriptionId },
              };
              try {
                await invoke("pi_ipc", { request });
              } catch {
                // The host may already be gone (window closing): local
                // detach already happened, which is the guarantee we owe.
              }
            }
          },
        };
        if (closed) {
          void subscription.unsubscribe();
          subscription = null;
        }
      } catch (error) {
        clearTimeout(loginLiveness);
        if (!closed) {
          onError({
            code: "no_host",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        }
      }
    })();
    return () => {
      closed = true;
      pendingBoundedAck = null;
      clearTimeout(loginLiveness);
      subscription?.stopLocalDelivery();
      void subscription?.unsubscribe();
      subscription = null;
    };
  }
}

/** The mock stays importable for tests (never the default). */
export { MockTransport };
