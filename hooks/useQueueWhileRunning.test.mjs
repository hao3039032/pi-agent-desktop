import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

// The pref reads and writes through window.localStorage; install a minimal
// store before the module loads, as the browser would.
const stored = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  },
};

const { APP_PREF_KEYS } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("../lib/app-prefs.ts");
const { isQueueWhileRunning, setQueueWhileRunning } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./useQueueWhileRunning.ts");
const source = readFileSync(new URL("./useQueueWhileRunning.ts", import.meta.url), "utf8");

test("absent storage keeps the steer default and writes nothing back", () => {
  stored.clear();
  assert.equal(isQueueWhileRunning(), false);
  assert.equal(stored.has(APP_PREF_KEYS.queueWhileRunning), false, "reading must not migrate old users to queue mode");
});

test("turning the switch on persists, and off restores the steer default", () => {
  stored.clear();
  setQueueWhileRunning(true);
  assert.equal(stored.get(APP_PREF_KEYS.queueWhileRunning), "true");
  assert.equal(isQueueWhileRunning(), true);
  setQueueWhileRunning(false);
  assert.equal(stored.get(APP_PREF_KEYS.queueWhileRunning), "false");
  assert.equal(isQueueWhileRunning(), false);
});

test("the mounted composer and the settings row share one subscribed store", () => {
  // Both read through useSyncExternalStore, so the setter's notification is
  // what updates every mounted composer immediately.
  assert.match(source, /useSyncExternalStore\(subscribe, isQueueWhileRunning, getServerSnapshot\)/);
  assert.match(source, /listeners\.forEach\(\(listener\) => listener\(\)\)/);
  assert.match(source, /getServerSnapshot\(\): boolean \{\s*return DEFAULT;/);
});
