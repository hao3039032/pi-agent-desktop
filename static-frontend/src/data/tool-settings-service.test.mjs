import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const {
  bindToolSettingsService,
  fetchToolSettings,
  saveToolSettings,
  ToolSettingsError,
} = await jiti.import("./tool-settings-service.ts");

test("static tool-settings-service fetches and saves settings over mock transport", async () => {
  const transport = new MockTransport();
  let savedChange = null;

  transport.on("tools.settingsGet", () => ({
    isWindows: false,
    powerShellEnabled: false,
    codemode: "automatic",
    codemodeMode: { value: "on" },
    codemodeInlineBudget: {},
  }));

  transport.on("tools.settingsSet", (args) => {
    savedChange = args;
    return {
      isWindows: false,
      powerShellEnabled: false,
      codemode: args?.codemode ?? "automatic",
      codemodeMode: { value: "on" },
      codemodeInlineBudget: {},
    };
  });

  const client = new IpcClient(transport);
  bindToolSettingsService(client);

  const initial = await fetchToolSettings();
  assert.equal(initial.codemode, "automatic");

  const updated = await saveToolSettings({ codemode: "always" });
  assert.equal(updated.codemode, "always");
  assert.deepEqual(savedChange, { codemode: "always" });
});

test("static tool-settings-service preserves failure reason", async () => {
  const transport = new MockTransport();
  transport.fail("tools.settingsSet", {
    code: "invalid_args",
    message: "codemodeMode must be on or only",
    reason: "invalid-request",
  });

  const client = new IpcClient(transport);
  bindToolSettingsService(client);

  await assert.rejects(
    () => saveToolSettings({ codemodeMode: "off" }),
    (err) => err instanceof ToolSettingsError && err.reason === "invalid-request",
  );
});
