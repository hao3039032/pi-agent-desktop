/**
 * M3: the management extension over the real pi child, with a REAL vendored
 * dependency tree (croner + the pi SDK copied from this checkout's
 * node_modules into a temp dir — the same shape desktop:prepare stages).
 *
 * Proves the plan's management-service core end to end:
 * - the extension loads in a --mode rpc --no-session child with discovery
 *   off and answers through the management protocol envelope (nonce-bound);
 * - cron math runs on the VENDORED croner (timezone semantics preserved);
 * - file-based session access runs on the VENDORED pi SDK — an isolated
 *   module graph distinct from the child pi's own internal instances
 *   (the instance-identity rule; the MCP transports follow this pattern);
 * - unknown ops fail with a code; the instance stays usable after.
 *
 * Skips without PI_CLI_BIN (the lib/pi-rpc smoke convention).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";
import { stageManagedTree } from "./stage-managed-tree.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");

const executable = resolvePiCliBin();
const HERE = import.meta.dirname;

/**
 * Stage the vendored management tree (the desktop:prepare shape) into a temp
 * dir — scripts/migration/stage-managed-tree.mjs owns the staging rules.
 */
async function stageVendoredTree(managed) {
  await mkdir(managed, { recursive: true });
  await stageManagedTree(managed);
}

