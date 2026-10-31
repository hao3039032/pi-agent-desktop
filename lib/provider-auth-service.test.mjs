import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

// auth.json and models.json live in a temporary agent dir; nothing here
// touches ~/.pi, and PI_OFFLINE keeps the runtime from any network catalog.
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-provider-auth-service-"));
const authPath = join(agentDir, "auth.json");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  composeProviderLists,
  logoutProvider,
  ProviderAuthRefusalError,
  removeProviderApiKey,
  storeProviderApiKey,
} = await jiti.import("./provider-auth-service.server.ts");

const SECRET = "sk-service-test-ab12cd34ef56gh78";
const readAuth = async () => JSON.parse(await readFile(authPath, "utf8"));

beforeEach(async () => {
  await writeFile(authPath, JSON.stringify({
    openai: { type: "api_key", key: SECRET },
    anthropic: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 },
  }), { mode: 0o600 });
});

test("the listing reports sign-in state and never the stored secrets", async () => {
  const lists = await composeProviderLists();
  assert.deepEqual(lists.providers, lists.oauthProviders, "providers mirrors oauthProviders");
  const anthropic = lists.oauthProviders.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic, "anthropic is an OAuth provider");
  assert.equal(anthropic.loggedIn, true);
  assert.equal(typeof anthropic.supportsApiKey, "boolean");
  const openai = lists.apiKeyProviders.find((provider) => provider.id === "openai");
  assert.ok(openai, "openai is an API-key provider");
  assert.equal(openai.configured, true);
  // A dual-list refresh is the caller's job; the composition's own body
  // must never carry a secret either way.
  const serialized = JSON.stringify(lists);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("oauth-refresh"), false);
});

test("storing a key requires a usable value", async () => {
  for (const apiKey of ["", "   "]) {
    await assert.rejects(
      storeProviderApiKey("openai", apiKey),
      (error) => error instanceof ProviderAuthRefusalError
        && error.reason === "invalid_args"
        && error.message === "apiKey is required",
    );
  }
  assert.equal((await readAuth()).openai.key, SECRET, "refused saves change nothing");
});

test("storing a key replaces it trimmed and keeps other providers", async () => {
  await storeProviderApiKey("openai", `  ${SECRET}-new  `);
  const auth = await readAuth();
  assert.equal(auth.openai.type, "api_key");
  assert.equal(auth.openai.key, `${SECRET}-new`, "the stored key is trimmed");
  assert.equal(auth.anthropic.type, "oauth", "other providers untouched");

  const lists = await composeProviderLists();
  assert.equal(
    lists.apiKeyProviders.find((provider) => provider.id === "openai")?.configured,
    true,
  );
});

test("an API-key delete refuses an OAuth credential by type", async () => {
  await assert.rejects(
    removeProviderApiKey("anthropic"),
    (error) => error instanceof ProviderAuthRefusalError
      && error.reason === "credential_type_mismatch"
      && error.message === "anthropic is authenticated with OAuth, not an API key",
  );
  assert.equal((await readAuth()).anthropic.type, "oauth");

  await removeProviderApiKey("openai");
  const auth = await readAuth();
  assert.equal("openai" in auth, false);
  const lists = await composeProviderLists();
  assert.equal(
    lists.apiKeyProviders.find((provider) => provider.id === "openai")?.configured,
    false,
  );
});

test("logout refuses unknown providers and API-key credentials", async () => {
  await assert.rejects(
    logoutProvider("not-a-real-provider"),
    (error) => error instanceof ProviderAuthRefusalError
      && error.reason === "unknown_provider"
      && error.message === "Unknown provider: not-a-real-provider",
  );
  await assert.rejects(
    logoutProvider("openai"),
    (error) => error instanceof ProviderAuthRefusalError
      && error.reason === "credential_type_mismatch"
      && error.message === "openai is authenticated with an API key, not OAuth",
  );
  const auth = await readAuth();
  assert.equal(auth.openai.type, "api_key");
  assert.equal(auth.anthropic.type, "oauth");
});

test("logout removes the OAuth credential only", async () => {
  await logoutProvider("anthropic");
  const auth = await readAuth();
  assert.equal("anthropic" in auth, false);
  assert.equal(auth.openai.type, "api_key");
  const lists = await composeProviderLists();
  assert.equal(
    lists.oauthProviders.find((provider) => provider.id === "anthropic")?.loggedIn,
    false,
  );
});

test("storing a key on a provider without API-key login refuses", async () => {
  // anthropic declares both methods in current SDK releases; a provider id
  // that is entirely unknown fails the same gate the route answered 500.
  await assert.rejects(
    storeProviderApiKey("not-a-real-provider", SECRET),
    (error) => error instanceof ProviderAuthRefusalError
      && error.reason === "api_key_unsupported"
      && error.message === "not-a-real-provider does not support API key login",
  );
});
