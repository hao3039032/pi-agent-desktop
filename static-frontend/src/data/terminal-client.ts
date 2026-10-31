import type { TerminalSettingsResponse } from "@/lib/api-types";
import type { TerminalEvent } from "@/lib/terminal-manager";
import type { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindTerminalClient(value: IpcClient): void { client = value; }
function host(): IpcClient {
  if (!client) throw new Error("Terminal IPC is not configured");
  return client;
}

export async function createTerminal(id: string, cwd: string, cols: number, rows: number): Promise<void> {
  await host().request("terminal.create", { id, cwd, cols, rows });
}
export async function checkTerminal(id: string): Promise<void> {
  await host().request("terminal.read", { id, cursor: 0 });
}
export async function closeTerminal(id: string): Promise<void> {
  await host().request("terminal.close", { id });
}
export function getTerminalSettings(_signal?: AbortSignal): Promise<TerminalSettingsResponse> {
  return host().request("terminal.settingsGet");
}
export function setTerminalSettings(shell: string): Promise<TerminalSettingsResponse> {
  return host().request("terminal.settingsSet", { shell });
}

export function subscribeTerminal(id: string, offset: number | undefined, handlers: {
  onOpen: () => void; onEvent: (event: TerminalEvent, done: () => void) => void; onError: (closed: boolean) => void;
}): () => void {
  let opened = false;
  return host().subscribe<{ kind: string; cursor?: number; output?: string; exitCode?: number | null }>(
    "terminal.subscribeOutput", { id, cursor: offset ?? 0 }, frame => {
      if (!opened) { opened = true; handlers.onOpen(); }
      const payload = frame.payload;
      const done = () => { void host().request("terminal.ack", { subscriptionId: frame.subscriptionId, seq: frame.seq }).catch(() => handlers.onError(true)); };
      if (payload.kind === "disconnected") handlers.onError(true);
      else if (payload.kind === "exit") handlers.onEvent(typeof payload.exitCode === "number" ? { type: "exit", exitCode: payload.exitCode } : { type: "closed" }, done);
      else if (typeof payload.cursor === "number" && typeof payload.output === "string") {
        handlers.onEvent({ type: "output", data: payload.output, offset: payload.cursor, reset: payload.kind === "reset" }, done);
      } else done();
    }, () => handlers.onError(true),
  );
}

export function createTerminalWriter(id: string, onError: (error: Error) => void) {
  let pending = Promise.resolve();
  let stopped = false;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      if (body.type === "input") {
        const bytes = new TextEncoder().encode(body.data);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await host().request("terminal.write", { id, input: btoa(binary) });
      } else await host().request("terminal.resize", { id, cols: body.cols, rows: body.rows });
    }).catch((reason: unknown) => {
      stopped = true;
      onError(reason instanceof Error ? reason : new Error(String(reason)));
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else { bufferedInput = { type: "input", data: chunk }; enqueue(bufferedInput); }
      }
    },
    resize(cols: number, rows: number) { bufferedInput = null; enqueue({ type: "resize", cols, rows }); },
    stop() { stopped = true; bufferedInput = null; return pending; },
  };
}
