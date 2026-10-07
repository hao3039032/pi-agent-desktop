import assert from "node:assert/strict";
import test from "node:test";
import { resetRevision, upstreamVersionOf } from "./distro-reset-revision.mjs";

const distro = { id: "lw", revision: 9 };

test("a changed upstream version resets the revision to 1", () => {
  const { distro: next, reset } = resetRevision(distro, "0.4.8", "0.5.2");
  assert.equal(reset, true);
  assert.equal(next.revision, 1);
  // the input is not mutated
  assert.equal(distro.revision, 9);
});

test("an unchanged upstream version keeps the revision", () => {
  const { distro: next, reset } = resetRevision(distro, "0.5.2", "0.5.2");
  assert.equal(reset, false);
  assert.equal(next.revision, 9);
});

test("an already-reset revision is left alone", () => {
  const { distro: next, reset } = resetRevision({ id: "lw", revision: 1 }, "0.5.1", "0.5.2");
  assert.equal(reset, false);
  assert.equal(next.revision, 1);
});

test("upstreamVersionOf prefers upstreamVersion and validates the shape", () => {
  assert.equal(upstreamVersionOf({ version: "0.5.2" }), "0.5.2");
  assert.equal(upstreamVersionOf({ version: "0.5.209", upstreamVersion: "0.5.2" }), "0.5.2");
  assert.throws(() => upstreamVersionOf({}));
  assert.throws(() => upstreamVersionOf({ version: "v0.5" }));
  assert.throws(() => upstreamVersionOf({ version: "0.5" }));
});
