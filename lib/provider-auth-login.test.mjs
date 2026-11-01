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
  `import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.registerProvider({
    id: "mock-oauth",
    name: "Mock OAuth Provider",
    auth: {
      oauth: {
        name: "Mock OAuth",
        login: async (interaction) => {
          appendFileSync(process.env.PI_CODING_AGENT_DIR + '/fake-provider-started', 'start\\n');
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
          if (code === "trigger-cooperative") {
            try { await interaction.prompt({ type: "manual_code", message: "Cooperative wait" }); } catch (error) {
              appendFileSync(process.env.PI_CODING_AGENT_DIR + '/cooperative-unwound', interaction.signal.aborted ? 'rejected-aborted' : 'rejected');
              throw error;
            }
          }
          if (code === "trigger-resist") {
            try { await interaction.prompt({ type: "manual_code", message: "Wait for cancel" }); } catch {
              appendFileSync(process.env.PI_CODING_AGENT_DIR + '/fake-provider-observed', interaction.signal.aborted ? 'prompt-rejected-aborted\\n' : 'prompt-rejected\\n');
            }
            interaction.notify({ type: "auth_url", url: "https://example.invalid/late", instructions: "late" });
            try { await interaction.prompt({ type: "manual_code", message: "Late prompt" }); } catch {
              appendFileSync(process.env.PI_CODING_AGENT_DIR + '/fake-provider-observed', 'late-prompt-rejected\\n');
            }
            await new Promise(resolve => setTimeout(resolve, 1200));
            appendFileSync(process.env.PI_CODING_AGENT_DIR + '/fake-provider-observed', 'provider-returned\\n');
          }
          if (code === "trigger-loop") {
            for (let i = 0; i < 40; i++) await interaction.prompt({ type: "text", message: "Step " + i });
            for (let i = 0; i < 520; i++) interaction.notify({ type: "progress", message: "fixture" });
            await interaction.prompt({ type: "manual_code", message: "Final" });
          }
          if (code === "trigger-flood" || code === "trigger-oversize") {
            if (code === "trigger-oversize") interaction.notify({ type: "auth_url", url: "https://example.invalid/" + "x".repeat(70000), instructions: "fixture" });
            for (let i = 0; i < 520; i++) interaction.notify({ type: "progress", message: "fixture-private-secret" });
            await interaction.prompt({ type: "manual_code", message: "Continue" });
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

let startLoginFlow, pollLoginFlow, submitLoginCode, cancelLoginFlow;

beforeEach(async () => {
  ({ startLoginFlow, pollLoginFlow, submitLoginCode, cancelLoginFlow } = await jiti.import("./provider-auth-login.server.ts"));
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

test("provider history truncation is bounded and does not cancel the writer", async () => {
  const id = "history-flood";
  const started = await startLoginFlow(id, "mock-oauth");
  assert.equal(started.started, true);
  try {
    let poll;
    for (let i = 0; i < 100; i++) {
      poll = pollLoginFlow(id, 0);
      if (poll.events.some(({ event }) => event.token)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const token = poll.events.find(({ event }) => event.token).event.token;
    assert.equal(submitLoginCode("mock-oauth", token, "trigger-flood").status, "accepted");
    for (let i = 0; i < 100; i++) {
      poll = pollLoginFlow(id, 0);
      if (poll.truncated) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(poll.truncated, true);
    assert.equal(poll.done, false);
    assert.ok(poll.events.length <= 512);
    assert.ok(Buffer.byteLength(JSON.stringify(poll.events)) <= 1024 * 1024);
    assert.ok(!JSON.stringify(poll).includes("fixture-private-secret"));
  } finally {
    cancelLoginFlow(id);
    await Promise.allSettled([started.promise]);
  }
});

test("truncated login recovery keeps only live input and refuses oversized interaction", async () => {
  for (const scenario of ["trigger-flood", "trigger-oversize"]) {
    const id = `recover-${scenario}`;
    const started = await startLoginFlow(id, "mock-oauth");
    assert.equal(started.started, true);
    try {
      let poll;
      for (let i = 0; i < 100; i++) {
        poll = pollLoginFlow(id, 0);
        if (poll.events.some(({ event }) => event.token)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const oldToken = poll.events.find(({ event }) => event.token).event.token;
      assert.equal(submitLoginCode("mock-oauth", oldToken, scenario).status, "accepted");
      for (let i = 0; i < 100; i++) {
        poll = pollLoginFlow(id, 0);
        if (poll.truncated && (poll.currentInteraction === null || poll.currentInteraction.some((event) => event.type === "prompt_request"))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(poll.truncated, true);
      assert.equal(poll.done, false);
      assert.equal(submitLoginCode("mock-oauth", oldToken, "old").status, "no_pending");
      if (scenario === "trigger-oversize") assert.equal(poll.currentInteraction, null);
      else {
        const next = poll.currentInteraction.find((event) => event.type === "prompt_request");
        assert.ok(next && next.token !== oldToken);
        assert.ok(!JSON.stringify(poll.currentInteraction).includes(oldToken));
        assert.equal(submitLoginCode("mock-oauth", next.token, "fake-final").status, "accepted");
        await started.promise;
      }
    } finally {
      cancelLoginFlow(id);
      await Promise.allSettled([started.promise]);
    }
  }
});

test("pre-aborted login never enters the fake provider and releases its slot", async () => {
  const marker = join(agentDir, "fake-provider-started");
  await rm(marker, { force: true });
  const controller = new AbortController();
  controller.abort();
  const started = await startLoginFlow("pre-aborted-fixture", "mock-oauth", { signal: controller.signal });
  assert.equal(started.started, true);
  await assert.rejects(started.promise, /Login cancelled/);
  assert.equal(cancelLoginFlow("pre-aborted-fixture"), false);
  await assert.rejects(import("node:fs/promises").then((fs) => fs.access(marker)), { code: "ENOENT" });
});

test("explicit cancellation rejects waiting prompt and cooperative provider unwinds", async () => {
  const id = "cancel-waiting-real-prompt";
  const started = await startLoginFlow(id, "mock-oauth");
  assert.equal(started.started, true);
  let poll;
  for (let i = 0; i < 100; i++) {
    poll = pollLoginFlow(id, 0);
    if (poll.events.some(({ event }) => event.type === "prompt_request")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const token = poll.events.find(({ event }) => event.type === "prompt_request").event.token;
  assert.equal(submitLoginCode("mock-oauth", token, "trigger-cooperative").status, "accepted");
  for (let i = 0; i < 100 && !pollLoginFlow(id, 0).events.some(({ event }) => event.message === "Cooperative wait"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(pollLoginFlow(id, 0).events.some(({ event }) => event.message === "Cooperative wait"));
  assert.equal(cancelLoginFlow(id), true);
  await assert.rejects(Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("outer login did not reject")), 1500))]), /Login cancelled/);
  const fs = await import("node:fs/promises");
  const marker = join(agentDir, "cooperative-unwound");
  let observed;
  for (let i = 0; i < 100; i++) {
    observed = await fs.readFile(marker, "utf8").catch(() => undefined);
    if (observed) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(observed, "rejected-aborted", "the fake provider received both prompt rejection and abort");
  assert.equal(cancelLoginFlow(id), true, "outer rejection alone does not prove provider exit");
});

test("cancelled resistant provider keeps its slot and cannot publish late prompts", async () => {
  const id = "resistant-provider";
  const started = await startLoginFlow(id, "mock-oauth");
  const others = [];
  try {
    let poll;
    for (let i = 0; i < 100; i++) {
      poll = pollLoginFlow(id, 0);
      if (poll.events.some(({ event }) => event.token)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const token = poll.events.find(({ event }) => event.token).event.token;
    assert.equal(submitLoginCode("mock-oauth", token, "trigger-resist").status, "accepted");
    for (let i = 0; i < 100; i++) {
      poll = pollLoginFlow(id, 0);
      if (poll.events.some(({ event }) => event.message === "Wait for cancel")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelLoginFlow(id), true);
    const ended = pollLoginFlow(id, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pollLoginFlow(id, 0).lastSeq, ended.lastSeq, "late notify/prompt cannot enqueue");
    assert.equal(cancelLoginFlow(id), true, "slot remains until provider promise unwinds");
    for (let i = 0; i < 7; i++) {
      const otherId = `resistant-capacity-${i}`;
      const other = await startLoginFlow(otherId, "mock-oauth");
      assert.equal(other.started, true);
      others.push({ id: otherId, promise: other.promise });
    }
    assert.equal((await startLoginFlow("resistant-overflow", "mock-oauth")).started, false);
    await assert.rejects(started.promise, /Login cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const observed = await import("node:fs/promises").then((fs) => fs.readFile(join(agentDir, "fake-provider-observed"), "utf8"));
    assert.match(observed, /prompt-rejected-aborted/);
    assert.match(observed, /late-prompt-rejected/);
    assert.match(observed, /provider-returned/);
    assert.equal(cancelLoginFlow(id), true, "public SDK offers no provider completion proof");
  } finally {
    cancelLoginFlow(id);
    for (const other of others) cancelLoginFlow(other.id);
    await Promise.allSettled([started.promise, ...others.map((other) => other.promise)]);
  }
});

test("consumed prompt tokens do not reappear in recovered live interactions", async () => {
  const id = "loop-live-tokens";
  const started = await startLoginFlow(id, "mock-oauth");
  const used = [];
  try {
    let cursor = 0;
    const nextPrompt = async () => {
      for (let i = 0; i < 200; i++) {
        const poll = pollLoginFlow(id, cursor);
        cursor = poll.lastSeq;
        const prompt = poll.events.find(({ event }) => event.type === "prompt_request");
        if (prompt) return prompt.event.token;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("fake prompt missing");
    };
    const initial = await nextPrompt();
    assert.equal(submitLoginCode("mock-oauth", initial, "trigger-loop").status, "accepted");
    used.push(initial);
    for (let i = 0; i < 40; i++) {
      const token = await nextPrompt(); used.push(token);
      assert.equal(submitLoginCode("mock-oauth", token, `answer-${i}`).status, "accepted");
    }
    const final = await nextPrompt();
    const poll = pollLoginFlow(id, 0);
    assert.equal(poll.truncated, true);
    assert.deepEqual(poll.currentInteraction.map((event) => event.token).filter(Boolean), [final]);
    for (const token of used) assert.equal(submitLoginCode("mock-oauth", token, "old").status, "no_pending");
    assert.equal(submitLoginCode("mock-oauth", final, "finish").status, "accepted");
    await started.promise;
  } finally {
    cancelLoginFlow(id);
    await Promise.allSettled([started.promise]);
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
