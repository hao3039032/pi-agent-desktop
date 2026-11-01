import assert from "node:assert/strict";
import test from "node:test";
import { bundleTitleModule } from "./build-management-modules.mjs";

test("the managed title helper contains only the allowlisted pure SDK functions", async () => {
  // bundleTitleModule checks esbuild's actual bytesInOutput contributor list.
  const text = await bundleTitleModule();
  assert.match(text, /function normalizeContext\(/);
  assert.match(text, /function getSupportedThinkingLevels\(/);
  assert.doesNotMatch(text, /pi-coding-agent|registerProvider|ModelRegistry|OAuth|mcp/i);
  assert.deepEqual([...text.matchAll(/^import .*$/gm)].map(match => match[0]), ['import { randomUUID } from "node:crypto";']);
});
