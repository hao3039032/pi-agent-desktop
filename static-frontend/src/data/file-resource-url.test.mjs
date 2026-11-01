import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });
const { bindFileService } = await jiti.import("./file-service");
const { openSessionImageResourceUrl } = await jiti.import("./file-resource-url.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("session image URL and save use one opaque resource handle and revoke", async () => {
  const previous = globalThis.window;
  const revoked = [];
  const mock = new MockTransport().on("sessions.entryToolResultImage", (args) => {
    assert.deepEqual(args, { session: "s1", entryId: "e1", blockIndex: 3 });
    return { handle: "opaque" };
  }).on("resources.revoke", ({ handle }) => { revoked.push(handle); return { revoked: true }; });
  bindFileService(new IpcClient(mock));
  try {
    globalThis.window = { __TAURI_INTERNALS__: {
      convertFileSrc: (handle, protocol) => { assert.equal(protocol, "pi-resource"); return `resource:${handle}`; },
      invoke: async (command, args) => { assert.equal(command, "save_resource_as"); assert.deepEqual(args, { handle: "opaque", defaultFileName: "image.png" }); return true; },
    } };
    const resource = await openSessionImageResourceUrl("s1", "e1", 3);
    assert.equal(resource.url, "resource:opaque");
    assert.equal(await resource.save("image.png"), true);
    resource.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(revoked, ["opaque"]);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
