/**
 * M0 verification: the management-instance dependency loading mechanism.
 *
 * The plan (§五 管理实例) requires the shipped management extension to load
 * its dependencies from an ISOLATED, fixed-version module tree — never
 * resolved accidentally from the checkout's node_modules, the system npm or
 * the pi host's internal graph. This test proves the mechanism end-to-end
 * under the real pi child (`PI_CLI_BIN`, fully sandboxed):
 *
 *   - a vendored tree (<tmp>/managed/node_modules/croner, the exact locked
 *     10.x copy from this repo's node_modules) is imported BY ABSOLUTE PATH
 *     from an extension running inside the pi child;
 *   - the import resolves to the vendored file (the child reports the loaded
 *     module URL back), not to any other croner the runtime could see;
 *   - the vendored module actually executes in the child runtime (a Cron
 *     expression computes its next run — the cron semantics the scheduled
 *     tasks will reuse);
 *   - no NODE_PATH or cwd shortcut is involved (the child runs with an empty
 *     NODE_PATH and a temp cwd).
 *
 * Skips without PI_CLI_BIN (same convention as lib/pi-rpc/*.smoke.test.mjs).
 */

import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");

const executable = resolvePiCliBin();

test(
  "management dependencies load from an isolated vendored module tree inside the real pi child",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mgmt-deps-"));
    const cwd = join(root, "work");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    const managed = join(root, "managed");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    // The vendored, fixed-version module tree: the locked croner copy from
    // this checkout (10.x, dependency-free). In the shipped product this is
    // <resources>/managed-node_modules with its own lockfile; the loading
    // mechanism under test is identical.
    await mkdir(join(managed, "node_modules"), { recursive: true });
    cpSync(
      join(import.meta.dirname, "../../node_modules/croner"),
      join(managed, "node_modules", "croner"),
      { recursive: true },
    );
    const vendoredCroner = join(managed, "node_modules", "croner", "dist", "croner.js");
    const vendoredPackage = JSON.parse(
      await readFile(join(managed, "node_modules", "croner", "package.json"), "utf8"),
    );

    // The fixture extension: imports the vendored module BY ABSOLUTE PATH and
    // reports the resolved URL + a real computation back over notify.
    const fixture = `
import { Cron } from ${JSON.stringify(vendoredCroner)};
export default function managementFixture(pi) {
  pi.registerCommand("poc:mgmt", {
    description: "M0 management dependency loading probe",
    handler: async (_args, ctx) => {
      const cron = new Cron("17 5 * * *", { timezone: "UTC" });
      const next = cron.nextRun();
      cron.stop();
      ctx.ui.notify(JSON.stringify({
        probe: "poc:mgmt",
        vendoredUrl: import.meta.resolve(${JSON.stringify(vendoredCroner)}),
        nextRunISO: next instanceof Date ? next.toISOString() : String(next),
      }), "info");
      return "poc:mgmt handled";
    },
  });
}
`;
    const fixturePath = join(root, "mgmt-fixture.mjs");
    await writeFile(fixturePath, fixture, "utf8");

    const client = new PiRpcClient(executable, {
      cwd,
      args: [
        "--session-dir", sessionDir,
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--no-session",
        "--extension", fixturePath,
      ],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        // No resolution shortcuts: the vendored tree is reached only through
        // the absolute path the host passes into the extension.
        NODE_PATH: "",
      },
      onLog: () => {},
    });

    try {
      // Extension commands are consumed by the extension runtime: no run
      // starts, the tokens never become model input.
      const notifies = [];
      const offNotify = client.onUi("notify", (record) => {
        notifies.push(record);
        return undefined;
      });
      const ack = await client.command(
        "prompt",
        { message: "/poc:mgmt" },
        30_000,
      );
      assert.equal(ack?.disposition, "handled", "the child treated the message as an extension command");

      const deadline = Date.now() + 10_000;
      while (notifies.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(notifies.length > 0, "the fixture reported back over notify");
      const probe = JSON.parse(notifies.find((record) => {
        try {
          return typeof record.message === "string" && JSON.parse(record.message).probe === "poc:mgmt";
        } catch {
          return false;
        }
      })?.message ?? "{}");

      // 1. The module resolved INSIDE the vendored tree (the fixed-version
      //    copy, not anything the child could otherwise see).
      assert.equal(
        probe.vendoredUrl,
        `file://${vendoredCroner}`,
        "import resolved to the vendored file by absolute path",
      );
      // 2. It is the locked version the tree ships.
      assert.match(vendoredPackage.version, /^10\./);
      // 3. It executed in the child runtime: 05:17 UTC computed as a date.
      assert.match(probe.nextRunISO, /^20\d\d-\d\d-\d\dT05:17:00\.000Z$/, `cron computed: ${probe.nextRunISO}`);
      offNotify();
    } finally {
      await client.close(5_000);
      await rm(root, { recursive: true, force: true });
    }
  },
);