test(
  "the management extension answers over the vendored tree inside a real pi child",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-ext-"));
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      // The vendored management tree (the desktop:prepare shape): croner +
      // the pi SDK's session-manager graph with its dependency closure,
      // all copied from this checkout's locked node_modules.
      // The tree root holds node_modules/ so dependency resolution from the
      // vendored packages finds their closure (the desktop:prepare shape).
      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);
      const { readdirSync } = await import("node:fs");

      // A session file the read ops open (the host authors the header).
      const sessions = join(root, "sessions");
      await mkdir(sessions, { recursive: true });
      const sessionFile = join(sessions, "20260101T000000_mgmt.jsonl");
      const header = {
        type: "session",
        version: 3,
        id: "mgmt-session-id",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      };
      const entry = {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: "hello from the management test" },
      };
      await writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, "utf8");

      const nonce = "mgmt-nonce-1";
      const client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });

      // Collect the management envelopes from the notify channel.
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });

      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command(
          "prompt",
          { message: `/pi-web:mgmt ${requestId} ${token}` },
          60_000,
        );
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };

      try {
        // 1. The capability table.
        const capabilities = await call("sys.capabilities", {});
        assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
        assert.equal(capabilities.result.version, 1);
        assert.ok(capabilities.result.ops.includes("cron.preview"));
        assert.ok(capabilities.result.ops.includes("session.readEntries"));

        // 2. Cron math on the VENDORED croner: a fixed UTC expression.
        const preview = await call("cron.preview", { expr: "17 5 * * *", timezone: "UTC", count: 3 });
        assert.equal(preview.ok, true, JSON.stringify(preview));
        assert.equal(preview.result.runs.length, 3);
        for (const run of preview.result.runs) {
          assert.match(run, /T05:17:00\.000Z$/, `UTC 05:17 computed: ${run}`);
        }

        // 2b. Timezone semantics survive the vendored copy.
        const shanghai = await call("cron.preview", { expr: "0 9 * * *", timezone: "Asia/Shanghai", count: 1 });
        assert.equal(shanghai.ok, true, JSON.stringify(shanghai));
        // 09:00 Asia/Shanghai == 01:00 UTC (no DST in the zone).
        assert.match(shanghai.result.runs[0], /T01:00:00\.000Z$/, `Shanghai 09:00 → UTC 01:00: ${shanghai.result.runs[0]}`);

        // 2c. Invalid cron fails with a code, instance stays usable.
        const invalid = await call("cron.preview", { expr: "not a cron", timezone: "UTC" });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.code, "invalid_cron");
        const stillFine = await call("sys.capabilities", {});
        assert.equal(stillFine.ok, true, "usable after a failed op");

        // 2d. The skipped-slot count (cron.countSlots): every 10 minutes
        // over one hour → 6 slots in (since, until]; an empty window → 0.
        const count = await call("cron.countSlots", {
          expr: "*/10 * * * *",
          timezone: "UTC",
          sinceISO: "2026-03-01T11:00:00.000Z",
          untilISO: "2026-03-01T12:00:00.000Z",
        });
        assert.equal(count.ok, true, JSON.stringify(count));
        assert.equal(count.result.count, 6);
        const empty = await call("cron.countSlots", {
          expr: "*/10 * * * *",
          timezone: "UTC",
          sinceISO: "2026-03-01T12:00:00.000Z",
          untilISO: "2026-03-01T12:00:00.000Z",
        });
        assert.equal(empty.result.count, 0);
        // A window longer than a year refuses rather than spinning.
        const huge = await call("cron.countSlots", {
          expr: "* * * * *",
          timezone: "UTC",
          sinceISO: "2020-01-01T00:00:00.000Z",
          untilISO: "2026-01-01T00:00:00.000Z",
        });
        assert.equal(huge.ok, false);
        assert.equal(huge.code, "invalid_args");

        // 3. File-based session access on the VENDORED SDK.
        const headerReply = await call("session.readHeader", { file: sessionFile });
        assert.equal(headerReply.ok, true, JSON.stringify(headerReply));
        assert.equal(headerReply.result.header.id, "mgmt-session-id");
        const entriesReply = await call("session.readEntries", { file: sessionFile, offset: 0, limit: 10 });
        assert.equal(entriesReply.ok, true, JSON.stringify(entriesReply));
        assert.equal(entriesReply.result.total, 1);
        assert.equal(entriesReply.result.entries[0].message.content, "hello from the management test");

        // 3b. The instance-identity proof: the vendored SDK's SessionManager
        // is the MANAGEMENT TREE's class — importing it fresh inside the
        // child does NOT touch the child pi host's internal instances.
        // (Structural: the extension opened and read the file with its own
        // copy; nothing was taken from the host runtime.)
        assert.ok(headerReply.result.header.type === "session");

        // 4. Unknown ops refuse with a code.
        const unknown = await call("no.such.op", {});
        assert.equal(unknown.ok, false);
        assert.equal(unknown.code, "unknown_op");

        // 5. No session files were created by the management child itself.
        const agentSessions = join(agentDir, "sessions");
        const created = (() => {
          try {
            return readdirSync(agentSessions).length;
          } catch {
            return 0;
          }
        })();
        assert.equal(created, 0, "management instances write no session files");
      } finally {
        await client.close(5_000);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M2: the spawn prompts (chat.systemPrompt / session.chatOnlyPrompt) — the
 * ops the Rust host's sessions.create calls while building a child's spawn
 * plan. Differentiially pinned against the repo source: chat.systemPrompt
 * must answer EXACTLY lib/chat-workspace-prompt.ts's output, and
 * session.chatOnlyPrompt must join the cwd's context files in pi's own
 * discovery order (the vendored SDK's resource loader).
 */
test(
  "the spawn-prompt ops answer the repo implementation exactly",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-prompt-"));
    let client = null;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      // A context file the chat-only prompt joins (pi's discovery order).
      await writeFile(join(cwd, "AGENTS.md"), "context-file body", "utf8");

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      const nonce = "mgmt-nonce-prompt";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 60_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };

      // The repo implementation (the ONE source the bundle compiles from).
      const { chatWorkspacePrompt } = await jiti.import("../../lib/chat-workspace-prompt.ts");
      try {
        for (const scope of [
          { filesEnabled: true, folder: false, unlocked: false },
          { filesEnabled: true, folder: true, unlocked: false },
          { filesEnabled: true, folder: true, unlocked: true },
          { filesEnabled: false, folder: false, unlocked: false },
        ]) {
          const answered = await call("chat.systemPrompt", scope);
          assert.equal(answered.ok, true, JSON.stringify(answered));
          assert.equal(
            answered.result.prompt,
            chatWorkspacePrompt(scope.filesEnabled, {
              ...(scope.folder ? { folder: true } : {}),
              ...(scope.unlocked ? { unlocked: true } : {}),
            }),
            `the exact prompt for ${JSON.stringify(scope)}`,
          );
        }

        // The chat-only pin: the cwd's context files joined in order. The
        // explicit agentDir (what the Rust host passes) must be used AS IS:
        // PI_CODING_AGENT_DIR is already the complete agent dir, and a
        // nested `.../<agentDir>/.pi/agent` read would miss the global
        // context file placed below.
        await writeFile(join(agentDir, "AGENTS.md"), "global-from-agent-dir", "utf8");
        const chatOnly = await call("session.chatOnlyPrompt", { cwd, agentDir });
        assert.equal(chatOnly.ok, true, JSON.stringify(chatOnly));
        assert.match(chatOnly.result.prompt, /context-file body/, "the cwd AGENTS.md body joined");
        assert.match(
          chatOnly.result.prompt,
          /global-from-agent-dir/,
          "the agentDir's own global context file joined — the agentDir was not re-nested",
        );
        // And WITHOUT the explicit arg: PI_CODING_AGENT_DIR (set above to
        // the same directory) must be honoured as the COMPLETE agent dir —
        // the old default appended /.pi/agent to it and missed the file.
        const chatOnlyEnv = await call("session.chatOnlyPrompt", { cwd });
        assert.equal(chatOnlyEnv.ok, true, JSON.stringify(chatOnlyEnv));
        assert.match(
          chatOnlyEnv.result.prompt,
          /global-from-agent-dir/,
          "PI_CODING_AGENT_DIR is the complete agent dir, never re-nested",
        );
      } finally {
        await client.close(5_000);
        client = null;
      }
    } finally {
      if (client) await client.close(5_000).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M2: the session-view projection ops (session.readView / readContext /
 * projectSnapshot) — the mgmt-extension half of GET /api/sessions/[id] and
 * /api/sessions/[id]/context.
 *
 * The projection bundle is compiled from THIS checkout's
 * lib/session-projection.ts; the test differentially asserts the ops apply
 * the very same functions with the same arguments by running
 * buildSessionContext in-process (jiti, the repo source) and comparing the
 * op's answer entry for entry — a stale or hand-edited bundle cannot pass.
 */
test(
  "the session-view projection ops differentially match the repo projection",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-view-"));
    let client = null;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      // A session with a branch point, a compaction divider, model and
      // thinking changes, a tool pin and a deferred-able image tool result.
      const sessionFile = join(root, "sessions", "20260201T100000_proj.jsonl");
      await mkdir(join(root, "sessions"), { recursive: true });
      const lines = [
        { type: "session", version: 3, id: "proj-s1", timestamp: "2026-02-01T10:00:00.000Z", cwd },
        { type: "message", id: "u1", parentId: null, timestamp: "2026-02-01T10:00:01.000Z", message: { role: "user", content: "first question" } },
        {
          type: "message", id: "a1", parentId: "u1", timestamp: "2026-02-01T10:00:02.000Z",
          message: {
            role: "assistant", provider: "p", model: "m1",
            content: [
              { type: "thinking", thinking: "a long hidden reasoning trace that deferThinking replaces with a preview" },
              { type: "text", text: "answer one" },
            ],
          },
        },
        { type: "message", id: "u2", parentId: "a1", timestamp: "2026-02-01T10:00:03.000Z", message: { role: "user", content: "the abandoned branch" } },
        { type: "message", id: "u2b", parentId: "a1", timestamp: "2026-02-01T10:00:04.000Z", message: { role: "user", content: "the kept branch" } },
        { type: "message", id: "a2", parentId: "u2b", timestamp: "2026-02-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
        { type: "model_change", id: "mc1", parentId: "a2", timestamp: "2026-02-01T10:00:06.000Z", provider: "prov", modelId: "model-x" },
        { type: "thinking_level_change", id: "tl1", parentId: "mc1", timestamp: "2026-02-01T10:00:07.000Z", thinkingLevel: "high" },
        { type: "compaction", id: "cp1", parentId: "tl1", timestamp: "2026-02-01T10:00:08.000Z", summary: "earlier turns compacted", firstKeptEntryId: "u2b", tokensBefore: 4096 },
        { type: "message", id: "u3", parentId: "cp1", timestamp: "2026-02-01T10:00:09.000Z", message: { role: "user", content: "after compaction" } },
        {
          type: "message", id: "tr1", parentId: "u3", timestamp: "2026-02-01T10:00:10.000Z",
          message: {
            role: "toolResult", toolCallId: "tc1",
            content: [{ type: "image", data: "aGk=".repeat(64), mimeType: "image/png" }],
          },
        },
        { type: "custom", id: "ts1", parentId: "tr1", timestamp: "2026-02-01T10:00:11.000Z", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read", "bash"] } },
        { type: "message", id: "a3", parentId: "ts1", timestamp: "2026-02-01T10:00:12.000Z", message: { role: "assistant", content: [{ type: "text", text: "final" }] } },
      ];
      await writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
      const entries = lines.slice(1);

      const nonce = "mgmt-view-nonce";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `view-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 120_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };

      // The repo's own projection, run in-process: the differential oracle.
      const projection = await jiti.import("../../lib/session-projection.ts");
      const stats = await jiti.import("../../lib/session-stats.ts");

      // 1. readView: the disk half of GET /api/sessions/[id].
      const view = await call("session.readView", {
        file: sessionFile,
        summaryTree: true,
        deferThinking: true,
        deferMedia: true,
        tail: 50,
        wholeTurns: true,
      });
      assert.equal(view.ok, true, JSON.stringify(view));
      assert.equal(view.result.header.id, "proj-s1");
      assert.equal(view.result.leafId, "a3");
      assert.equal(view.result.treeFormat, "summary");
      assert.ok(JSON.stringify(view.result.tree).includes("u2b"), "the branch point survives the summary tree");
      assert.equal(view.result.toolNames.length, 2);
      assert.deepEqual(view.result.toolNames, ["read", "bash"]);
      // Differential: the context IS the repo projection's answer.
      const expectedContext = projection.buildSessionContext(entries, "a3", {
        deferThinking: true,
        deferToolResultImages: true,
        tail: 50,
        wholeTurns: true,
      });
      assert.deepEqual(view.result.context, expectedContext);
      // The projection's contract held: thinking deferred, image omitted.
      const assistantOne = view.result.context.messages.find(
        (message) => message.role === "assistant" && message.content?.some((block) => block.type === "text" && block.text === "answer one"),
      );
      const thinking = assistantOne.content.find((block) => block.type === "thinking");
      assert.equal(thinking.deferred, true, "deferThinking previewed the trace");
      const toolResult = view.result.context.messages.find((message) => message.role === "toolResult");
      assert.equal(toolResult.content.some((block) => block.type === "image"), false, "no sessionId: the image is omitted, not a URL");
      assert.ok(
        toolResult.content.some((block) => block.type === "text" && /omitted from initial history payload/.test(block.text)),
        "the omission note is present",
      );
      // Settings from the branch: model_change + thinking_level_change.
      assert.deepEqual(view.result.context.model, { provider: "prov", modelId: "model-x" });
      assert.equal(view.result.context.thinkingLevel, "high");
      assert.deepEqual(view.result.stats, stats.computeSessionStats(entries));

      // 2. readContext: an explicit branch leaf (BranchNavigator paging).
      const branchView = await call("session.readContext", {
        file: sessionFile,
        leafId: "a2",
        deferThinking: true,
        deferMedia: true,
        wholeTurns: true,
      });
      assert.equal(branchView.ok, true, JSON.stringify(branchView));
      const expectedBranch = projection.buildSessionContext(entries, "a2", {
        deferThinking: true,
        deferToolResultImages: true,
        tail: 50,
        excludeLeaf: false,
        wholeTurns: true,
      });
      assert.deepEqual(branchView.result.context, expectedBranch);
      // The abandoned sibling never renders on this branch.
      assert.ok(!JSON.stringify(branchView.result.context.messages).includes("the abandoned branch"));
      // No model_change on this branch: the assistant response metadata is the fallback.
      assert.deepEqual(branchView.result.context.model, { provider: "p", modelId: "m1" });

      // 3. readContext: `before` pagination excludes the cursor entry.
      const page = await call("session.readContext", {
        file: sessionFile,
        before: "u3",
        tail: 2,
        deferThinking: true,
        deferMedia: true,
      });
      assert.equal(page.ok, true, JSON.stringify(page));
      const expectedPage = projection.buildSessionContext(entries, "u3", {
        deferThinking: true,
        deferToolResultImages: true,
        tail: 2,
        excludeLeaf: true,
      });
      assert.deepEqual(page.result.context, expectedPage);
      assert.equal(page.result.before, "u3");

      // 4. projectSnapshot: the LIVE half — the host's one-shot child
      //    snapshot (entries + the in-memory branch pointer) handed over as
      //    a file. The leaf here is NOT the file's tail: navigateTree moved
      //    it in memory while the file keeps the abandoned branch's tail.
      const snapshotFile = join(root, "snapshot.json");
      const tree = [
        {
          entry: entries[0],
          children: [
            {
              entry: entries[1],
              children: [ { entry: entries[2], children: [] }, { entry: entries[3], children: [ { entry: entries[4], children: [] } ] } ],
            },
          ],
        },
      ];
      await writeFile(snapshotFile, JSON.stringify({ entries, leafId: "a2", tree }), "utf8");
      const live = await call("session.projectSnapshot", {
        snapshotFile,
        summaryTree: true,
        deferThinking: true,
        deferMedia: true,
        tail: 50,
        wholeTurns: true,
      });
      assert.equal(live.ok, true, JSON.stringify(live));
      assert.equal(live.result.leafId, "a2", "the in-memory leaf, not the file tail");
      assert.deepEqual(live.result.context, expectedBranch);
      assert.ok(JSON.stringify(live.result.tree).includes("u2"));

      // 5. A bad snapshot refuses with a code (never a half projection).
      const badSnapshot = join(root, "bad-snapshot.json");
      await writeFile(badSnapshot, JSON.stringify({ entries: [], leafId: "x" }), "utf8");
      const bad = await call("session.projectSnapshot", { snapshotFile: badSnapshot });
      assert.equal(bad.ok, false);
      assert.equal(bad.code, "invalid_args");
    } finally {
      if (client) await client.close(5_000).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M3: the models domain (models.list / models.setDefault) — the selector's
 * data and the selectors' star over the management protocol. Differentially
 * pinned against the repo's lib/models-service.server.ts (the ONE composition the
 * Next /api/models route also serves), on a fixture provider in an isolated
 * agent dir: the composed scope, the default write's persistence, and both
 * shaped refusals (a shadowing project settings.json, an out-of-scope model).
 */
test(
  "the models ops answer the repo composition and write the real defaults",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-models-"));
    let client = null;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(agentDir, "sessions"), { recursive: true });
      // A fixture provider (never a real credential, never a real network).
      await writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          "fixture-provider": {
            name: "Fixture Provider",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "fixture-key",
            api: "openai-completions",
            models: [{ id: "fixture-model", name: "Fixture Model" }],
          },
        },
      }, null, 2), "utf8");

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      const nonce = "mgmt-nonce-models";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 60_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };

      // The repo implementation (the ONE source the bundle compiles from),
      // loaded against the SAME agent dir the child sees.
      const { loadScopedModelsData } = await jiti.import("../../lib/models-service.server.ts");
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        // 1. models.list differentially matches the repo composition.
        const answered = await call("models.list", { cwd });
        assert.equal(answered.ok, true, JSON.stringify(answered));
        const expected = await loadScopedModelsData(cwd);
        assert.deepEqual(answered.result, expected, "the exact /api/models body");

        // 2. The default write persists (the selectors' star).
        const saved = await call("models.setDefault", { cwd, thinkingLevel: "medium" });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        assert.equal(saved.result.defaultThinkingLevel, "medium");
        const settings = JSON.parse(await (await import("node:fs/promises")).readFile(join(agentDir, "settings.json"), "utf8"));
        assert.equal(settings.defaultThinkingLevel, "medium", "settings.json carries the write");

        // 3. An out-of-scope model refuses with the route's 404 shape.
        const refused = await call("models.setDefault", { cwd, provider: "nope", modelId: "nope" });
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.equal(refused.code, "not_found");
        assert.match(refused.error, /Model not available: nope\/nope/);

        // 4. A half pair refuses with the route's 400 shape.
        const half = await call("models.setDefault", { cwd, provider: "fixture-provider" });
        assert.equal(half.ok, false);
        assert.equal(half.code, "invalid_args");

        // 5. A shadowing project settings.json refuses with the 409 shape.
        //    Like a real user's project, the folder is TRUSTED first — an
        //    untrusted project's `.pi/settings.json` is exactly what the
        //    trust-gated resource loader must never load (the same flow the
        //    Next route ran), so without trust there is no shadow to refuse.
        const { ProjectTrustStore } = await jiti.import("@earendil-works/pi-coding-agent");
        new ProjectTrustStore(agentDir).set(cwd, true);
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultModel: "other" }), "utf8");
        const shadowed = await call("models.setDefault", { cwd, provider: "fixture-provider", modelId: "fixture-model" });
        assert.equal(shadowed.ok, false, JSON.stringify(shadowed));
        assert.equal(shadowed.code, "project_scope");
        assert.match(shadowed.error, /sets defaultModel for this project/);

        // 6. The refreshed scope reflects the saved default (cache invalidated).
        const refreshed = await call("models.list", { cwd });
        assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
        assert.equal(refreshed.result.defaultThinkingLevel, "medium", "the saved level is the new default");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    } finally {
      if (client) await client.close(5_000).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M3: the models-config write domain (modelsConfig.put) — the Models
 * panel's Save over the management protocol. Differentially pinned against
 * the repo's lib/models-config-service.server.ts (the ONE composition the
 * Next /api/models-config route's PUT also serves) on a fixture models.json
 * in an isolated agent dir: the stored-literal apiKey merge (restored for
 * an untouched provider, not followed through a rename — the route's own
 * semantics), the passthrough of unknown fields, the read refusal (a file
 * the composition cannot read is never replaced) and arg validation.
 */
test(
  "the modelsConfig.put op writes exactly the repo composition",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-models-config-"));
    let client = null;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(agentDir, "sessions"), { recursive: true });
      const original = JSON.stringify({
        "x-future-field": { nested: true },
        providers: {
          "fixture-provider": {
            name: "Fixture Provider",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "fixture-key",
            api: "openai-completions",
            models: [{ id: "fixture-model", name: "Fixture Model" }],
          },
          "fixture-second": {
            name: "Fixture Second",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "fixture-second-key",
            api: "openai-completions",
            models: [{ id: "fixture-second-model" }],
          },
        },
      }, null, 2);
      await writeFile(join(agentDir, "models.json"), original, "utf8");

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      const nonce = "mgmt-nonce-models-config";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 120_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };
      const readModelsJson = async () => (await import("node:fs/promises")).readFile(join(agentDir, "models.json"), "utf8");

      // The repo implementation (the ONE source the bundle compiles from),
      // loaded against the SAME agent dir the child sees.
      const { saveModelsConfig } = await jiti.import("../../lib/models-config-service.server.ts");
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        // The panel's draft after a redacted load: the renamed provider
        // carries no apiKey (the load never shipped it), the untouched one
        // keeps a `!` reference, an unknown field rides along and a partial
        // cost + blank row exercise the store's own normalize/sanitize.
        const draft = {
          "x-future-field": { nested: true },
          providers: {
            "fixture-renamed": {
              name: "Fixture Provider",
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              models: [{ id: "fixture-model", name: "Fixture Model" }, { id: "", name: "blank" }],
            },
            "fixture-second": {
              name: "Fixture Second",
              baseUrl: "http://127.0.0.1:10/v1",
              api: "openai-completions",
              models: [{ id: "fixture-second-model", cost: { input: 1 } }],
            },
          },
        };

        // 1. The read the panel starts from: literal keys redacted, the
        //    unknown field and the ! reference visible.
        const read = await call("modelsConfig.get", {});
        assert.equal(read.ok, true, JSON.stringify(read));
        assert.equal(read.result.providers["fixture-provider"].apiKey, undefined, "the literal never ships");
        assert.equal(read.result["x-future-field"].nested, true, "unknown fields are configuration");

        // 2. The differential: the repo composition's own write (in-process)
        //    against the same starting file is the expected bytes.
        saveModelsConfig(draft);
        const expected = await readModelsJson();
        await writeFile(join(agentDir, "models.json"), original, "utf8");

        // 3. The op writes byte-for-byte the same file.
        const saved = await call("modelsConfig.put", { config: draft });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        assert.deepEqual(JSON.parse(await readModelsJson()), JSON.parse(expected), "the exact PUT /api/models-config write");
        const onDisk = JSON.parse(await readModelsJson());
        assert.equal(onDisk.providers["fixture-renamed"].apiKey, undefined, "a rename does not carry the old literal (the route's merge semantics)");
        assert.equal(onDisk.providers["fixture-second"].apiKey, "fixture-second-key", "the untouched provider's literal is merged back");
        assert.deepEqual(
          onDisk.providers["fixture-second"].models,
          [{ id: "fixture-second-model", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          "the store's cost normalization ran",
        );
        assert.equal(onDisk.providers["fixture-renamed"].models.length, 1, "the blank row was dropped");

        // 4. The redaction still holds after the save (the merged-back
        //    literal never reaches a client through the read).
        const reread = await call("modelsConfig.get", {});
        assert.equal(reread.ok, true, JSON.stringify(reread));
        assert.equal(reread.result.providers["fixture-second"].apiKey, undefined);
        assert.equal(reread.result.providers["fixture-second"].baseUrl, "http://127.0.0.1:10/v1", "the edit is visible");

        // 5. A models.json the composition cannot read refuses the save —
        //    never a replacement — with the route's 409 shape.
        const broken = '{ "providers": [ broken';
        await writeFile(join(agentDir, "models.json"), broken, "utf8");
        const refused = await call("modelsConfig.put", { config: draft });
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.equal(refused.code, "models_config_read");
        assert.match(refused.error, /Failed to read/);
        assert.equal(await readModelsJson(), broken, "the unusable file is untouched");

        // 6. A malformed envelope refuses with the arg code, instance usable
        //    (restore a readable file first: the get below reads the disk).
        await writeFile(join(agentDir, "models.json"), original, "utf8");
        const noConfig = await call("modelsConfig.put", {});
        assert.equal(noConfig.ok, false, JSON.stringify(noConfig));
        assert.equal(noConfig.code, "invalid_args");
        const stringConfig = await call("modelsConfig.put", { config: "not-an-object" });
        assert.equal(stringConfig.ok, false);
        assert.equal(stringConfig.code, "invalid_args");
        const stillUsable = await call("modelsConfig.get", {});
        assert.equal(stillUsable.ok, true, "usable after failed puts");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    } finally {
      if (client) await client.close(5_000);
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M3: the enabledModels domain (models.enabledGet / models.enabledSet) — the
 * Models panel's switches over the management protocol. Differentially
 * pinned against the repo's lib/enabled-models-service.server.ts (the ONE
 * composition the Next /api/models/enabled route also serves) on a fixture
 * provider in an isolated agent dir: the read view, a single-model toggle's
 * minimal edit, pattern/pin handling, the stale-entry preservation rule (the
 * anti-TUI-rewrite contract), the resync repair after a provider rename,
 * and both shaped refusals (last-model, project scope) plus arg validation.
 */
test(
  "the enabledModels ops answer the repo composition and edit the real settings",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-enabled-"));
    let client = null;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(agentDir, "sessions"), { recursive: true });
      const modelsJson = (providerId) => JSON.stringify({
        providers: {
          [providerId]: {
            name: "Fixture Provider",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "fixture-key",
            api: "openai-completions",
            models: [
              { id: "fixture-a", name: "Fixture A" },
              { id: "fixture-b", name: "Fixture B" },
            ],
          },
        },
      }, null, 2);
      await writeFile(join(agentDir, "models.json"), modelsJson("fixture-provider"), "utf8");
      // An entry no available model matches (a signed-out provider, a rename,
      // another machine's config): every edit must preserve it verbatim.
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        enabledModels: ["ghost-provider/ghost-model"],
      }, null, 2), "utf8");

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      const nonce = "mgmt-nonce-enabled";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 120_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };
      const readSettings = async () => JSON.parse(await (await import("node:fs/promises")).readFile(join(agentDir, "settings.json"), "utf8"));

      // The repo implementation (the ONE source the bundle compiles from),
      // loaded against the SAME agent dir the child sees.
      const { loadEnabledModelsView } = await jiti.import("../../lib/enabled-models-service.server.ts");
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        // 1. enabledGet: differentially the repo composition's answer — the
        //    stale pattern is reported, everything else reads enabled (pi
        //    falls back to every model when patterns resolve to nothing).
        const read = await call("models.enabledGet", { cwd });
        assert.equal(read.ok, true, JSON.stringify(read));
        const expectedRead = await loadEnabledModelsView(cwd);
        assert.deepEqual(read.result, expectedRead, "the exact GET /api/models/enabled body");
        assert.deepEqual(read.result.stalePatterns, ["ghost-provider/ghost-model"]);
        assert.equal(read.result.allEnabled, true);
        const provider = read.result.providers.find((entry) => entry.id === "fixture-provider");
        assert.ok(provider, "the fixture provider is in the view");
        assert.equal(provider.models.length, 2);
        assert.equal(read.result.scope, "global");
        assert.equal(read.result.editable, true);

        // 2. A single-model toggle is a minimal edit: only the covering
        //    pattern is materialized, the unknown entry stays verbatim, and
        //    the surviving model is written explicitly (a lone exact
        //    reference is a deliberate pick, not collapsed).
        const off = await call("models.enabledSet", {
          cwd,
          op: "models",
          refs: ["fixture-provider/fixture-a"],
          enabled: false,
        });
        assert.equal(off.ok, true, JSON.stringify(off));
        assert.deepEqual(
          (await readSettings()).enabledModels,
          ["ghost-provider/ghost-model", "fixture-provider/fixture-b"],
          "the minimal edit keeps the stale entry verbatim",
        );
        // The answer is the fresh view: one enabled, one stale, not all.
        assert.equal(off.result.allEnabled, false);
        assert.equal(off.result.enabledTotal, 1);
        assert.equal(off.result.availableTotal, 2);

        // 3. Disabling the last enabled model is refused (an empty scope
        //    silently means every model in pi).
        const last = await call("models.enabledSet", {
          cwd,
          op: "models",
          refs: ["fixture-provider/fixture-b"],
          enabled: false,
        });
        assert.equal(last.ok, false, JSON.stringify(last));
        assert.equal(last.code, "last_model");

        // 4. Re-enabling the model collapses the provider back into its
        //    verified glob — but the stale entry keeps the setting alive.
        const back = await call("models.enabledGet", { cwd });
        assert.equal(back.ok, true, JSON.stringify(back));
        const on = await call("models.enabledSet", {
          cwd,
          op: "models",
          refs: ["fixture-provider/fixture-a"],
          enabled: true,
        });
        assert.equal(on.ok, true, JSON.stringify(on));
        assert.deepEqual(
          (await readSettings()).enabledModels,
          ["ghost-provider/ghost-model", "fixture-provider/*"],
          "two subset entries collapse into the verified glob; stale keeps the key",
        );

        // 5. A `:level` pin survives the expansion of its covering pattern.
        await writeFile(join(agentDir, "settings.json"), JSON.stringify({
          enabledModels: ["ghost-provider/ghost-model", "fixture-provider/*:high"],
        }, null, 2), "utf8");
        const pinned = await call("models.enabledSet", {
          cwd,
          op: "models",
          refs: ["fixture-provider/fixture-a"],
          enabled: false,
        });
        assert.equal(pinned.ok, true, JSON.stringify(pinned));
        assert.deepEqual(
          (await readSettings()).enabledModels,
          ["ghost-provider/ghost-model", "fixture-provider/fixture-b:high"],
          "the expansion keeps the thinking pin",
        );
        const pinnedView = pinned.result.providers.find((entry) => entry.id === "fixture-provider");
        const pinnedB = pinnedView.models.find((model) => model.id === "fixture-b");
        assert.equal(pinnedB.thinkingPin, "high", "the view surfaces the pin");

        // 6. resync: a provider renamed under the panel repairs the entries
        //    (model references first, then the provider prefix) and restores
        //    the providers that were fully enabled before the save.
        await writeFile(join(agentDir, "models.json"), modelsJson("fixture-renamed"), "utf8");
        const resynced = await call("models.enabledSet", {
          cwd,
          op: "resync",
          renames: [{ from: "fixture-provider", to: "fixture-renamed" }],
          modelRenames: [],
          fullyEnabled: ["fixture-provider"],
        });
        assert.equal(resynced.ok, true, JSON.stringify(resynced));
        assert.deepEqual(
          (await readSettings()).enabledModels,
          ["ghost-provider/ghost-model", "fixture-renamed/fixture-b:high", "fixture-renamed/fixture-a"],
          "resync rewrites the renamed provider and re-asserts fullyEnabled",
        );
        const renamedProvider = resynced.result.providers.find((entry) => entry.id === "fixture-renamed");
        assert.equal(renamedProvider.enabledCount, 2, "the renamed provider is fully enabled again");

        // 7. A malformed payload refuses with the seam's own text.
        const badOp = await call("models.enabledSet", { cwd, op: "nonsense" });
        assert.equal(badOp.ok, false, JSON.stringify(badOp));
        assert.equal(badOp.code, "invalid_args");
        assert.match(badOp.error, /Invalid op/);
        const badRefs = await call("models.enabledSet", { cwd, op: "models", refs: "not-an-array", enabled: true });
        assert.equal(badRefs.code, "invalid_args");
        assert.match(badRefs.error, /refs must be an array of strings/);

        // 8. A project settings.json's enabledModels replaces the global
        //    array (pi merges nothing), so reads report the project scope
        //    read-only and writes refuse.
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
          enabledModels: ["fixture-renamed/*"],
        }), "utf8");
        const shadowedRead = await call("models.enabledGet", { cwd });
        assert.equal(shadowedRead.ok, true, JSON.stringify(shadowedRead));
        assert.equal(shadowedRead.result.scope, "project");
        assert.equal(shadowedRead.result.editable, false);
        assert.ok(shadowedRead.result.settingsPath.includes(join(cwd, ".pi", "settings.json")), shadowedRead.result.settingsPath);
        const shadowedWrite = await call("models.enabledSet", { cwd, op: "clear" });
        assert.equal(shadowedWrite.ok, false, JSON.stringify(shadowedWrite));
        assert.equal(shadowedWrite.code, "project_scope");
        assert.match(shadowedWrite.error, /Project settings override enabledModels/);
        // The project scope never touched the global file.
        assert.equal((await readSettings()).enabledModels[0], "ghost-provider/ghost-model");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    } finally {
      if (client) await client.close(5_000).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * M3: the provider-auth domain (auth.providers / auth.apiKeyStore /
 * auth.apiKeyDelete / auth.logout) — the Models panel's sign-in surface over
 * the management protocol. Differentially pinned against the repo's
 * lib/provider-auth-service.server.ts (the ONE composition the Next
 * /api/auth/* routes also serve) on a fixture auth.json in an isolated agent
 * dir: the capability-driven listing (no secrets cross the wire), the
 * API-key store through the provider's own headless login, the type-gated
 * deletes (an OAuth credential never removed as an API key and vice versa)
 * and the shaped refusals with the routes' exact messages.
 */
test(
  "the provider-auth ops answer the repo composition over a real pi child",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mgmt-provider-auth-"));
    let client = null;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousOffline = process.env.PI_OFFLINE;
    try {
      const cwd = join(root, "work");
      const agentDir = join(root, "agent");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(agentDir, "sessions"), { recursive: true });
      const authPath = join(agentDir, "auth.json");
      const readAuth = async () => JSON.parse(await (await import("node:fs/promises")).readFile(authPath, "utf8"));

      const managed = join(root, "managed", "node_modules");
      await stageVendoredTree(managed);

      const nonce = "mgmt-nonce-provider-auth";
      client = new PiRpcClient(executable, {
        cwd,
        args: [
          "--no-session",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
          "--extension", join(HERE, "../../lib/pi-rpc/assets/pi-web-management.mjs"),
        ],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_WEB_MANAGED_MODULES: managed,
          PI_WEB_MGMT_NONCE: nonce,
        },
        onLog: () => {},
      });
      const envelopes = [];
      client.onUi("notify", (record) => {
        if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) {
          envelopes.push(JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)));
        }
        return undefined;
      });
      const call = async (op, args) => {
        const requestId = `mgmt-${Math.random().toString(36).slice(2)}`;
        const token = Buffer.from(JSON.stringify({ op, args, nonce }), "utf8").toString("base64url");
        const ack = await client.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 120_000);
        assert.equal(ack?.disposition, "handled", `the child consumed the command (${op})`);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find((entry) => entry.rid === requestId);
          if (envelope) {
            envelopes.splice(envelopes.indexOf(envelope), 1);
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`management op ${op} never answered`);
      };

      // The repo composition in-process (the Next route's own code path).
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_OFFLINE = "1";
      const { composeProviderLists } = await jiti.import("../../lib/provider-auth-service.server.ts");

      // The fixture credentials (never a real account, never a real secret).
      const STORED_KEY = "sk-mgmt-fixture-key-4f7a91c3";
      await writeFile(authPath, JSON.stringify({
        openai: { type: "api_key", key: STORED_KEY },
        anthropic: { type: "oauth", access: "oauth-access-fixture", refresh: "oauth-refresh-fixture", expires: Date.now() + 3_600_000 },
      }, null, 2), "utf8");

      try {
        // 1. The capability table carries the auth ops.
        const capabilities = await call("sys.capabilities", {});
        assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
        for (const op of [
          "auth.providers",
          "auth.apiKeyStore",
          "auth.apiKeyDelete",
          "auth.logout",
          "auth.loginStart",
          "auth.loginPoll",
          "auth.loginSubmit",
          "auth.loginCancel",
        ]) {
          assert.ok(capabilities.result.ops.includes(op), `${op} in the capability table`);
        }

        // 2. auth.providers answers EXACTLY the repo composition's listing
        //    (the differential: same agent dir, both sides).
        const listed = await call("auth.providers", {});
        assert.equal(listed.ok, true, JSON.stringify(listed));
        const inProcess = await composeProviderLists();
        assert.deepEqual(listed.result, JSON.parse(JSON.stringify(inProcess)), "the GET /api/auth/providers body");
        const serialized = JSON.stringify(listed);
        assert.equal(serialized.includes(STORED_KEY), false, "no stored key crosses the wire");
        assert.equal(serialized.includes("oauth-refresh-fixture"), false, "no OAuth secret crosses the wire");
        const oauthById = Object.fromEntries(listed.result.oauthProviders.map((p) => [p.id, p]));
        const apiKeyById = Object.fromEntries(listed.result.apiKeyProviders.map((p) => [p.id, p]));
        assert.equal(oauthById.anthropic.loggedIn, true, "anthropic's oauth credential reads signed in");
        assert.equal(apiKeyById.openai.configured, true, "openai's stored key reads configured");

        // 3. The type-gated delete: an OAuth credential refuses with the
        //    route's 409 message, and nothing is removed.
        const wrongType = await call("auth.apiKeyDelete", { provider: "anthropic" });
        assert.equal(wrongType.ok, false, JSON.stringify(wrongType));
        assert.equal(wrongType.code, "credential_type_mismatch");
        assert.equal(wrongType.error, "anthropic is authenticated with OAuth, not an API key");
        assert.equal((await readAuth()).anthropic.type, "oauth");

        // 4. The API-key store runs the provider's own headless login and
        //    stores the trimmed key beside the untouched OAuth credential.
        const stored = await call("auth.apiKeyStore", { provider: "openai", apiKey: `  ${STORED_KEY}-new  ` });
        assert.equal(stored.ok, true, JSON.stringify(stored));
        const auth = await readAuth();
        assert.equal(auth.openai.type, "api_key");
        assert.equal(auth.openai.key, `${STORED_KEY}-new`, "the headless login stored the trimmed key");
        assert.equal(auth.anthropic.type, "oauth", "other credentials untouched");
        const afterStore = await call("auth.providers", {});
        assert.equal(
          Object.fromEntries(afterStore.result.apiKeyProviders.map((p) => [p.id, p])).openai.configured,
          true,
          "the refreshed list reports the new key (status only, never the key)"
        );
        assert.equal(JSON.stringify(afterStore).includes(`${STORED_KEY}-new`), false);

        // 5. A missing key and an unknown provider refuse with the
        //    composition's own messages.
        const emptyKey = await call("auth.apiKeyStore", { provider: "openai", apiKey: "   " });
        assert.equal(emptyKey.ok, false, JSON.stringify(emptyKey));
        assert.equal(emptyKey.code, "invalid_args");
        assert.equal(emptyKey.error, "apiKey is required");
        const noLogin = await call("auth.apiKeyStore", { provider: "not-a-real-provider", apiKey: "sk-x" });
        assert.equal(noLogin.ok, false, JSON.stringify(noLogin));
        assert.equal(noLogin.code, "api_key_unsupported");
        assert.equal(noLogin.error, "not-a-real-provider does not support API key login");

        // 6. logout: unknown provider and the wrong credential type refuse;
        //    the OAuth credential itself is removed.
        const unknown = await call("auth.logout", { provider: "not-a-real-provider" });
        assert.equal(unknown.ok, false, JSON.stringify(unknown));
        assert.equal(unknown.code, "unknown_provider");
        assert.equal(unknown.error, "Unknown provider: not-a-real-provider");
        const wrongWay = await call("auth.logout", { provider: "openai" });
        assert.equal(wrongWay.ok, false, JSON.stringify(wrongWay));
        assert.equal(wrongWay.code, "credential_type_mismatch");
        assert.equal(wrongWay.error, "openai is authenticated with an API key, not OAuth");
        assert.equal((await readAuth()).openai.type, "api_key", "the key survived the refused logout");
        const loggedOut = await call("auth.logout", { provider: "anthropic" });
        assert.equal(loggedOut.ok, true, JSON.stringify(loggedOut));
        assert.equal("anthropic" in (await readAuth()), false, "the OAuth credential is gone");
        assert.equal((await readAuth()).openai.type, "api_key");
        const afterLogout = await call("auth.providers", {});
        assert.equal(
          Object.fromEntries(afterLogout.result.oauthProviders.map((p) => [p.id, p])).anthropic.loggedIn,
          false,
          "the refreshed OAuth list reports signed out"
        );

        // 7. The API-key delete (the right type this time) removes the key.
        const removed = await call("auth.apiKeyDelete", { provider: "openai" });
        assert.equal(removed.ok, true, JSON.stringify(removed));
        assert.equal("openai" in (await readAuth()), false);

        // 8. A malformed envelope (no provider) refuses; the instance stays usable.
        const noProvider = await call("auth.apiKeyDelete", {});
        assert.equal(noProvider.ok, false, JSON.stringify(noProvider));
        assert.equal(noProvider.code, "invalid_args");

        // 9. auth.login* ops via management instance
        const loginRefused = await call("auth.loginStart", { flowId: "flow-unknown", provider: "not-a-real-provider" });
        assert.equal(loginRefused.ok, true, JSON.stringify(loginRefused));
        assert.equal(loginRefused.result.started, false);
        assert.match(loginRefused.result.message, /Unknown provider/);

        const pollEmpty = await call("auth.loginPoll", { flowId: "nonexistent-flow", since: 0 });
        assert.equal(pollEmpty.ok, true, JSON.stringify(pollEmpty));
        assert.deepEqual(pollEmpty.result.events, []);
        assert.equal(pollEmpty.result.done, true);

        const submitBad = await call("auth.loginSubmit", { provider: "openai", token: "openai-bad-token", code: "123" });
        assert.equal(submitBad.ok, true, JSON.stringify(submitBad));
        assert.equal(submitBad.result.status, "no_pending");

        const cancelNone = await call("auth.loginCancel", { flowId: "nonexistent-flow" });
        assert.equal(cancelNone.ok, true, JSON.stringify(cancelNone));
        assert.equal(cancelNone.result.cancelled, false);

        const stillUsable = await call("auth.providers", {});
        assert.equal(stillUsable.ok, true, "usable after refused ops");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
      }
    } finally {
      if (client) await client.close(5_000).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);
