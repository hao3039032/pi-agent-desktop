/**
 * The single IPC transport wiring point for the static app (the migration
 * plan: 唯一底层 Tauri 接线入口). Detects the Tauri host bridge; without a
 * host (browser dev) a mock transport keeps pure-frontend work possible.
 */
import { MockTransport, type IpcTransport } from "../ipc/client.ts";

let cached: { transport: IpcTransport; label: string } | null = null;

export function detectTransport(): { transport: IpcTransport; label: string } {
  if (cached) return cached;
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }
  ).__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    const invoke = internals.invoke as (cmd: string, payload: unknown) => Promise<unknown>;
    const transport: IpcTransport = {
      send: (request, timeoutMs) =>
        Promise.race([
          invoke("pi_ipc", { request }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `ipc '${request.op}' timed out; the operation may still have happened — never resend blindly`,
                  ),
                ),
              timeoutMs,
            ),
          ),
        ]),
      subscribe: (op, args, onMessage) => {
        if (op !== "agent.subscribeEvents") return () => {};
        // The host exposes the stream as its own Channel command.
        const ChannelCtor = (
          window as unknown as {
            __TAURI_INTERNALS__: { Channel: new () => { onmessage: unknown } };
          }
        ).__TAURI_INTERNALS__.Channel;
        const channel = new ChannelCtor();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (channel as any).onmessage = (message: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onMessage(message as any);
        };
        void invoke("pi_ipc_subscribe_events", {
          session: args?.session,
          onEvent: channel,
        });
        return () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (channel as any).onmessage = () => {};
        };
      },
    };
    cached = { transport, label: "tauri" };
    return cached;
  }
  cached = {
    transport: new MockTransport(),
    label: "mock (no Tauri host bridge)",
  };
  return cached;
}
