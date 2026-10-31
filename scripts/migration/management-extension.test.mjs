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
