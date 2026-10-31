export async function terminalRequest(path: string, options?: RequestInit): Promise<{ id?: string; cwd?: string }> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => {
    throw new Error(`Terminal request failed (HTTP ${response.status}): server returned an empty or invalid JSON response. Check the pi-web server log.`);
  });
  if (!data || typeof data !== "object") throw new Error(`Terminal request failed (HTTP ${response.status}): invalid JSON response. Check the pi-web server log.`);
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export async function createTerminal(id: string, cwd: string, cols: number, rows: number): Promise<void> {
  await terminalRequest("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, cwd, cols, rows }) });
}

export async function checkTerminal(id: string): Promise<void> {
  await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
}

export async function closeTerminal(id: string): Promise<void> {
  await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
}

export function subscribeTerminal(id: string, offset: number | undefined, handlers: {
  onOpen: () => void;
  onEvent: (event: import("@/lib/terminal-manager").TerminalEvent, done: () => void) => void;
  onError: (closed: boolean) => void;
}): () => void {
  const events = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`);
  events.onmessage = (message) => handlers.onEvent(JSON.parse(message.data), () => {});
  events.onopen = handlers.onOpen;
  events.onerror = () => handlers.onError(events.readyState === EventSource.CLOSED);
  return () => events.close();
}

export async function getTerminalSettings(signal?: AbortSignal): Promise<import("@/lib/api-types").TerminalSettingsResponse> {
  const response = await fetch("/api/terminal/settings", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Load failed");
  return response.json();
}

export async function setTerminalSettings(shell: string): Promise<import("@/lib/api-types").TerminalSettingsResponse> {
  const response = await fetch("/api/terminal/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shell }) });
  if (!response.ok) throw new Error("Save failed");
  return response.json();
}

export function createTerminalWriter(id: string, onError: (error: Error) => void) {
  let pending = Promise.resolve();
  let stopped = false;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown>) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      stopped = true;
      onError(error);
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() { stopped = true; bufferedInput = null; return pending; },
  };
}
