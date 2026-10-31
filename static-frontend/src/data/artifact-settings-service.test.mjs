import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const {
  bindArtifactsSettingsService,
  fetchArtifactsSettings,
  saveArtifactsSettings,
} = await jiti.import("./artifact-settings-service.ts");

test("static artifact-settings-service fetches and saves artifact settings over mock transport", async () => {
  const transport = new MockTransport();
  let savedArgs = null;

  transport.on("artifacts.settingsGet", () => ({
    enabled: true,
  }));

  transport.on("artifacts.settingsSet", (args) => {
    savedArgs = args;
    return {
      enabled: args?.enabled ?? true,
    };
  });

  const client = new IpcClient(transport);
  bindArtifactsSettingsService(client);

  const initial = await fetchArtifactsSettings();
  assert.equal(initial.enabled, true);

  const updated = await saveArtifactsSettings(false);
  assert.equal(updated.enabled, false);
  assert.deepEqual(savedArgs, { enabled: false });
});
