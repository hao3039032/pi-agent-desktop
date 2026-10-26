import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { isMcpDisabledByOperator, readBuiltinExtensionSwitches } = await jiti.import("./builtin-extensions.ts");

test("PI_WEB_DISABLE_MCP turns MCP off for any value but empty, 0, or false", () => {
  assert.equal(isMcpDisabledByOperator({}), false);
  for (const value of ["", " ", "0", "false", "FALSE"]) {
    assert.equal(isMcpDisabledByOperator({ PI_WEB_DISABLE_MCP: value }), false, JSON.stringify(value));
  }
  for (const value of ["1", "true", "yes", "on"]) {
    assert.equal(isMcpDisabledByOperator({ PI_WEB_DISABLE_MCP: value }), true, value);
  }
});

test("the extensions settings switch built-ins off as the session's resource loader would", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-builtin-switches-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const on = { enabled: true };
  const read = (projectTrusted = true) => readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted });

  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: on });

  // Never installs: a configured package that is missing is not even looked up.
  await writeFile(globalPath, JSON.stringify({ extensions: ["-builtin:mcp"], packages: ["npm:pi-web-test-not-a-package"] }));
  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } });

  // A trusted project's entry overrides the global one; an untrusted project's is not read. Each
  // switch then also says what the global list alone makes of it, for a global setting to be weighed against.
  await writeFile(projectPath, JSON.stringify({ extensions: ["+builtin:mcp", "-builtin:codemode"] }));
  assert.deepEqual(await read(), {
    codemode: { enabled: false, settingsPath: projectPath, global: on },
    "tool-search": { ...on, global: on },
    mcp: { ...on, global: { enabled: false, settingsPath: globalPath } },
  });
  assert.deepEqual(await read(false), { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } });
  assert.deepEqual(
    await readBuiltinExtensionSwitches({ agentDir, projectTrusted: true }),
    { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } },
    "without a project only the global settings count",
  );

  // Patterns follow the SDK's rules, not a string comparison.
  await writeFile(globalPath, `\uFEFF${JSON.stringify({ extensions: ["!builtin:*", "+builtin:tool-search"] })}`);
  await rm(projectPath);
  const off = { enabled: false, settingsPath: globalPath };
  assert.deepEqual(await read(), { codemode: off, "tool-search": on, mcp: off });

  await writeFile(globalPath, "{ not json");
  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: on }, "an unparsable file counts as empty, as in the SDK");
});

test("a trusted project's settings that are not a regular file never stall the switches read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-builtin-switches-fifo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const projectPath = join(cwd, ".pi", "settings.json");
  const read = () => readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted: true });

  // A directory, and a file past the cap, throw as an unreadable file does; the overview then keeps the built-ins on.
  await mkdir(projectPath);
  await assert.rejects(read(), /not a regular file/);
  await rm(projectPath, { recursive: true });
  await writeFile(projectPath, `{"extensions":[],"pad":"${"x".repeat(1024 * 1024)}"}`);
  await assert.rejects(read(), /larger than/);
  if (process.platform !== "win32") {
    // A plain readFileSync() would wait on a FIFO until something writes to it, holding the whole server.
    await rm(projectPath);
    execFileSync("mkfifo", [projectPath]);
    await assert.rejects(read(), /not a regular file/);
    // Untrusted, the project's file is never opened at all.
    assert.deepEqual(
      await readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted: false }),
      { codemode: { enabled: true }, "tool-search": { enabled: true }, mcp: { enabled: true } },
    );
  }
});
