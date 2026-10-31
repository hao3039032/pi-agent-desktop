/**
 * Tests for the static app's state-mirror import/write path
 * (static-frontend/src/data/state-mirror.ts) — plan §七.4–5: import before
 * mount, never invent a snapshot, never roll back newer local values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const mirrorModule = await jiti.import("./state-mirror.ts");
const { importStateMirrorBeforeMount } = mirrorModule;
const { stateMirrorChecksum } = await jiti.import("../../../lib/state-mirror.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

/** A minimal localStorage double. */
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get backing() {
      return store;
    },
  };
}

function mirrorPayload(entries, revision) {
  return {
    schemaVersion: 1,
    revision,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: "test",
    checksum: stateMirrorChecksum(entries),
    entries,
  };
}

test("the import lands only absent keys and records the revision", async () => {
  const storage = fakeStorage({ "pi-theme": "NEWER-LOCAL" });
  const mock = new MockTransport().on("desktop.stateMirror", () =>
    mirrorPayload({ "pi-theme": "exported-old", "pi-tool-preset": "full" }, 7),
  );
  const client = new IpcClient(mock);
  globalThis.window = { localStorage: storage };
  try {
    const report = await importStateMirrorBeforeMount(client);
    assert.deepEqual(report, { imported: 1, skippedExisting: 1, revision: 7 });
    assert.equal(storage.backing.get("pi-theme"), "NEWER-LOCAL", "local value wins");
    assert.equal(storage.backing.get("pi-tool-preset"), "full", "absent key imported");
    assert.equal(storage.backing.get("pi-web:state-mirror-revision"), "7");
  } finally {
    delete globalThis.window;
  }
});

test("a missing mirror imports nothing (never an invented snapshot)", async () => {
  const storage = fakeStorage();
  const mock = new MockTransport().on("desktop.stateMirror", () => ({ missing: true }));
  const client = new IpcClient(mock);
  globalThis.window = { localStorage: storage };
  try {
    const report = await importStateMirrorBeforeMount(client);
    assert.equal(report, null);
    assert.equal(storage.backing.size, 0);
  } finally {
    delete globalThis.window;
  }
});

test("a corrupt or unverifiable payload imports nothing", async () => {
  for (const bad of [
    { schemaVersion: 99, revision: 1, entries: {} },
    { not: "a payload" },
    "string",
  ]) {
    const storage = fakeStorage();
    const mock = new MockTransport().on("desktop.stateMirror", () => bad);
    const client = new IpcClient(mock);
    globalThis.window = { localStorage: storage };
    try {
      const report = await importStateMirrorBeforeMount(client);
      assert.equal(report, null, JSON.stringify(bad));
      assert.equal(storage.backing.size, 0);
    } finally {
      delete globalThis.window;
    }
  }
});

test("a transport failure at boot leaves local state untouched", async () => {
  const storage = fakeStorage({ "pi-theme": "local" });
  const mock = new MockTransport(); // no handler → unknown_op failure
  const client = new IpcClient(mock);
  globalThis.window = { localStorage: storage };
  try {
    const report = await importStateMirrorBeforeMount(client);
    assert.equal(report, null);
    assert.equal(storage.backing.get("pi-theme"), "local");
  } finally {
    delete globalThis.window;
  }
});
