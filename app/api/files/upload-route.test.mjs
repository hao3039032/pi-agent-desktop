// Pins the boundary the import-cap removal (a9b2975) left behind in
// app/api/files/[...path]/route.ts: the browser multipart upload keeps its
// per-file 25MB cap, while the desktop path-import branch keeps only the
// desktop-token guard (and the 100-file count cap). The 100MB total branch is
// deliberately not tested — it only fires past a >100MB multipart body, which
// costs more time and memory than the boundary is worth; the per-file 413
// below exercises the same MAX_UPLOAD_* constants and 413 handling.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-route-")));
const uploadDir = path.join(root, "drop-target");
fs.mkdirSync(uploadDir);
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
process.env.GIT_CEILING_DIRECTORIES = root;
// A token is configured (as the packaged shell would) but never sent: the
// requests below must be refused for lacking the header, not the env.
const TOKEN = "upload-route-test-token-0123456789abcdef";
process.env.PI_DESKTOP_API_TOKEN = TOKEN;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
allowFileRoot(root);

const params = Promise.resolve({
  path: uploadDir.replace(/\\/g, "/").split("/").filter(Boolean),
});

test("multipart upload rejects each file over 25MB", async () => {
  const form = new FormData();
  form.append("files", new File([Buffer.alloc(26 * 1024 * 1024)], "big.bin"));
  const response = await POST(
    new NextRequest("http://127.0.0.1:30141/api/files/x?type=upload", {
      method: "POST",
      // No content-type header: the FormData body sets the multipart
      // boundary itself, which parseFormDataWithinLimit re-uses.
      headers: { host: "127.0.0.1:30141" },
      body: form,
    }),
    { params },
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "Each upload must be 25MB or smaller");
});

test("path import without the desktop token is rejected", async () => {
  const response = await POST(
    new NextRequest("http://127.0.0.1:30141/api/files/x?type=import", {
      method: "POST",
      headers: {
        host: "127.0.0.1:30141",
        "content-type": "application/json",
        // Deliberately no x-pi-desktop-token header.
      },
      body: JSON.stringify({ sourcePaths: [path.join(root, "notes.txt")] }),
    }),
    { params },
  );
  // "Desktop authorization required" (not "Untrusted API request") proves the
  // request passed isApiRequestAllowed and the upload-directory resolution and
  // was refused by the desktop-token check itself.
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Desktop authorization required");
});
