import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const {
  bindChatSettingsService,
  fetchChatSettings,
  saveChatSettings,
} = await jiti.import("./chat-settings-service.ts");

test("static chat-settings-service fetches and saves chat settings over mock transport", async () => {
  const transport = new MockTransport();
  let savedPatch = null;

  transport.on("chats.settingsGet", () => ({
    model: null,
    thinkingLevel: null,
    instructions: "test instructions",
    allowedTools: ["tool1"],
    confirmSave: false,
    instructionsMaxChars: 8000,
  }));

  transport.on("chats.settingsSet", (args) => {
    savedPatch = args;
    return {
      model: args?.model ?? null,
      thinkingLevel: args?.thinkingLevel ?? null,
      instructions: args?.instructions ?? "test instructions",
      allowedTools: args?.allowedTools ?? ["tool1"],
      confirmSave: false,
      instructionsMaxChars: 8000,
    };
  });

  const client = new IpcClient(transport);
  bindChatSettingsService(client);

  const initial = await fetchChatSettings();
  assert.equal(initial.instructions, "test instructions");
  assert.deepEqual(initial.allowedTools, ["tool1"]);

  const updated = await saveChatSettings({ instructions: "updated instructions" });
  assert.equal(updated.instructions, "updated instructions");
  assert.deepEqual(savedPatch, { instructions: "updated instructions" });
});
