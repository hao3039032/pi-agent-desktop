/** Restricted JSONL adapter for the management command handler, not a pi RPC server. */
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND = /^\/pi-web:mgmt ([A-Za-z0-9_-]{1,64}) ([A-Za-z0-9_-]{1,131072})$/;

export function serveManagementStdio(register, input = process.stdin, output = process.stdout) {
  let handler;
  register({ registerCommand(name, command) {
    if (name !== "pi-web:mgmt" || handler || typeof command?.handler !== "function") throw new Error("invalid management handler");
    handler = command.handler;
  } });
  if (!handler) throw new Error("management handler missing");

  let frame = Buffer.alloc(0);
  let closed = false;
  const pending = new Set();
  function failClosed() {
    if (closed) return;
    closed = true;
    input.destroy();
    output.destroy();
  }
  function send(value) {
    if (closed) return;
    let line;
    try { line = JSON.stringify(value) + "\n"; } catch { failClosed(); return; }
    const size = Buffer.byteLength(line);
    if (size > MAX_FRAME_BYTES || output.writableLength + size > MAX_OUTPUT_BYTES) { failClosed(); return; }
    output.write(line);
  }
  const ctx = { ui: { notify(message) {
    if (typeof message !== "string" || !(message.startsWith("PI_WEB_MGMT_V1 ") || message.startsWith("PI_WEB_MGMT_PROGRESS_V1 "))) {
      failClosed(); return;
    }
    send({ type: "extension_ui_request", id: "management", method: "notify", message });
  } } };
  function dispatch(bytes) {
    let request;
    try { request = JSON.parse(bytes.toString("utf8")); } catch { failClosed(); return; }
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.id !== "string" || request.id.length > 128) { failClosed(); return; }
    const response = (success, data, error) => send({ type: "response", id: request.id, command: request.type, success, ...(success ? { data } : { error }) });
    const match = request.type === "prompt" && typeof request.message === "string" ? COMMAND.exec(request.message) : null;
    if (!match) { response(false, undefined, "unsupported management request"); return; }
    if (pending.has(request.id) || pending.size >= 128) { response(false, undefined, "management request busy"); return; }
    pending.add(request.id);
    // The handler owns nonce, task, cancellation and input checks. No other
    // command or prompt is forwarded to it.
    Promise.resolve().then(() => handler(`${match[1]} ${match[2]}`, ctx)).then(
      () => response(true, { disposition: "handled" }),
      () => response(false, undefined, "management request failed"),
    ).finally(() => pending.delete(request.id));
  }
  input.on("data", chunk => {
    if (closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 10) continue;
      const part = data.subarray(start, index);
      if (frame.length + part.length > MAX_FRAME_BYTES) { failClosed(); return; }
      const complete = frame.length ? Buffer.concat([frame, part]) : part;
      frame = Buffer.alloc(0);
      dispatch(complete);
      if (closed) return;
      start = index + 1;
    }
    const rest = data.subarray(start);
    if (frame.length + rest.length > MAX_FRAME_BYTES) { failClosed(); return; }
    if (rest.length) frame = Buffer.concat([frame, rest]);
  });
  input.on("end", () => { if (frame.length) failClosed(); });
  input.on("error", failClosed);
  output.on("error", failClosed);
}
