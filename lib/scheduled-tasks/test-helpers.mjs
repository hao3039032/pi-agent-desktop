// Shared stubs for the runner and scheduler tests.
export function makeSession(behavior = "ok") {
  const listeners = new Set();
  const session = {
    sent: [],
    entries: [],
    order: [],
    held: false,
    emit(event) { for (const listener of listeners) listener(event); },
    finish(kind = behavior) {
      if (kind === "ok") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      if (kind === "error") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } });
      if (kind === "aborted") session.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
      if (kind === "promptError") session.emit({ type: "prompt_error", errorMessage: "preflight exploded" });
      session.emit({ type: "prompt_done" });
    },
    async send(command) {
      session.sent.push(command);
      session.order.push(command.type);
      if (command.type === "prompt") {
        if (behavior === "rejectSend") throw new Error("prompt rejected");
        if (behavior === "userAborted") queueMicrotask(() => session.finish("aborted"));
        else if (behavior !== "hang" && behavior !== "hold" && behavior !== "markFails") queueMicrotask(() => session.finish());
      }
      if (command.type === "abort" && behavior === "hang") queueMicrotask(() => session.finish("aborted"));
      return null;
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** The engine's single-writer tag: recorded, optionally refused. */
    async markScheduledRun(data) {
      session.order.push("mark:scheduled-run");
      if (behavior === "markFails") {
        throw new Error("pi-web bridge 'meta.scheduled-run' failed: the session is running");
      }
      session.entries.push({ customType: "pi-web:scheduled-run", data });
    },
  };
  return session;
}

export function makeDeps({ behavior = () => "ok", clock = () => new Date(), extra = {} } = {}) {
  const started = [];
  const deps = {
    started,
    now: clock,
    async startSession(cwd, options) {
      const kind = behavior(started.length);
      if (kind === "startFails") throw new Error("could not start");
      const session = makeSession(kind);
      const sessionId = `session-${started.length + 1}`;
      started.push({ cwd, options, session, sessionId });
      return { session, sessionId };
    },
    ...extra,
  };
  return deps;
}
