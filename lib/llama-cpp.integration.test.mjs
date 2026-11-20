import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { cleanupDir, resolvePiCliBin } from "./pi-rpc/test-utils.mjs";

// CLI-engine port of upstream's in-process integration test: the Settings /
// auth / picker flow still runs against the host's model runtime, but a fresh
// session is a real `pi --mode rpc` child, so the router is a real local HTTP
// server (a host-side fetch mock cannot reach the child) and the session part
// needs PI_CLI_BIN like the other real-CLI smoke tests. The child reads the
// catalog the host's refresh persisted into the shared agentDir, restores the
// default model from settings.json, and reports it through get_state — the
// SDK's prepareRequest seam does not exist on this side of the pipe.
const executable = resolvePiCliBin();

test("Settings lists llama.cpp, connects a router and makes its model available to a fresh session", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-llama-"));
  t.after(() => cleanupDir(agentDir));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.LLAMA_BASE_URL;
  delete process.env.LLAMA_API_KEY;
  delete process.env.PI_OFFLINE;

  let models = [{ id: "local-chat", status: { value: "loaded" }, meta: { n_ctx: 8192 } }];
  const seenAuth = [];
  const routerServer = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    if (req.url?.split("?")[0] === "/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: models }));
      return;
    }
    if (req.url?.split("?")[0] === "/props") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => routerServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => routerServer.close(resolve)));
  const router = `http://127.0.0.1:${routerServer.address().port}`;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const listing = await jiti.import("../app/api/auth/providers/route.ts");
  const auth = await jiti.import("../app/api/auth/api-key/[provider]/route.ts");
  const picker = await jiti.import("../app/api/models/route.ts");
  const defaults = await jiti.import("../app/api/models/default/route.ts");
  const { startRpcSession } = await jiti.import("./rpc-manager.ts");
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { invalidateModelRuntimeWithExtensions } = await jiti.import("./model-runtime.ts");
  const { refreshModelCatalogs } = await jiti.import("./model-catalog-refresh.ts");
  const row = async () => (await (await listing.GET()).json()).apiKeyProviders.find((p) => p.id === "llama.cpp");
  allowFileRoot(agentDir);
  async function pickedModels() {
    const response = await picker.GET(new Request("http://localhost/?cwd=" + encodeURIComponent(agentDir)));
    const { modelList } = await response.json();
    return modelList.filter((model) => model.provider === "llama.cpp").map((model) => model.id);
  }
  const params = { params: Promise.resolve({ provider: "llama.cpp" }) };
  const save = (body) => auth.POST(new Request("http://localhost/", { method: "POST", body: JSON.stringify(body) }), params);

  assert.equal((await row()).configured, false);
  assert.equal((await save({ serverUrl: "invalid" })).status, 400);
  for (const apiKey of ["", "test-llama-key"]) {
    const response = await save({ serverUrl: router + "/v1", apiKey });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.catalog.completed, true, JSON.stringify(result));
    assert.equal((await row()).configured, true);
    const stored = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))["llama.cpp"];
    assert.equal(stored.env.LLAMA_BASE_URL, router);
    assert.equal(stored.key, apiKey || undefined);
    // The catalog refresh authenticated against the router with the stored key.
    assert.ok(seenAuth.includes(apiKey ? `Bearer ${apiKey}` : ""), "the router saw the configured credential");
    assert.deepEqual(await pickedModels(), ["local-chat"]);
    const saved = await defaults.PUT(new Request("http://localhost/", {
      method: "PUT", body: JSON.stringify({ cwd: agentDir, provider: "llama.cpp", modelId: "local-chat" }),
    }));
    assert.equal(saved.status, 200, await saved.text());
    if (executable) {
      const { session } = await startRpcSession(`__new__${randomUUID()}`, "", agentDir);
      try {
        const { model } = session.inner;
        assert.equal(model.provider, "llama.cpp");
        assert.equal(model.id, "local-chat");
        assert.equal(model.contextWindow, 8192);
        // The child's own catalog (persisted by the host refresh, re-read by
        // the child's llama provider) carries the router's inference URL.
        await session.inner.modelRuntime.refresh();
        const catalogModel = session.inner.modelRuntime.getModel("llama.cpp", "local-chat");
        assert.equal(catalogModel?.baseUrl, router + "/v1");
      } finally {
        await session.shutdown();
      }
    }
  }
  // An empty catalog must also reach the picker after the previous one was remembered.
  models = [];
  await refreshModelCatalogs({ providers: ["llama.cpp"] });
  assert.deepEqual(await pickedModels(), []);
  assert.equal((await auth.DELETE(null, params)).status, 200);
  assert.equal((await row()).configured, false);

  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:llama.cpp"] }));
  invalidateModelRuntimeWithExtensions();
  assert.equal(await row(), undefined);
});
