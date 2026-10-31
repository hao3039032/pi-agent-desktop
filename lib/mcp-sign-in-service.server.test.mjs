import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { approveSignIn, startFakeOAuthServer } from "./__fixtures__/mcp-oauth-server.mjs";

test("management sign-in service validates and submits a local fake OAuth flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-managed-oauth-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let fake;
  try {
    await mkdir(agentDir);
    fake = await startFakeOAuthServer();
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fake.url }, cancel: { url: fake.url } } }));
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
    const service = await jiti.import("./mcp-sign-in-service.server.ts");
    const first = await service.startManagedMcpSignIn({ agentDir, allowedRoots: new Set(), body: { scope: "global", name: "fixture" } });
    let flow = first;
    for (let n = 0; n < 500 && !["authorize", "done", "failed"].includes(flow.phase); n++) { await delay(20); flow = service.readManagedMcpSignIn(first.flowId); }
    assert.equal(flow.phase, "authorize", JSON.stringify(flow));
    const redirect = await approveSignIn(flow.authorizationUrl);
    assert.throws(() => service.submitManagedMcpSignIn(flow.flowId, redirect.replace(/state=[^&]+/, "state=forged")), (error) => error.reason === "redirect-state-mismatch");
    service.submitManagedMcpSignIn(flow.flowId, redirect);
    for (let n = 0; n < 500 && !["done", "failed"].includes(flow.phase); n++) { await delay(20); flow = service.readManagedMcpSignIn(first.flowId); }
    assert.equal(flow.phase, "done", JSON.stringify(flow));
    assert.equal(flow.result.state, "connected");
    const cancel = await service.startManagedMcpSignIn({ agentDir, allowedRoots: new Set(), body: { scope: "global", name: "cancel" } });
    assert.equal(service.cancelManagedMcpSignIn(cancel.flowId).phase, "cancelled");
    assert.equal(service.readManagedMcpSignIn(cancel.flowId).phase, "cancelled");
    assert.throws(() => service.readManagedMcpSignIn("missing"), (error) => error.reason === "sign-in-unknown");
    const project = join(root, "project");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fake.url } } }));
    await assert.rejects(service.startManagedMcpSignIn({ agentDir, allowedRoots: new Set([project]), body: { cwd: project, scope: "project", name: "fixture" } }), (error) => error.reason === "project-untrusted");
  } finally {
    if (fake) await fake.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
