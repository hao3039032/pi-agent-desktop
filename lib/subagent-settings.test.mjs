/**
 * The builtin subagent settings are gone with the controller (M4): the
 * pi-subagents package reads its own configuration inside the CLI child.
 * What survives in `lib/subagent-settings.ts` is the package-name constant
 * the detection seams share — pinned here so it cannot drift silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { PI_SUBAGENTS_PACKAGE_NAME } = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("the pi-subagents package name constant stays the npm package's name", () => {
  assert.equal(PI_SUBAGENTS_PACKAGE_NAME, "pi-subagents");
});
