import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-provider-auth-login-"));
const authPath = join(agentDir, "auth.json");
const extensionsDir = join(agentDir, "extensions");
await mkdir(extensionsDir, { recursive: true });

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  await rm(agentDir, { recursive: true, force: true });
});

// Create a fixture extension that registers mock OAuth providers
await writeFile(
  join(extensionsDir, "mock-oauth-ext.js"),
  `export default function(pi) {
  pi.registerProvider({
    id: "mock-oauth",
    name: "Mock OAuth Provider",
    auth: {
      oauth: {
        name: "Mock OAuth",
        login: async (interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://auth.example.com/oauth/authorize?state=xyz",
            instructions: "Sign in and copy the code",
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Enter the authorization code:",
          });
          if (code === "trigger-error") {
            throw new Error("Invalid OAuth code");
          }
          if (code === "trigger-select") {
            const chosen = await interaction.prompt({
              type: "select",
              message: "Select account organization:",
              options: [
                { id: "org-1", label: "Organization 1" },
                { id: "org-2", label: "Organization 2" },
              ],
            });
            if (chosen === "org-1") {
              return {
                type: "oauth",
                access: "token-org-1",
                refresh: "refresh-org-1",
                expires: Date.now() + 3600000,
              };
            }
            throw new Error("Organization selection rejected");
          }
          return {
            type: "oauth",
            access: "token-success",
            refresh: "refresh-success",
            expires: Date.now() + 3600000,
          };
        },
        refresh: async () => ({ access: "refreshed", refresh: "refreshed", expires: Date.now() + 3600000 }),
        toAuth: async (cred) => ({ apiKey: cred.access }),
      },
    },
    getModels: () => [{ id: "mock-chat", name: "Mock Chat" }],
    models: [{ id: "mock-chat", name: "Mock Chat" }],
  });
}
`,
  "utf8",
);

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  startLoginFlow,
  pollLoginFlow,
  submitLoginCode,
  cancelLoginFlow,
} = await jiti.import("./provider-auth-login.server.ts");

beforeEach(async () => {
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: "api_key", key: "sk-fixture" },
    }),
    { mode: 0o600 },
  );
});

test("startLoginFlow rejects unknown provider before starting", async () => {
  const result = await startLoginFlow("flow-unknown", "not-a-real-provider");
  assert.equal(result.started, false);
  assert.match(result.message, /Unknown provider/);
});

test("startLoginFlow rejects duplicate flowId", async () => {
  const flowId = `flow-dup-${Date.now()}`;
  const first = await startLoginFlow(flowId, "mock-oauth");
  assert.equal(first.started, true);

  const second = await startLoginFlow(flowId, "mock-oauth");
  assert.equal(second.started, false);
  assert.match(second.message, /already running/);

  cancelLoginFlow(flowId);
});

test("full login capacity refuses without cancelling existing flows", async () => {
  const active = [];
  try {
    for (let i = 0; i < 8; i++) {
      const id = `capacity-${i}`;
      const result = await startLoginFlow(id, "mock-oauth");
      assert.equal(result.started, true);
      active.push({ id, promise: result.promise });
    }
    const refused = await startLoginFlow("capacity-overflow", "mock-oauth");
    assert.deepEqual(refused, { started: false, message: "Login capacity exhausted" });
    for (const { id } of active) assert.equal(pollLoginFlow(id, 0).done, false);
  } finally {
    for (const { id } of active) cancelLoginFlow(id);
    await Promise.allSettled(active.map(({ promise }) => promise));
  }
});

test("submitLoginCode validates token presence, provider prefix, and single-use", async () => {
  const flowId = `flow-tokens-${Date.now()}`;
  await startLoginFlow(flowId, "mock-oauth");

  // Wait for initial prompt event
  let poll = pollLoginFlow(flowId, 0);
  let attempts = 0;
  while (poll.events.length === 0 && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }

  const authEvent = poll.events.find((e) => e.event.type === "auth");
  assert.ok(authEvent, "auth event was enqueued");
  assert.equal(authEvent.event.type, "auth");
  const token = authEvent.event.token;
  assert.ok(token.startsWith("mock-oauth-"), `token should start with mock-oauth-, got ${token}`);

  // 1. Token from another provider refused
  const mismatch = submitLoginCode("openai", token, "code");
  assert.equal(mismatch.status, "provider_mismatch");

  // 2. Unknown token refused
  const notFound = submitLoginCode("mock-oauth", "mock-oauth-nonexistent-uuid", "code");
  assert.equal(notFound.status, "no_pending");

  // 3. Valid submission accepted
  const accepted = submitLoginCode("mock-oauth", token, "valid-code");
  assert.equal(accepted.status, "accepted");

  // 4. Repeated submission with the SAME token refused (single-use)
  const repeated = submitLoginCode("mock-oauth", token, "valid-code");
  assert.equal(repeated.status, "no_pending");

  // Wait for success
  attempts = 0;
  while (!poll.done && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }
  assert.equal(poll.done, true);
  const successEvent = poll.events.find((e) => e.event.type === "success");
  assert.ok(successEvent, "flow finished with success");
});

