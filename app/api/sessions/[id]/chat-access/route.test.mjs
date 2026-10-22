import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET } = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { appendChatUnlock } = await jiti.import("../../../../../lib/chat-unlock.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../../../lib/session-reader.ts");

for (const live of [false, true]) {
  for (const exposed of [false, true]) {
    test(`GET reports effective chat unlock (${live ? "live" : "persisted"}, ${exposed ? "exposed" : "local"})`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "chat-access-"));
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      const oldHost = process.env.PI_WEB_HOSTNAME;
      const oldRegistry = globalThis.__piSessions;
      process.env.PI_CODING_AGENT_DIR = dir;
      process.env.PI_WEB_HOSTNAME = exposed ? "0.0.0.0" : "127.0.0.1";
      globalThis.__piSessions = new Map();
      const ids = [];
      t.after(async () => {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        if (oldHost === undefined) delete process.env.PI_WEB_HOSTNAME;
        else process.env.PI_WEB_HOSTNAME = oldHost;
        globalThis.__piSessions = oldRegistry;
        for (const id of ids) invalidateSessionPathCache(id);
        await rm(dir, { recursive: true, force: true });
      });

      for (const kind of ["folder", "legacy", "root", "project"]) {
        const cwd = kind === "folder" ? join(dir, "chats", "owned")
          : kind === "legacy" ? join(dir, "chat-workspace")
            : kind === "root" ? join(dir, "chats") : join(dir, "project");
        const manager = SessionManager.create(cwd, join(dir, "sessions"));
        manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 });
        const id = manager.getSessionId();
        ids.push(id);
        cacheSessionPath(id, manager.getSessionFile());
        for (const storedUnlock of [false, true]) {
          appendChatUnlock(manager, storedUnlock);
          if (live) {
            globalThis.__piSessions.set(id, {
              isAlive: () => true,
              cwd,
              sessionFile: manager.getSessionFile(),
              // Even a stale wrapper cannot advertise access unavailable here.
              isChatUnlocked: () => storedUnlock,
            });
          }
          const response = await GET(new Request(`http://localhost/api/sessions/${id}/chat-access`), {
            params: Promise.resolve({ id }),
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("Cache-Control"), "no-store");
          const available = kind === "folder" && !exposed;
          assert.deepEqual(await response.json(), {
            chat: kind !== "project",
            folder: kind === "folder" ? cwd : null,
            unlocked: available && storedUnlock,
            available,
          }, `${kind}, storedUnlock=${storedUnlock}`);
        }
      }
    });
  }
}
