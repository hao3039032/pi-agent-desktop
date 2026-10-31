import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { bindFileService } = await jiti.import("./file-service.ts");
const { uploadProjectFiles } = await jiti.import("./project-file-upload-client.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("browser uploads use the host's inspection and bounded file operation", async () => {
  const mock = new MockTransport(); bindFileService(new IpcClient(mock));
  mock.on("files.uploadCheck", (args) => { assert.deepEqual(args, { directory: "/project", fileNames: ["a.txt"] }); return { conflicts: [], nonReplaceable: [] }; });
  mock.on("files.uploadFile", (args) => { assert.equal(args.directory, "/project"); assert.equal(args.name, "a.txt"); assert.equal(args.data, "aGVsbG8="); assert.equal(args.conflict, "skip"); return { outcome: "uploaded" }; });
  const file = new File(["hello"], "a.txt");
  const result = await uploadProjectFiles("/project", [file], "skip");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.uploaded, ["a.txt"]);
});

test("conflict preflight does not issue a write", async () => {
  const mock = new MockTransport(); bindFileService(new IpcClient(mock));
  mock.on("files.uploadCheck", () => ({ conflicts: ["a.txt"], nonReplaceable: ["a.txt"] }));
  let writes = 0; mock.on("files.uploadFile", () => { writes++; return { outcome: "uploaded" }; });
  const result = await uploadProjectFiles("/project", [new File(["x"], "a.txt")], "overwrite");
  assert.equal(result.status, 409);
  assert.equal(writes, 0);
});
