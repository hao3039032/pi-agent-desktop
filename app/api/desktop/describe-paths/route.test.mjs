import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-describe-paths-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const TOKEN = "describe-paths-test-token-0123456789abcdef";
process.env.PI_DESKTOP_API_TOKEN = TOKEN;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function request(body, { token = TOKEN } = {}) {
  return POST(
    new NextRequest("http://127.0.0.1:30141/api/desktop/describe-paths", {
      method: "POST",
      headers: {
        host: "127.0.0.1:30141",
        "content-type": "application/json",
        ...(token ? { "x-pi-desktop-token": token } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test("requires the desktop token", async () => {
  const response = await request({ paths: [root] }, { token: "" });
  assert.equal(response.status, 403);
});

test("rejects malformed path lists", async () => {
  assert.equal((await request({ paths: "nope" })).status, 400);
  assert.equal((await request({ paths: [] })).status, 400);
  assert.equal((await request({ paths: [42] })).status, 400);
  assert.equal((await request("{not json")).status, 400);
  // The cap matches the files route's import cap (MAX_IMPORT_FILES).
  assert.equal((await request({ paths: Array.from({ length: 101 }, (_, i) => `C:\\x${i}`) })).status, 400);
});

test("accepts exactly the import cap in paths", async () => {
  const response = await request({ paths: Array.from({ length: 100 }, (_, i) => `C:\\x${i}`) });
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.equal(items.length, 100);
});

test("describes files, directories, and missing paths", async () => {
  const dir = path.join(root, "folder");
  const image = path.join(root, "shot.png");
  const doc = path.join(root, "notes.md");
  fs.mkdirSync(dir);
  fs.writeFileSync(image, "png");
  fs.writeFileSync(doc, "md");

  const response = await request({ paths: [dir, image, doc, path.join(root, "gone")] });
  assert.equal(response.status, 200);
  const { items } = await response.json();

  assert.deepEqual(items, [
    { path: dir, kind: "directory" },
    { path: image, kind: "file", imageMime: "image/png", size: 3 },
    { path: doc, kind: "file", size: 2 },
    { path: path.join(root, "gone"), kind: "missing" },
  ]);
});

test("reports non-absolute and symlinked paths as other", async (t) => {
  const target = path.join(root, "notes.md");
  const link = path.join(root, "link.md");
  try {
    fs.symlinkSync(target, link);
  } catch {
    t.skip("creating symlinks requires privileges on this system");
    return;
  }

  const response = await request({ paths: ["relative/path", link] });
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.deepEqual(items.map((item) => item.kind), ["other", "other"]);
});
