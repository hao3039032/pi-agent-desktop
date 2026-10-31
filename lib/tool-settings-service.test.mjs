import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyToolSettingsChange,
  readToolSettings,
  ToolSettingsRefusalError,
} = await jiti.import("./tool-settings-service.server.ts");

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-tool-settings-srv-"));
const settingsPath = path.join(agentDir, "settings.json");

test.after(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

test("readToolSettings returns default view when settings.json is missing", async () => {
  const result = await readToolSettings(path.join(agentDir, "nonexistent.json"), "linux");
  assert.equal(result.isWindows, false);
  assert.equal(result.powerShellEnabled, false);
  assert.equal(result.codemode, "automatic");
  assert.deepEqual(result.codemodeMode, { value: "on" });
  assert.deepEqual(result.codemodeInlineBudget, {});
});

test("applyToolSettingsChange updates codemode preference and preserves other fields", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "gpt-4", unknownField: "keep-me" }));
  const res = await applyToolSettingsChange({ codemode: "always" }, settingsPath, "linux");
  assert.equal(res.codemode, "always");

  const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(onDisk.defaultModel, "gpt-4");
  assert.equal(onDisk.unknownField, "keep-me");
  assert.deepEqual(onDisk.defaultTools, ["+codemode"]);

  const res2 = await applyToolSettingsChange({ codemode: "automatic" }, settingsPath, "linux");
  assert.equal(res2.codemode, "automatic");
  const onDisk2 = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(onDisk2.defaultTools, undefined);
  assert.equal(onDisk2.unknownField, "keep-me");
});

test("applyToolSettingsChange updates codemodeMode and budget", async () => {
  await writeFile(settingsPath, JSON.stringify({ codemode: { mode: "on" } }));
  const modeRes = await applyToolSettingsChange({ codemodeMode: "only" }, settingsPath, "linux");
  assert.deepEqual(modeRes.codemodeMode, { value: "only" });

  const budgetRes = await applyToolSettingsChange({ codemodeInlineBudget: 5000 }, settingsPath, "linux");
  assert.deepEqual(budgetRes.codemodeInlineBudget, { value: 5000 });

  const disk = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(disk.codemode.mode, "only");
  assert.equal(disk.codemode.inlineBudget, 5000);
});

test("applyToolSettingsChange refuses invalid payloads", async () => {
  await assert.rejects(
    () => applyToolSettingsChange("not-object", settingsPath, "linux"),
    (err) => err instanceof ToolSettingsRefusalError && err.status === 400,
  );
  await assert.rejects(
    () => applyToolSettingsChange({}, settingsPath, "linux"),
    (err) => err instanceof ToolSettingsRefusalError && err.status === 400,
  );
  await assert.rejects(
    () => applyToolSettingsChange({ codemode: "invalid" }, settingsPath, "linux"),
    (err) => err instanceof ToolSettingsRefusalError && err.status === 400,
  );
  await assert.rejects(
    () => applyToolSettingsChange({ enabled: true }, settingsPath, "linux"),
    (err) => err instanceof ToolSettingsRefusalError && err.status === 404,
  );
});

test("applyToolSettingsChange updates PowerShell on Windows", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultTools: ["read", "bash"] }));
  const res = await applyToolSettingsChange({ enabled: true }, settingsPath, "win32");
  assert.equal(res.powerShellEnabled, true);
  const disk = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(disk.defaultTools, ["read", "powershell"]);
});
