import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getMcpConfig, McpServiceError } = await jiti.import("./mcp-service.server.ts");

test("host-authorized roots scope management MCP reads independently of web roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-host-roots-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "fixture" } } }));
    const result = await getMcpConfig({ agentDir, cwd, allowedRoots: new Set([cwd]) });
    assert.ok(result.servers.some((server) => server.scope === "project" && server.name === "fixture"));
    await assert.rejects(getMcpConfig({ agentDir, cwd, allowedRoots: new Set() }), (error) => error instanceof McpServiceError && error.reason === "cwd-denied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
