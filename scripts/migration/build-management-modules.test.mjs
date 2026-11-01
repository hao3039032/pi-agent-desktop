import test from "node:test";
import assert from "node:assert/strict";
import { bundleProjectionModules } from "./build-management-modules.mjs";

test("projection leaves the public SDK external for the pi extension loader", async () => {
  const projection = await bundleProjectionModules();
  assert.match(projection, /from "@earendil-works\/pi-coding-agent"/);
  assert.doesNotMatch(projection, /from "\.\/node_modules\/@earendil-works\/pi-coding-agent/);
  assert.match(projection, /projectionSessionManager/);
});
