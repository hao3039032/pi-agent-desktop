import test from "node:test";
import assert from "node:assert/strict";
import { bundleProjectionModules } from "./build-management-modules.mjs";

test("packaged projection uses relocatable SDK entry while development keeps bare import", async () => {
  const packaged = await bundleProjectionModules({ packaged: true });
  assert.match(packaged, /from "\.\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/index\.js"/);
  assert.doesNotMatch(packaged, /from "@earendil-works\/pi-coding-agent"/);
  const development = await bundleProjectionModules();
  assert.match(development, /from "@earendil-works\/pi-coding-agent"/);
});
