import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  queryModelCatalog,
  discoverModels,
  testModel,
  loadNonChatModels,
  refreshProviderCatalogs,
  queryProviderUsageReport,
} = await jiti.import("./models-extras-service.server.ts");

const {
  fetchModelCatalogPresets,
  discoverProviderModels,
  testModelConfiguration,
  fetchNonChatModels,
  refreshModelCatalog,
  fetchProviderUsage,
} = await jiti.import("./models-extras-service.ts");

function createAgentDir(t, modelsJson) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-extras-seam-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });
  if (modelsJson !== undefined) {
    writeFileSync(
      join(root, "models.json"),
      typeof modelsJson === "string" ? modelsJson : JSON.stringify(modelsJson, null, 2),
    );
  }
  return root;
}

test("modelsConfig.catalog: queries models.dev catalog and filters presets", async (t) => {
  const catalogPayload = {
    testprovider: {
      name: "Test Provider",
      models: {
        "test-fast": {
          name: "Test Fast Model",
          pricing: { input: 1.5, output: 3.0 },
        },
        "test-smart": {
          name: "Test Smart Model",
          pricing: { input: 10, output: 30 },
        },
      },
    },
  };

  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(catalogPayload));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const sourceUrl = `http://127.0.0.1:${port}/api.json`;
  const result = await queryModelCatalog({ q: "fast", provider: "testprovider", limit: 10 }, sourceUrl);

  assert.equal(result.source, sourceUrl);
  assert.ok(Array.isArray(result.models));
  assert.ok(result.models.some((m) => m.id === "test-fast"));
});

test("modelsConfig.discover: fetches and parses upstream models with auth headers", async (t) => {
  const receivedHeaders = {};
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(req.headers)) {
      receivedHeaders[k] = v;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "discovered-model-1", name: "Discovered Model 1" },
        { id: "discovered-model-2" },
      ],
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const result = await discoverModels({
    providerName: "custom-test",
    provider: {
      baseUrl,
      api: "openai-completions",
      apiKey: "discovery-secret-token",
    },
  });

  assert.equal(receivedHeaders["authorization"], "Bearer discovery-secret-token");
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, "discovered-model-1");
  assert.equal(result.models[1].id, "discovered-model-2");
});

test("modelsConfig.discover: merges stored literal apiKey when omitted in draft", async (t) => {
  createAgentDir(t, {
    providers: {
      "saved-provider": {
        apiKey: "literal-saved-key",
        baseUrl: "http://127.0.0.1:9/v1",
      },
    },
  });

  const receivedHeaders = {};
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(req.headers)) {
      receivedHeaders[k] = v;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: "model-x" }],
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const result = await discoverModels({
    providerName: "saved-provider",
    provider: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      // apiKey intentionally omitted
    },
  });

  assert.equal(receivedHeaders["authorization"], "Bearer literal-saved-key");
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "model-x");
});

test("modelsConfig.test: completes simple test against local fixture and hides apiKey", async (t) => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount++;
    assert.equal(req.headers["authorization"], "Bearer test-run-token");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  createAgentDir(t, { providers: {} });

  const result = await testModel({
    providerName: "fixture-prov",
    provider: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "test-run-token",
    },
    model: {
      id: "unit-test-model",
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.responseText, "OK");
  assert.ok(typeof result.latencyMs === "number");
  // Ensure the secret is never returned in the result payload
  assert.equal(JSON.stringify(result).includes("test-run-token"), false);
});

test("modelsConfig.test: handles upstream failure gracefully", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  createAgentDir(t, { providers: {} });

  const result = await testModel({
    providerName: "fixture-prov",
    provider: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "wrong-token",
    },
    model: {
      id: "unit-test-model",
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("models.nonchat: returns classifier and image model lists with codemode preference", async (t) => {
  createAgentDir(t, { providers: {} });
  const result = await loadNonChatModels();

  assert.ok("classifier" in result);
  assert.ok("image" in result);
  assert.ok(Array.isArray(result.classifier));
  assert.ok(Array.isArray(result.image));
  assert.ok(result.codemode === "automatic" || result.codemode === "always");
});

test("models.refreshCatalog: runs catalog refresh and returns result shape", async () => {
  const result = await refreshProviderCatalogs();
  assert.equal(typeof result.completed, "boolean");
  assert.equal(typeof result.changed, "boolean");
});

test("models.providerUsage: validates provider ID and handles unsupported providers", async () => {
  await assert.rejects(
    () => queryProviderUsageReport("unsupported-provider-xyz"),
    /Unsupported provider/,
  );

  const result = await queryProviderUsageReport("deepseek");
  assert.equal(result.providerId, "deepseek");
  assert.ok(["ready", "auth-unavailable", "query-failed"].includes(result.status));
});

test("client HTTP functions issue correct requests and parse responses", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET", body: options.body });
    if (String(url).includes("/api/models-config/catalog")) {
      return new Response(JSON.stringify({ models: [{ id: "m1" }], source: "mock" }), { status: 200 });
    }
    if (String(url).includes("/api/models-config/discover")) {
      return new Response(JSON.stringify({ models: [{ id: "disc-1" }], endpoint: "http://endpoint" }), { status: 200 });
    }
    if (String(url).includes("/api/models-config/test")) {
      return new Response(JSON.stringify({ ok: true, latencyMs: 50, responseText: "OK" }), { status: 200 });
    }
    if (String(url).includes("/api/models/nonchat")) {
      return new Response(JSON.stringify({ classifier: [], image: [], codemode: "always" }), { status: 200 });
    }
    if (String(url).includes("/api/models/refresh")) {
      return new Response(JSON.stringify({ completed: true, changed: false }), { status: 200 });
    }
    if (String(url).includes("/api/provider-usage/query")) {
      return new Response(JSON.stringify({ providerId: "deepseek", status: "ready" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const catalog = await fetchModelCatalogPresets({ q: "llama", provider: "meta" });
  assert.equal(catalog.models[0].id, "m1");

  const discover = await discoverProviderModels({ providerName: "p", provider: {} });
  assert.equal(discover.models[0].id, "disc-1");

  const testRes = await testModelConfiguration({ providerName: "p", provider: {}, model: { id: "m" } });
  assert.equal(testRes.ok, true);

  const nonchat = await fetchNonChatModels();
  assert.equal(nonchat.codemode, "always");

  const refresh = await refreshModelCatalog("prov");
  assert.equal(refresh.completed, true);

  const usage = await fetchProviderUsage("deepseek");
  assert.equal(usage.status, "ready");
  assert.equal(requests.length, 6);
});
