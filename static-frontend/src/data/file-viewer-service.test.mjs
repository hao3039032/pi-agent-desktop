import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { bindFileService } = await jiti.import("./file-service.ts");
const { watchFile } = await jiti.import("./file-viewer-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("file watcher reports host revisions and closes without further polling", async () => {
  const mock = new MockTransport(); bindFileService(new IpcClient(mock));
  let metadataCalls = 0;
  mock.on("resources.grantFile", () => ({ handle: "token" }));
  mock.on("resources.metadata", () => ({ size: ++metadataCalls, revision: String(metadataCalls) }));
  mock.on("resources.revoke", () => ({ revoked: true }));
  const watcher = watchFile("/project/a.txt");
  const events = [];
  watcher.addEventListener("connected", () => events.push("connected"));
  watcher.addEventListener("change", (event) => events.push(JSON.parse(event.data).size));
  await new Promise((resolve) => setTimeout(resolve, 2150));
  watcher.close();
  assert.deepEqual(events, ["connected", 2]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(metadataCalls, 2);
});
