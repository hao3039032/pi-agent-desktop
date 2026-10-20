import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const tabs = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");

test("fleet controls belong to existing composer tags, never a dedicated workspace tab or More entry", () => {
  assert.doesNotMatch(shell, /SUBAGENT_FLEET_TAB_ID|SubagentFleetPanel|handleOpenSubagentFleet/);
  assert.doesNotMatch(tabs, /"subagents"/);
  assert.match(chat, /key=\{`above:\$\{messageKeySessionId\}`\}/);
  assert.match(chat, /key=\{`below:\$\{messageKeySessionId\}`\}/);
  assert.equal((chat.match(/sessionId=\{chatOnly \? undefined : messageKeySessionId \?\? undefined\}/g) ?? []).length, 2);
});
