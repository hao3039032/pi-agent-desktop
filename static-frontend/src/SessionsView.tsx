import { useCallback, useEffect, useState } from "react";
import { IpcClient, IpcFailure, MockTransport, type IpcTransport } from "./ipc/client.ts";

/**
 * The Sessions sidebar view (M2 UI migration step 1): the project tree with
 * each project's sessions, newest first, driven by sessions.list over the
 * typed IPC client — the same envelope the Rust host serves. Without a
 * Tauri host (browser dev), the mock transport keeps the component testable
 * and the diagnosis honest ("no host bridge").
 */

export interface SessionSummary {
  id: string;
  file: string;
  timestampMs: number;
  cwd: string;
  name?: string;
  parentSession?: string;
  sizeBytes: number;
}

export interface ProjectGroup {
  cwd: string;
  sessions: SessionSummary[];
}

export type SessionsState =
  | { status: "loading" }
  | { status: "ready"; projects: ProjectGroup[] }
  | { status: "error"; message: string };

function detectTransport(): IpcTransport {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    const invoke = internals.invoke as (cmd: string, payload: unknown) => Promise<unknown>;
    return {
      send: (request, timeoutMs) =>
        Promise.race([
          invoke("pi_ipc", { request }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `ipc '${request.op}' timed out; never resend blindly`,
                  ),
                ),
              timeoutMs,
            ),
          ),
        ]),
      subscribe: () => () => {},
    };
  }
  return new MockTransport().on("sessions.index", () => ({
    projects: [
      {
        cwd: "/demo/project",
        sessions: [
          {
            id: "demo-1",
            file: "/demo/sessions/demo-1.jsonl",
            timestampMs: Date.now() - 3_600_000,
            cwd: "/demo/project",
            name: "Demo session",
            sizeBytes: 4096,
          },
        ],
      },
    ],
    skipped: [],
  }));
}

export function useSessions(): SessionsState & { reload: () => void } {
  const [state, setState] = useState<SessionsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const client = new IpcClient(detectTransport());
    client
      .request<{ projects?: ProjectGroup[] }>("sessions.index", undefined, { timeoutMs: 10_000 })
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", projects: data.projects ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof IpcFailure
            ? `${error.error.code}: ${error.error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { ...state, reload };
}

export function SessionsView(): React.ReactElement {
  const sessions = useSessions();
  return (
    <aside className="sessions-view" data-status={sessions.status}>
      <header className="sessions-header">
        <span>Sessions</span>
        <button type="button" onClick={sessions.reload}>
          ⟳
        </button>
      </header>
      {sessions.status === "loading" && <p className="sessions-note">加载中…</p>}
      {sessions.status === "error" && (
        <p className="sessions-note sessions-error" title={sessions.message}>
          无法列出会话（{sessions.message.split("\n")[0]}）
        </p>
      )}
      {sessions.status === "ready" && (
        <div className="sessions.index">
          {sessions.projects.length === 0 && (
            <p className="sessions-note">没有项目会话。</p>
          )}
          {sessions.projects.map((project) => (
            <section key={project.cwd} className="sessions-project">
              <h2 title={project.cwd}>{project.cwd}</h2>
              {project.sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className="sessions-row"
                  title={session.file}
                >
                  <span className="sessions-row-name">
                    {session.name ?? session.id.slice(0, 8)}
                  </span>
                  <span className="sessions-row-time">
                    {new Date(session.timestampMs).toLocaleString()}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
