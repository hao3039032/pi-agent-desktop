import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { convertAdapterServer, runMcpAdapterMigration } = await jiti.import("./mcp-migration.ts");

test("stdio server fields convert to pi's mcp.json shape", () => {
  assert.deepEqual(
    convertAdapterServer({
      command: "npx",
      args: ["-y", "server-filesystem", "."],
      env: { API_KEY: "k" },
      cwd: "/tmp",
      description: "Files",
      lifecycle: "keep-alive",
      requestTimeoutMs: 45000,
      disabled: true,
      excludeTools: ["noisy_tool"],
    }),
    {
      command: "npx",
      args: ["-y", "server-filesystem", "."],
      env: { API_KEY: "k" },
      cwd: "/tmp",
      description: "Files",
      timeout: 45,
      enabled: false,
      toolExposure: { noisy_tool: "hidden" },
    },
  );
});

test("http server with oauth and direct tools converts", () => {
  assert.deepEqual(
    convertAdapterServer({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: { clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:8765/callback" },
      directTools: true,
    }),
    {
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: { clientId: "c", clientSecret: "s", callbackUrl: "http://127.0.0.1:8765/callback" },
      exposure: "direct",
    },
  );
});

test("directTools search and name lists map to deferred and toolExposure", () => {
  assert.deepEqual(convertAdapterServer({ url: "https://x/mcp", directTools: "search" }), {
    url: "https://x/mcp",
    exposure: "deferred",
  });
  assert.deepEqual(convertAdapterServer({ command: "srv", directTools: ["a", "b"] }), {
    command: "srv",
    toolExposure: { a: "direct", b: "direct" },
  });
});

test("legacy SSE and untyped entries are skipped", () => {
  assert.equal(convertAdapterServer({ type: "sse", url: "https://x/sse" }), null);
  assert.equal(convertAdapterServer({ command: 42 }), null);
  assert.equal(convertAdapterServer("nope"), null);
});

function makeAgentDir() {
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-mig-"));
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  mkdirSync(join(home, ".config", "mcp"), { recursive: true });
  return { agentDir, home };
}

test("migration moves servers and settings once, and is a no-op the second time", async (t) => {
  const { agentDir, home } = makeAgentDir();
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        // Bare npm spec (the form a user adds by hand) — the migration's job.
        // The bundled-path form is pruned by reconcilePackages (see
        // packages.test.mjs "dropped from the bundle"), which owns previous state.
        packages: ["npm:pi-mcp-adapter@^5.0.0", "npm:keep-me"],
        extensions: ["-builtin:mcp", "custom.ts"],
      }),
    );
    writeFileSync(
      join(agentDir, "mcp-adapter.json"),
      JSON.stringify({
        settings: { scriptMode: true },
        mcpServers: {
          "adapter-server": { command: "adapter-bin", args: ["--flag"], requestTimeoutMs: 3000 },
          "sse-server": { type: "sse", url: "https://x/sse" },
        },
      }),
    );
    writeFileSync(
      join(home, ".config", "mcp", "mcp.json"),
      JSON.stringify({ mcpServers: { "shared-server": { url: "https://shared/mcp", directTools: true } } }),
    );
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "adapter-server": { command: "already-here" } } }),
    );

    const manager = SettingsManager.create(agentDir, agentDir);
    const report = runMcpAdapterMigration(agentDir, manager);
    await manager.flush();

    // The adapter's own definition loses to the existing official entry.
    assert.deepEqual(report.migratedServers, ["shared-server"]);
    assert.deepEqual(report.skippedServers, ["sse-server"]);
    assert.equal(report.removedPackageEntries, 1);
    assert.equal(report.restoredBuiltinMcp, true);

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, ["npm:keep-me"]);
    assert.deepEqual(settings.extensions, ["custom.ts"]);

    const mcp = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers, {
      "adapter-server": { command: "already-here" }, // untouched
      "shared-server": { url: "https://shared/mcp", exposure: "direct" },
    });

    // Second run: nothing left to do.
    const manager2 = SettingsManager.create(agentDir, agentDir);
    const report2 = runMcpAdapterMigration(agentDir, manager2);
    await manager2.flush();
    assert.deepEqual(report2.migratedServers, []);
    assert.equal(report2.removedPackageEntries, 0);
    assert.equal(report2.restoredBuiltinMcp, false);
    const mcp2 = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp2.mcpServers).sort(), ["adapter-server", "shared-server"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("an unreadable mcp.json never gets clobbered", async (t) => {
  const { agentDir, home } = makeAgentDir();
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    writeFileSync(join(agentDir, "mcp.json"), "{ not json");
    writeFileSync(
      join(agentDir, "mcp-adapter.json"),
      JSON.stringify({ mcpServers: { "adapter-server": { command: "x" } } }),
    );

    const manager = SettingsManager.create(agentDir, agentDir);
    const report = runMcpAdapterMigration(agentDir, manager);
    await manager.flush();
    assert.equal(report.migratedServers.length, 0);
    assert.equal(report.warnings.length, 1);
    assert.equal(readFileSync(join(agentDir, "mcp.json"), "utf8"), "{ not json");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("a machine that never had the adapter migrates nothing", async (t) => {
  const { agentDir, home } = makeAgentDir();
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:keep-me"] }));
    const manager = SettingsManager.create(agentDir, agentDir);
    const report = runMcpAdapterMigration(agentDir, manager);
    await manager.flush();
    assert.equal(report.removedPackageEntries, 0);
    assert.equal(report.restoredBuiltinMcp, false);
    assert.deepEqual(report.migratedServers, []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
