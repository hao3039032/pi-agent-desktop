/**
 * The transition-version state mirror — client-side logic (plan §七.1–3):
 * whitelist-only collection, prefix-family caps, checksum stability and
 * payload verification. The server side (atomic writes, revision
 * monotonicity) is covered by lib/state-mirror-store.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  STATE_MIRROR_FAMILY_CAP,
  STATE_MIRROR_REVISION_KEY,
  STATE_MIRROR_SCHEMA_VERSION,
  STATE_MIRROR_VALUE_CAP,
  buildStateMirrorPayload,
  collectStateMirrorEntries,
  stateMirrorChecksum,
  stateMirrorWhitelist,
  verifyStateMirrorPayload,
} = await jiti.import("./state-mirror.ts");
const { APP_PREF_KEYS } = await jiti.import("./app-prefs.ts");

/** A localStorage stub with the key(i) index the browser API provides. */
function storageWith(entries) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
  };
}

test("the whitelist covers APP_PREF_KEYS and the independent upstream keys", () => {
  const whitelist = stateMirrorWhitelist();
  for (const key of Object.values(APP_PREF_KEYS)) {
    assert.ok(whitelist.includes(key), `${key} mirrored`);
  }
  for (const key of ["pi-web:settings-navigation", "pi-tool-preset", "pi-web:tab-open-session"]) {
    assert.ok(whitelist.includes(key), `${key} mirrored`);
  }
  // The mirror's own revision counter is NOT part of the mirrored state.
  assert.ok(!whitelist.includes(STATE_MIRROR_REVISION_KEY));
});

test("collection is whitelist-only: unknown keys never ship", () => {
  const storage = storageWith({
    [APP_PREF_KEYS.theme]: "dark",
    "unrelated-app": "value",
    "pi-oauth-token": "should-not-exist",
    [APP_PREF_KEYS.chatDrafts]: "{}",
  });
  const entries = collectStateMirrorEntries(storage);
  assert.deepEqual(Object.keys(entries).sort(), [APP_PREF_KEYS.chatDrafts, APP_PREF_KEYS.theme]);
});

test("prefix families are mirrored with a cap", () => {
  const entries = { [APP_PREF_KEYS.theme]: "auto" };
  for (let i = 0; i < STATE_MIRROR_FAMILY_CAP + 5; i += 1) {
    entries[`pi-web:provider-usage:provider-${i}`] = "{}";
  }
  const collected = collectStateMirrorEntries(storageWith(entries));
  const family = Object.keys(collected).filter((key) => key.startsWith("pi-web:provider-usage:"));
  assert.equal(family.length, STATE_MIRROR_FAMILY_CAP);
  // The first entries in index order win, not an arbitrary subset.
  assert.ok(family.includes("pi-web:provider-usage:provider-0"));
});

test("oversized values are skipped, not truncated", () => {
  const big = "x".repeat(STATE_MIRROR_VALUE_CAP + 1);
  const entries = collectStateMirrorEntries(
    storageWith({ [APP_PREF_KEYS.theme]: "auto", [APP_PREF_KEYS.workspace]: big }),
  );
  assert.equal(entries[APP_PREF_KEYS.theme], "auto");
  assert.equal(entries[APP_PREF_KEYS.workspace], undefined);
});

test("checksum is stable for equal entries and sensitive to byte changes", () => {
  const a = stateMirrorChecksum({ "pi-theme": "dark", "k": "v" });
  const b = stateMirrorChecksum({ "k": "v", "pi-theme": "dark" });
  assert.equal(a, b, "key order does not matter");
  assert.notEqual(a, stateMirrorChecksum({ "pi-theme": "dark", "k": "w" }));
});

test("payload verification accepts a well-formed payload and rejects drift", () => {
  const payload = buildStateMirrorPayload({ [APP_PREF_KEYS.theme]: "dark" }, 7);
  assert.ok(verifyStateMirrorPayload(payload));
  assert.equal(payload.schemaVersion, STATE_MIRROR_SCHEMA_VERSION);

  const tampered = { ...payload, entries: { [APP_PREF_KEYS.theme]: "light" } };
  assert.ok(!verifyStateMirrorPayload(tampered), "checksum no longer matches the entries");

  const staleSchema = { ...payload, schemaVersion: payload.schemaVersion + 1 };
  assert.ok(!verifyStateMirrorPayload(staleSchema));

  const nonString = { ...payload, entries: { k: 42 } };
  assert.ok(!verifyStateMirrorPayload(nonString));

  assert.ok(!verifyStateMirrorPayload(null));
  assert.ok(!verifyStateMirrorPayload("nope"));
});
