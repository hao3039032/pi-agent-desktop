#!/usr/bin/env node
// Fake pi RPC shell around the real provider login composition. Tests supply
// a temporary agent directory and fake provider extension; no real account.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });
const { startLoginFlow, pollLoginFlow } = await jiti.import("../provider-auth-login.server.ts");
const inputs = new Map();
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const result = (rid, nonce, value) => emit({ type: "extension_ui_request", id: "notify", method: "notify", message: `PI_WEB_MGMT_V1 ${JSON.stringify({ rid, nonce, ok: true, result: value })}` });

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") return;
  const [, rid, encoded] = command.message.split(" ");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  emit({ type: "response", id: command.id, success: true, data: { disposition: "handled" } });
  void (async () => {
    if (payload.op === "auth.loginStart") {
      const started = await startLoginFlow(payload.args.flowId, payload.args.provider, {
        onInput: (handler) => { if (handler) inputs.set(rid, handler); else inputs.delete(rid); },
      });
      result(rid, payload.nonce, started.started ? await started.promise : started);
    } else if (payload.op === "auth.loginPoll") {
      result(rid, payload.nonce, pollLoginFlow(payload.args.flowId, payload.args.since));
    } else if (payload.op === "__input") {
      result(rid, payload.nonce, inputs.get(payload.args.rid)?.(payload.args.data) ?? { status: "no_pending" });
    }
  })().catch(() => emit({ type: "extension_ui_request", id: "notify", method: "notify", message: `PI_WEB_MGMT_V1 ${JSON.stringify({ rid, nonce: payload.nonce, ok: false, code: "fixture_error", error: "fake provider failed" })}` }));
});
