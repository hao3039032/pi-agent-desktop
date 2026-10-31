import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const {
  bindCustomCssService,
  fetchCustomCss,
  ensureCustomCss,
} = await jiti.import("./custom-css-service.ts");

test("static custom-css-service fetches and ensures custom css over mock transport", async () => {
  const transport = new MockTransport();

  transport.on("appearance.customCssGet", () => ({
    css: "body { font-size: 16px; }",
    path: "/path/to/custom.css",
  }));

  transport.on("appearance.customCssSet", () => ({
    path: "/path/to/custom.css",
    created: true,
  }));

  const client = new IpcClient(transport);
  bindCustomCssService(client);

  const getRes = await fetchCustomCss();
  assert.equal(getRes.css, "body { font-size: 16px; }");
  assert.equal(getRes.path, "/path/to/custom.css");

  const setRes = await ensureCustomCss();
  assert.equal(setRes.path, "/path/to/custom.css");
  assert.equal(setRes.created, true);
});
