import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { bindDistroService, fetchDistroStatus, configureDistroService } = await jiti.import("./distro-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("distro status and configure use IPC and reject malformed status", async () => {
  const transport = new MockTransport();
  const calls = [];
  const status = { providerId: "fixture", providerName: "Fixture", configured: true, baseUrl: "http://localhost", hasApiKey: true, npmMirror: false };
  transport.on("distro.status", () => status);
  transport.on("distro.configure", (args) => { calls.push(args); return status; });
  bindDistroService(new IpcClient(transport));
  assert.deepEqual(await fetchDistroStatus(), status);
  assert.deepEqual(await configureDistroService({ baseUrl: "http://localhost", apiKey: "fixture-key", useNpmMirror: false }), status);
  assert.deepEqual(calls, [{ baseUrl: "http://localhost", apiKey: "fixture-key", useNpmMirror: false }]);
  transport.on("distro.status", () => ({}));
  await assert.rejects(fetchDistroStatus(), /Invalid distro status/);
});