test("error inside login flow emits error event and terminates flow", async () => {
  const flowId = `flow-err-${Date.now()}`;
  await startLoginFlow(flowId, "mock-oauth");

  let poll = pollLoginFlow(flowId, 0);
  let attempts = 0;
  while (poll.events.length === 0 && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }

  const authEvent = poll.events.find((e) => e.event.type === "auth");
  assert.ok(authEvent);
  submitLoginCode("mock-oauth", authEvent.event.token, "trigger-error");

  attempts = 0;
  while (!poll.done && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }
  assert.equal(poll.done, true);
  const errEvent = poll.events.find((e) => e.event.type === "error");
  assert.ok(errEvent);
  assert.match(errEvent.event.message, /Invalid OAuth code/);
});

test("select_request prompt flow and cancellation", async () => {
  const flowId = `flow-sel-${Date.now()}`;
  await startLoginFlow(flowId, "mock-oauth");

  let poll = pollLoginFlow(flowId, 0);
  let attempts = 0;
  while (poll.events.length === 0 && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }

  const authEvent = poll.events.find((e) => e.event.type === "auth");
  submitLoginCode("mock-oauth", authEvent.event.token, "trigger-select");

  // Wait for select_request event
  let selectEvent;
  attempts = 0;
  while (!selectEvent && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
    selectEvent = poll.events.find((e) => e.event.type === "select_request");
  }
  assert.ok(selectEvent, "select_request event arrived");
  assert.equal(selectEvent.event.options.length, 2);

  // Submit selection
  const selectToken = selectEvent.event.token;
  submitLoginCode("mock-oauth", selectToken, "org-1");

  attempts = 0;
  while (!poll.done && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }
  assert.equal(poll.done, true);
  assert.ok(poll.events.some((e) => e.event.type === "success"));
});

test("cancelLoginFlow terminates an active flow and rejects pending tokens", async () => {
  const flowId = `flow-cancel-${Date.now()}`;
  await startLoginFlow(flowId, "mock-oauth");

  let poll = pollLoginFlow(flowId, 0);
  let attempts = 0;
  while (poll.events.length === 0 && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }

  const authEvent = poll.events.find((e) => e.event.type === "auth");
  const token = authEvent.event.token;

  // Cancel the flow
  const cancelled = cancelLoginFlow(flowId);
  assert.equal(cancelled, true);

  poll = pollLoginFlow(flowId, 0);
  assert.equal(poll.done, true);
  const cancelEvent = poll.events.find((e) => e.event.type === "cancelled");
  assert.ok(cancelEvent, "flow finished with cancelled event");

  // Any attempt to submit against that token now returns no_pending
  const res = submitLoginCode("mock-oauth", token, "code");
  assert.equal(res.status, "no_pending");
});

test("task input binds tokens to their flow and consumes them once", async () => {
  let firstHandler;
  let secondHandler;
  const first = await startLoginFlow("input-first", "mock-oauth", { onInput: (handler) => { firstHandler = handler; } });
  const second = await startLoginFlow("input-second", "mock-oauth", { onInput: (handler) => { secondHandler = handler; } });
  assert.equal(first.started, true);
  assert.equal(second.started, true);
  const pollUntilAuth = async (id) => {
    for (let i = 0; i < 50; i++) {
      const event = pollLoginFlow(id, 0).events.find((item) => item.event.type === "auth")?.event;
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("fixture auth event missing");
  };
  const auth = await pollUntilAuth("input-first");
  await pollUntilAuth("input-second");
  const input = { provider: "mock-oauth", token: auth.token, code: "fixture-code" };
  assert.equal(secondHandler(input).status, "no_pending");
  assert.equal(firstHandler({ ...input, provider: "wrong" }).status, "provider_mismatch");
  assert.equal(firstHandler(input).status, "accepted");
  assert.equal(firstHandler(input).status, "no_pending");
  await first.promise;
  cancelLoginFlow("input-second");
  await assert.rejects(second.promise);
  assert.equal(firstHandler, null);
  assert.equal(secondHandler, null);
});

test("opContext.signal cooperatively cancels the flow and opContext.progress receives desensitized events", async () => {
  const flowId = `flow-context-${Date.now()}`;
  const progressRecords = [];
  const controller = new AbortController();
  const opContext = {
    signal: controller.signal,
    progress: (p) => progressRecords.push(p),
  };

  const flow = await startLoginFlow(flowId, "mock-oauth", opContext);
  assert.equal(flow.started, true);

  // Poll until auth_url event arrives
  let poll = pollLoginFlow(flowId, 0);
  let attempts = 0;
  while (poll.events.length === 0 && attempts++ < 20) {
    await new Promise((r) => setTimeout(r, 50));
    poll = pollLoginFlow(flowId, 0);
  }

  // Check progress records: progress must NOT contain token or URL query parameters
  assert.ok(progressRecords.length > 0, "progress recorded");
  for (const record of progressRecords) {
    assert.equal("token" in record, false, "token must not be in task progress");
    assert.equal("url" in record, false, "full url must not be in task progress");
  }

  // Trigger cancellation via opContext.signal
  controller.abort();

  // The flow promise must reject with code 'cancelled'
  await assert.rejects(flow.promise, (err) => err.code === "cancelled" || err.message === "Login cancelled");

  // pollLoginFlow should report done with cancelled event
  poll = pollLoginFlow(flowId, 0);
  assert.equal(poll.done, true);
  assert.ok(poll.events.some((e) => e.event.type === "cancelled"));
});
