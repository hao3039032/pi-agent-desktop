import { useCallback, useEffect, useRef, useState } from "react";
import { IpcClient, IpcFailure } from "./ipc/client.ts";
import type { IpcError } from "./ipc/protocol.ts";
import { SessionsView } from "./SessionsView.tsx";
import { detectTransport } from "./data/transport.ts";

/**
 * The M1 boot/diagnostic page: the window renders WITHOUT Next.js and
 * WITHOUT a pi child (plan: “窗口无需 Next/pi 即可显示；pi 不可用时页面仍能
 * 显示诊断和重试入口”). From M2 the session UI mounts beside this fallback.
 */

type HostState =
  | { status: "probing" }
  | { status: "ready"; version: string }
  | { status: "degraded"; diagnosis: string; retryable: boolean };


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
