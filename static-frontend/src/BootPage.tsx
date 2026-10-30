import { useCallback, useEffect, useRef, useState } from "react";
import { IpcClient, IpcFailure, MockTransport, type IpcTransport } from "./ipc/client.ts";
import type { IpcError } from "./ipc/protocol.ts";
import { SessionsView } from "./SessionsView.tsx";

/**
 * The M1 boot/diagnostic page: the window renders WITHOUT Next.js and
 * WITHOUT a pi child (plan: “窗口无需 Next/pi 即可显示；pi 不可用时页面仍能
 * 显示诊断和重试入口”). From M2 the session UI mounts beside this fallback.
 */

type HostState =
  | { status: "probing" }
  | { status: "ready"; version: string }
  | { status: "degraded"; diagnosis: string; retryable: boolean };

/** Client-side timeout for one invoke (a timeout never resends). */
function invokeWithTimeout(
  invoke: (cmd: string, payload: unknown) => Promise<unknown>,
  request: { op: string; id: string },
  timeoutMs: number,
): Promise<unknown> {
  return Promise.race([
    invoke("pi_ipc", { request }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`ipc '${request.op}' timed out; the operation may still have happened — never resend blindly`)),
        timeoutMs,
      );
    }),
  ]);
}

/** Detect the Tauri host bridge (M2 registers `pi_ipc`); the mock is the M1 stand-in. */
function detectTransport(): { transport: IpcTransport; label: string } {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    return {
      label: "tauri",
      transport: {
        send: (request, timeoutMs) =>
          invokeWithTimeout(
            internals.invoke as (cmd: string, payload: unknown) => Promise<unknown>,
            request,
            timeoutMs,
          ),
        subscribe: (op, args, onMessage) => {
          if (op !== "agent.subscribeEvents") {
            return () => {};
          }
          // The host exposes the stream as its own command returning a
          // Channel; wire it through the protocol frame type.
          const channel = new (window as unknown as {
            __TAURI_INTERNALS__: {
              Channel: new () => {
                onmessage: (message: unknown) => void;
              };
            };
          }).__TAURI_INTERNALS__.Channel();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyChannel = channel as any;
          anyChannel.onmessage = (message: unknown) => {
            onMessage(message as import("./ipc/protocol.ts").IpcStreamMessage);
          };
          void (internals.invoke as (cmd: string, payload: unknown) => Promise<unknown>)(
            "pi_ipc_subscribe_events",
            { session: args?.session, onEvent: channel },
          );
          return () => {
            // Dropping the reference detaches host-side on the next send.
            anyChannel.onmessage = () => {};
          };
        },
      },
    };
  }
  // M1 skeleton: no host command yet. The mock answers the probe so the
  // diagnostics page itself is testable end-to-end.
  const mock = new MockTransport().on("desktop.identity", () => ({
    version: "static-frontend-m1",
    host: "mock",
  }));
  return { transport: mock, label: "mock (no Tauri host bridge yet)" };
}

export function BootPage(): React.ReactElement {
  const [state, setState] = useState<HostState>({ status: "probing" });
  const [attempt, setAttempt] = useState(0);
  const clientRef = useRef<IpcClient | null>(null);
  const [transportLabel, setTransportLabel] = useState("");

  const probe = useCallback(async () => {
    setState({ status: "probing" });
    const { transport, label } = detectTransport();
    setTransportLabel(label);
    const client = new IpcClient(transport);
    clientRef.current = client;
    try {
      const identity = await client.request<{ version?: string }>("desktop.identity", undefined, {
        timeoutMs: 5_000,
      });
      setState({ status: "ready", version: typeof identity?.version === "string" ? identity.version : "unknown" });
    } catch (error) {
      const diagnosis =
        error instanceof IpcFailure
          ? `${error.error.code}: ${error.error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      setState({ status: "degraded", diagnosis, retryable: true });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe, attempt]);

  return (
    <main className="boot-page">
      <h1>Pi Agent Desktop</h1>
      <p className="boot-sub">静态前端骨架（M1）— 不依赖 Next.js 与 pi 子进程</p>
      <div className="boot-status" data-status={state.status}>
        {state.status === "probing" && <p>正在探测宿主…</p>}
        {state.status === "ready" && (
          <>
            <p>宿主就绪：{state.version}</p>
            <p className="boot-note">transport: {transportLabel}</p>
          </>
        )}
        {state.status === "degraded" && (
          <>
            <p>宿主不可用（诊断信息）：</p>
            <pre>{state.diagnosis}</pre>
            <p className="boot-note">transport: {transportLabel}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
          </>
        )}
      </div>
      {state.status === "ready" && (
        <div className="boot-sessions">
          <SessionsView />
        </div>
      )}
    </main>
  );
}
