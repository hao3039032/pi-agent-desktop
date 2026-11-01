import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { attachSessionImage } = await createJiti(import.meta.url).import("./session-image-loader.ts");
const source = (sessionId, entryId = "entry", blockIndex = 0) => ({ type: "session", sessionId, entryId, blockIndex });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("switching sessions revokes late grants instead of delivering them", async () => {
  const a = deferred(), b = deferred(), seen = [], released = [];
  const open = (id) => id === "a" ? a.promise : b.promise;
  const closeA = attachSessionImage(source("a"), open, resource => seen.push(resource.url), assert.fail);
  closeA();
  const closeB = attachSessionImage(source("b"), open, resource => seen.push(resource.url), assert.fail);
  a.resolve({ url: "old", release: () => released.push("old") });
  b.resolve({ url: "new", release: () => released.push("new") });
  await Promise.resolve();
  assert.deepEqual(seen, ["new"]);
  assert.deepEqual(released, ["old"]);
  closeB();
  assert.deepEqual(released, ["old", "new"]);
});

test("A to B to A does not revive the first A request", async () => {
  const first = deferred(), middle = deferred(), last = deferred(), queue = [first, middle, last];
  const seen = [], released = [];
  const open = () => queue.shift().promise;
  const a = attachSessionImage(source("a"), open, resource => seen.push(resource.url), assert.fail);
  a();
  const b = attachSessionImage(source("b"), open, resource => seen.push(resource.url), assert.fail);
  b();
  const current = attachSessionImage(source("a"), open, resource => seen.push(resource.url), assert.fail);
  last.resolve({ url: "new-a", release: () => released.push("new-a") });
  first.resolve({ url: "old-a", release: () => released.push("old-a") });
  middle.resolve({ url: "old-b", release: () => released.push("old-b") });
  await Promise.resolve();
  assert.deepEqual(seen, ["new-a"]);
  assert.deepEqual(released, ["old-a", "old-b"]);
  current();
  assert.deepEqual(released, ["old-a", "old-b", "new-a"]);
});

test("closed request errors are ignored and active failures are reported once", async () => {
  const old = deferred(), current = deferred(); let errors = 0;
  const close = attachSessionImage(source("a"), () => old.promise, assert.fail, () => errors++);
  close(); old.reject(new Error("late"));
  attachSessionImage(source("b"), () => current.promise, assert.fail, () => errors++);
  current.reject(new Error("denied"));
  await Promise.resolve();
  assert.equal(errors, 1);
});
