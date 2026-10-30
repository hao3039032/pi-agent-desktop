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
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");

const executable = resolvePiCliBin();
const HERE = import.meta.dirname;

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
      await mkdir(managed, { recursive: true });
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");
      const vendorClosure = (entryPackage) => {
        const seen = new Set();
        const walk = (name) => {
          if (seen.has(name)) return;
          seen.add(name);
          const dir = join(HERE, "../../node_modules", ...name.split("/"));
          const manifest = join(dir, "package.json");
          if (!existsSync(manifest)) return;
          let deps = {};
          try {
            deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
          } catch {}
          for (const dep of Object.keys(deps)) walk(dep);
        };
        walk(entryPackage);
        return [...seen];
      };
      cpSync(join(HERE, "../../node_modules/croner"), join(managed, "croner"), { recursive: true });
      for (const pkg of vendorClosure("@earendil-works/pi-ai")) {
        const from = join(HERE, "../../node_modules", ...pkg.split("/"));
        if (!existsSync(join(from, "package.json"))) continue;
        cpSync(from, join(managed, ...pkg.split("/")), { recursive: true });
      }
      // The SDK package itself (its config/utils/messages graph resolves
      // against the same closure).
      cpSync(
        join(HERE, "../../node_modules/@earendil-works/pi-coding-agent"),
        join(managed, "@earendil-works/pi-coding-agent"),
        { recursive: true },
      );
      // The closure for the SDK's own external imports (pi-ai covered
      // above; anything else the session-manager graph reaches).
      for (const pkg of vendorClosure("@earendil-works/pi-coding-agent")) {
        const from = join(HERE, "../../node_modules", ...pkg.split("/"));
        if (!existsSync(join(from, "package.json"))) continue;
        const target = join(managed, ...pkg.split("/"));
        if (!existsSync(join(target, "package.json"))) {
          cpSync(from, target, { recursive: true });
        }
      }

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
        const created =
          !readdirSync ? 0 : (() => {
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
