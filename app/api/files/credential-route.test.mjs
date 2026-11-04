import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";
import { fileSymlinkSkip } from "../../../scripts/test-platform.mjs";

// A session whose cwd is the home directory makes all of ~ an allowed root.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-credential-home-")));
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const { isCredentialPath } = await jiti.import("../../../lib/credential-paths.ts");
allowFileRoot(home);

function write(relative, content = "secret") {
  const filePath = path.join(home, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function get(filePath, type) {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return GET(
    new NextRequest(`http://localhost/api/files/x${type ? `?type=${type}` : ""}`),
    { params: Promise.resolve({ path: segments }) },
  );
}

const key = write(".ssh/id_ed25519", "PRIVATE KEY");
const auth = write(".pi/agent/auth.json", "{\"provider\":{\"key\":\"sk-test\"}}");
// The relay identity is the desktop's private key pair; relay.json holds the
// admin token and web-push.json the VAPID private key. One GET must not hand
// any of them over.
const relayIdentity = write(
  ".pi/agent/pi-web/relay-identity.json",
  JSON.stringify({ noisePrivate: "bm9pc2Uta2V5", signingPrivate: { d: "c2lnbmluZy1rZXk" } }),
);
const relayConfig = write(".pi/agent/pi-web/relay.json", JSON.stringify({ adminToken: "relay-admin-token" }));
// models.json may carry literal provider keys; the settings API redacts them, a
// file read must not hand them out either.
const models = write(".pi/agent/models.json", JSON.stringify({ providers: { custom: { apiKey: "literal-provider-key" } } }));
const pushKeys = write(".pi/agent/web-push.json", JSON.stringify({ vapidKeys: { privateKey: "vapid-private" } }));
const project = write("work/app/README.md", "hello");

test("credential stores under ~ are refused for every read type", async () => {
  for (const target of [key, auth, relayIdentity, relayConfig, pushKeys, models]) {
    for (const type of [undefined, "read", "download", "serve", "meta", "preview"]) {
      const response = await get(target, type);
      assert.equal(response.status, 403, `${type ?? "untyped"} ${target}`);
      assert.doesNotMatch(
        await response.text(),
        /PRIVATE KEY|sk-test|bm9pc2Uta2V5|c2lnbmluZy1rZXk|relay-admin-token|vapid-private|literal-provider-key/,
      );
    }
  }
  assert.equal((await get(path.join(home, ".ssh"), "list")).status, 403);
});

test("ordinary files under the same root still open", async () => {
  const response = await get(project, "read");
  assert.equal(response.status, 200);
});

test("case variants and links into a credential store are refused", { skip: fileSymlinkSkip }, async () => {
  const link = path.join(home, "work", "innocent.txt");
  fs.symlinkSync(key, link);
  assert.equal((await get(link, "read")).status, 403);
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(isCredentialPath(path.join(home, ".SSH", "id_ed25519"), home), true);
  }
});

test("uploads into a credential store are refused", async () => {
  const form = new FormData();
  form.append("file", new Blob(["ssh-ed25519 AAAA attacker"]), "authorized_keys");
  const response = await POST(
    new NextRequest("http://localhost/api/files/x?type=upload", {
      method: "POST",
      body: form,
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ path: path.join(home, ".ssh").split("/").filter(Boolean) }) },
  );
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(path.join(home, ".ssh", "authorized_keys")), false);
});

test("isCredentialPath covers the listed stores and leaves project secrets alone", () => {
  for (const relative of [
    ".aws/credentials",
    ".netrc",
    ".git-credentials",
    ".docker/config.json",
    ".config/gcloud/x",
    ".pi/agent/pi-web/relay-identity.json",
    ".pi/agent/pi-web/relay-devices.json",
    ".pi/agent/web-push.json",
    ".pi/agent/models.json",
  ]) {
    assert.equal(isCredentialPath(path.join(home, relative), home), true, relative);
  }
  for (const relative of ["work/app/.env", ".sshrc", ".pi/agent/settings.json", ".docker/other.json"]) {
    assert.equal(isCredentialPath(path.join(home, relative), home), false, relative);
  }
});
