/**
 * The static-UI vertical acceptance run (test-only; the migration's first
 * REAL-UI gate — docs/migration/README.md "静态UI纵向验收").
 *
 * What it proves, end to end, with the REAL static bundle, the REAL Rust
 * host (`pi_ipc`'s command functions over the harness bridge), REAL pi CLI
 * session children and a controllable local fixture provider (no real
 * credentials, no real network model):
 *
 *   project create → send → stream → stop → queue edit/send → reopen
 *   unknown park: the session child dies mid-delivery → the row reappears
 *   outcome-unknown → the first click only arms → the second confirms the
 *   re-send (the real two-click confirmation, driven by a real SIGKILL of
 *   the pi child — the production trigger for an unknown outcome)
 *   chat create → send → stream → answer
 *
 * The only replaced layer is Tauri's own WebView invoke/Channel plumbing
 * (`static-ui-harness.rs` + `static-ui-harness-polyfill.js`); everything
 * above it — the React tree, the IPC data layer, the host dispatch, the
 * session-host state machine, the spawn plans, the pi children — is the
 * shipping code.
 *
 * Run: node scripts/migration/static-ui-acceptance.mjs
 * (requires: built static-frontend → desktop/frontend-static; cargo build
 *  --features harness --bin static-ui-harness; playwright's chromium)
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PI_BIN = process.env.PI_CLI_BIN || "/home/hao/.pi/agent/bin/pi";
const HARNESS_BIN = join(ROOT, "src-tauri/target/debug/static-ui-harness");
const STATIC_DIR = join(ROOT, "desktop/frontend-static");
const POLYFILL = readFileSync(join(HERE, "static-ui-harness-polyfill.js"), "utf8");
const KEEP = Boolean(process.env.STATIC_UI_ACCEPTANCE_KEEP);

// The bridge token for this run: the harness refuses invoke/events/shutdown
// without it, so a website open in the user's browser cannot drive the real
// pi host while the acceptance run listens.
const bridgeToken = randomBytes(32).toString("hex");

// The current step, for the hard-deadline message (which step hung).
let currentStep = "startup";

// Playwright pins an exact browser build; this machine's cache may hold a
// neighbouring full-chromium build (or the system chrome). Prefer the env
// override, then the full chromium build present in the playwright cache,
// then playwright's own resolution.
function resolveChromiumLaunch() {
  if (process.env.STATIC_UI_ACCEPTANCE_BROWSER) {
    return { executablePath: process.env.STATIC_UI_ACCEPTANCE_BROWSER };
  }
  const cache = join(process.env.HOME || ".", ".cache", "ms-playwright");
  const candidates = [
    join(cache, "chromium-1243", "chrome-linux", "chrome"),
    join(cache, "chromium-1243", "chrome-linux64", "chrome"),
    join(cache, "chromium-1234", "chrome-linux", "chrome"),
    join(cache, "chromium-1234", "chrome-linux64", "chrome"),
  ].filter((path) => existsSync(path));
  if (candidates.length > 0) {
    return { executablePath: candidates[0] };
  }
  if (existsSync("/usr/bin/google-chrome-stable")) {
    return { executablePath: "/usr/bin/google-chrome-stable" };
  }
  return {};
}

assert.ok(existsSync(PI_BIN), `pi CLI not found at ${PI_BIN}`);
assert.ok(existsSync(HARNESS_BIN), `harness bin missing — cargo build --features harness --bin static-ui-harness (in src-tauri)`);
assert.ok(existsSync(join(STATIC_DIR, "index.html")), `static bundle missing — cd static-frontend && npm run build`);

// ---------------------------------------------------------------------------
// The sandbox: an isolated agent dir (fixture provider + seeded default
// model, the same shape PUT /api/models/default writes), a sandboxed HOME
// (default-cwd creation must never touch the real one) and a project dir.
// ---------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "static-ui-acceptance-"));
const agentDir = join(sandbox, "agent");
const home = join(sandbox, "home");
const projectDir = join(sandbox, "project");
mkdirSync(join(agentDir, "sessions"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(projectDir, { recursive: true });

// The fixture provider: openai-completions SSE against a scriptable local
// server. Behaviours are switched per step from the driver.
const scripts = new Map(); // name -> (req, res) => void
let currentScript = "default";
// Tracked so cleanup can destroy them: the `hang` fixture never ends its
// SSE response, and keep-alive sockets keep the driver's event loop alive
// after providerServer.close() (close() only stops NEW connections).
const providerSockets = new Set();
const providerServer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const handler = scripts.get(currentScript) ?? scripts.get("default");
    handler({ req, res, body: body ? JSON.parse(body) : {} });
  });
});
providerServer.on("connection", (socket) => {
  providerSockets.add(socket);
  socket.on("close", () => providerSockets.delete(socket));
});
const sse = (res, chunks, { end = true } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (end) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
};
const delta = (text) => ({ choices: [{ delta: { content: text } }] });
scripts.set("default", ({ res }) => sse(res, [
  { choices: [{ delta: { role: "assistant" } }] },
  delta("FIXTURE-REPLY part1 part2"),
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]));
// slow-stream: two chunks with a gap — enough window to observe streaming
// deltas landing in the UI while the run is open.
scripts.set("slow-stream", async ({ res }) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
  await delay(400);
  res.write(`data: ${JSON.stringify(delta("STREAMING-PART-ONE "))}\n\n`);
  await delay(2600);
  res.write(`data: ${JSON.stringify(delta("STREAMING-PART-TWO"))}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
// hang: an open stream that never finishes — the stop path's fixture.
scripts.set("hang", async ({ res }) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
  await delay(300);
  res.write(`data: ${JSON.stringify(delta("HANGING-RUN "))}\n\n`);
  // intentionally never completes
});
await new Promise((r) => providerServer.listen(0, "127.0.0.1", r));
const providerPort = providerServer.address().port;

// The models.json fixture, kept verbatim so the models-config save step can
// restore the sandbox's exact baseline after its UI round trip.
const fixtureModelsJson = JSON.stringify({
  providers: {
    "fixture-provider": {
      name: "Fixture Provider",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: "fixture-key",
      api: "openai-completions",
      models: [{ id: "fixture-model", name: "Fixture Model" }],
    },
    // A second provider so the settings step can switch the FIRST one off
    // without tripping the last-enabled-model guard (an empty scope means
    // every model in pi — the switch refuses that server-side).
    "fixture-second": {
      name: "Fixture Second",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: "fixture-second-key",
      api: "openai-completions",
      models: [{ id: "fixture-second-model", name: "Fixture Second Model" }],
    },
  },
}, null, 2);
writeFileSync(join(agentDir, "models.json"), fixtureModelsJson);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: "fixture-provider",
  defaultModel: "fixture-model",
}, null, 2));

// The vendored management tree (the chat prompt path needs the real
// management extension + its module graph — the same staging rules
// desktop:prepare uses; never a partial tree).
const managedTree = join(sandbox, "managed", "node_modules");
execFileSync(process.execPath, [join(HERE, "stage-managed-tree.mjs"), "--out", managedTree], {
  cwd: ROOT, stdio: "inherit",
});

// ---------------------------------------------------------------------------
// The harness process (the real host commands; cwd=src-tauri so the dev
// asset resolution finds lib/pi-rpc/assets/*).
// ---------------------------------------------------------------------------
// `detached` on POSIX gives the harness its OWN process group, so cleanup
// can kill exactly the tree this driver spawned (never a pkill by name —
// that could take an unrelated run's or a user's process with it).
const harnessOwnsGroup = process.platform !== "win32";
const harness = spawn(HARNESS_BIN, ["--static-dir", STATIC_DIR, "--port", "0"], {
  cwd: join(ROOT, "src-tauri"),
  env: {
    ...process.env,
    // The app shell's own SDK variables (AGENTS.md) must not reach the pi
    // children: they point at the INSTALLED app's packages, not this
    // checkout. `undefined` values are omitted from the child env.
    PI_PACKAGE_DIR: undefined,
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: undefined,
    JITI_ALIAS: undefined,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CLI_BIN: PI_BIN,
    PI_WEB_MANAGED_MODULES: managedTree,
    HOME: home,
    STATIC_UI_HARNESS_TOKEN: bridgeToken,
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: harnessOwnsGroup,
});
const harnessErrors = [];
let harnessUrl = null;
harness.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(`[harness] ${text}`);
  harnessErrors.push(text);
});
{
  let out = "";
  const ready = new Promise((resolveReady, reject) => {
    harness.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const line = out.split("\n").find((entry) => entry.includes("\"harness\":\"ready\""));
      if (line) {
        harnessUrl = `http://127.0.0.1:${JSON.parse(line).port}`;
        resolveReady();
      }
    });
    harness.once("exit", (code) => reject(new Error(`harness exited before ready (${code}): ${out}`)));
  });
  await Promise.race([ready, delay(20_000).then(() => { throw new Error(`harness not ready: ${out}`); })]);
}
console.log(`[acceptance] harness at ${harnessUrl}`);

// The native folder-dialog stand-in: the harness answers plugin:dialog|open
// from the init-script constant (the desktop project flow's only native hop);
// retarget with page.evaluate('__acceptanceDialog = ...') if a later step
// needs a different folder.

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true, ...resolveChromiumLaunch() });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(`console.error: ${message.text()}`);
  if (message.text().includes("[acceptance-dbg]")) console.log(`[page] ${message.text()}`);
});
await page.addInitScript(`
  window.__STATIC_UI_HARNESS_TOKEN__ = ${JSON.stringify(bridgeToken)};
  window.__STATIC_UI_ACCEPTANCE_DIALOG = ${JSON.stringify(projectDir)};
  ${POLYFILL}
  // The native dialog stand-in (plugin:dialog|open) — the ONLY product
  // command the bridge fakes; the driver can retarget it per step.
  const realInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd, args, options) => {
    if (cmd === "plugin:dialog|open") {
      return Promise.resolve(window.__STATIC_UI_ACCEPTANCE_DIALOG ?? null);
    }
    return realInvoke(cmd, args, options);
  };
`);
await page.addInitScript(() => {
  // A stable, known locale for the driver's label selectors.
  localStorage.setItem("pi-locale", "en");
});

const step = (name) => {
  currentStep = name;
  console.log(`[acceptance] ${name}`);
};
// The missing-dependency inventory: every /api fetch and EventSource the
// page attempts (the production-blocker list — each must end up on IPC or
// be gone before the static app ships).
const apiAttempts = [];
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/api/") && !url.includes("/__harness__/")) {
    apiAttempts.push(`${request.method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  }
});
/** The transcript's user bubble (MessageView's .message-user). */
const userMessage = (page2, text) => page2.locator(".message-user").filter({ hasText: text });
/** The transcript's assistant text (MessageView's .message-assistant).
 * `.first()`: a session legitimately holds several assistant bubbles (one
 * per completed run); the assertion is "at least one matching". */
const assistantText = (page2, text) => page2.locator(".message-assistant").filter({ hasText: text }).first();
const softIssues = [];

// ---------------------------------------------------------------------------
// Reaping — the part a failed run must not skip.
// ---------------------------------------------------------------------------
// 1. the browser (its sockets feed the provider's `hang` fixture);
// 2. the harness GRACEFULLY (`POST /__harness__/shutdown`: every session
//    child, management instance and PTY gets stdin-EOF + grace kill, so no
//    pi process is orphaned);
// 3. backstop: kill the harness's own process group (only the tree this
//    driver spawned — never a pkill by name), bounded wait, loud if it
//    survives even that;
// 4. the provider server's sockets (destroyed: close() alone leaves the
//    never-ending hang stream holding the event loop open);
// 5. the sandbox.
let tornDown = false;
async function teardown(reason) {
  if (tornDown) return;
  tornDown = true;
  // 1. browser (bounded: a wedged renderer must not wedge the report). The
  // timeout note only fires when the close REALLY lost the race — the
  // page/context closes land in milliseconds, so a hang here is the browser
  // process itself; the run still exits (nothing below waits on it), and the
  // harness/pi reaping below never depended on the browser.
  let browserPhaseSettled = false;
  await Promise.race([
    (async () => {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close();
      browserPhaseSettled = true;
    })(),
    delay(10_000).then(() => {
      if (!browserPhaseSettled) {
        console.error("[acceptance] browser.close() timed out after 10s (post-run cleanup only; steps and reaping already complete)");
      }
    }),
  ]);
  // 2. graceful harness shutdown (bounded).
  if (harnessUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${harnessUrl}/__harness__/shutdown`, {
        method: "POST",
        headers: { "x-harness-token": bridgeToken },
        signal: controller.signal,
      });
      clearTimeout(timer);
      console.log(`[acceptance] (${reason}) harness shutdown: HTTP ${response.status}`);
    } catch (error) {
      console.error(`[acceptance] (${reason}) graceful harness shutdown failed: ${error.message}`);
    }
  }
  // 3. backstop: the harness's process group, then a bounded wait.
  if (!(await waitForExit(harness, 15_000))) {
    killHarnessTree("SIGKILL");
    if (await waitForExit(harness, 10_000)) {
      console.error(`[acceptance] (${reason}) harness needed SIGKILL (graceful shutdown did not end it)`);
    } else {
      // Never silently green over an unreaped harness: it holds pi children.
      console.error(`[acceptance] (${reason}) FAILED TO REAP harness pid=${harness.pid} — it may still hold pi children; investigate before rerunning`);
      process.exitCode = 1;
    }
  }
  // 4. provider sockets + server.
  for (const socket of providerSockets) socket.destroy();
  providerSockets.clear();
  if (typeof providerServer.closeAllConnections === "function") providerServer.closeAllConnections();
  providerServer.close();
  // 5. sandbox.
  if (!KEEP) {
    rmSync(sandbox, { recursive: true, force: true });
  } else {
    console.log(`[acceptance] kept sandbox: ${sandbox}`);
  }
}

function killHarnessTree(signal) {
  if (!harness.pid) return;
  try {
    if (harnessOwnsGroup) process.kill(-harness.pid, signal);
    else harness.kill(signal);
  } catch {
    // ESRCH: already gone.
  }
}

/** SIGKILL the pi session child(ren) serving this run's sandbox. The pi
 * CLI REWRITES its process title (`process.title = "pi-rpc"` in
 * rpc-entry.js), so /proc/<pid>/cmdline no longer holds `--session` — the
 * unique, stable identifier is the process's WORKING DIRECTORY: a session
 * child runs in its session cwd (the sandbox's project folder), and nothing
 * outside this sandbox ever does. Never match by process name alone (an
 * unrelated run's or the user's pi must never be touched); the harness
 * itself runs in the checkout, and the browser/renderer processes match
 * neither the cwd nor the pi title. */
function killSessionChildren() {
  if (process.platform !== "linux" || !existsSync("/proc")) {
    throw new Error(`the unknown-park step needs a Linux /proc to target the session child (platform: ${process.platform}) — extend the driver for this platform instead of skipping the step`);
  }
  const killed = [];
  const sandboxes = []; // diagnostics: every process whose cwd sits in this sandbox
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue; // not ours, a kernel thread, or already gone
    }
    if (!cwd.startsWith(sandbox)) continue;
    sandboxes.push(`[${entry}] cwd=${cwd}`);
    let argv;
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    // The rewritten title of a pi rpc child (session or management) begins
    // with "pi"; anything else living in the sandbox cwd (none today) is
    // not ours to kill.
    if (!argv[0]?.startsWith("pi")) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
      killed.push(Number(entry));
    } catch {
      // ESRCH: exited between the read and the kill.
    }
  }
  if (killed.length === 0 && sandboxes.length > 0) {
    console.error("[acceptance] /proc scan saw these sandbox-cwd processes but no pi match:\n  " + sandboxes.join("\n  "));
  }
  return killed;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

// The hard deadline: a hung step must still produce a real exit (and reap
// the tree), not a buffered pipe that never drains.
const HARD_DEADLINE_MS = 20 * 60_000;
const hardTimer = setTimeout(() => {
  console.error(`[acceptance] HARD DEADLINE (${HARD_DEADLINE_MS / 1000}s) exceeded during "${currentStep}" — forcing cleanup and exit 1`);
  process.exitCode = 1;
  killHarnessTree("SIGKILL");
  for (const socket of providerSockets) socket.destroy();
  process.exit(1);
}, HARD_DEADLINE_MS);
hardTimer.unref?.();

try {
  // ------------------------------------------------------------------ boot
  step("boot: the static app mounts over the IPC bridge");
  await page.goto(harnessUrl, { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => document.documentElement.lang === "en", null, { timeout: 30_000 });
  // The reconnect banner: a fake "offline" banner was a real product bug
  // (the probe hit /api/home, which the static app does not serve). The
  // probe now rides IPC (`desktop.identity`), so the banner may not appear —
  // and a regression must FAIL the run, not log a soft issue. (The model
  // selector's error banner is also role=alert, so match by text.)
  const offlineBanner = await page
    .getByText("Lost connection to the local Pi Agent server", { exact: false })
    .count();
  assert.equal(offlineBanner, 0, "the reconnect banner appeared: the desktop-connection probe is broken again");

  // ------------------------------------------------------- project create
  step("project: Add project → native dialog (bridged) → cwd validated");
  const addProject = page.locator(".sidebar-empty-add");
  await addProject.waitFor({ timeout: 30_000 });
  await addProject.click();
  // selectProjectDirectoryNative → plugin:dialog|open (bridged answer) →
  // validateWorkspaceCwd → activateProject → the composer's cwd switches
  // to the project dir. The switch is ASYNC (a dialog answer + a validate
  // round trip): sending from the still-chats view would create the session
  // in the wrong workspace — wait for the topbar subtitle to show the
  // project folder before typing.
  await page.waitForFunction(
    (expected) => document.querySelector(".app-topbar-title small")?.textContent?.includes(expected),
    "project",
    { timeout: 30_000 },
  );

  // --------------------------------------------------- project send+stream
  step("project: first send → agent.create → stream deltas → answer");
  currentScript = "slow-stream";
  const composer = page.locator("textarea");
  await composer.fill("project first message");
  await composer.press("Enter");
  // The user message lands in the transcript…
  await userMessage(page, "project first message").waitFor({ timeout: 60_000 });
  // …the assistant's first streamed chunk arrives while the run is open…
  await assistantText(page, "STREAMING-PART-ONE").waitFor({ timeout: 60_000 });
  // …and the run is still going (the stop control is offered).
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "stop";
  }, null, { timeout: 30_000 });
  // …then the run settles with the full streamed answer.
  await assistantText(page, "STREAMING-PART-TWO").waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") !== "stop";
  }, null, { timeout: 30_000 });

  // ------------------------------------------------------------- queue flow
  step("project: queue while running → edit the queued message → send now");
  currentScript = "slow-stream";
  await composer.fill("queued original");
  await composer.press("Enter"); // while idle this would send; start a run first:
  // (the send above started a run; queue the second one)
  await composer.fill("second queued message");
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "queue";
  }, null, { timeout: 30_000 });
  await page.locator(".composer-send-button").click();
  // The host outbox row appears (pending, editable).
  const outboxRow = page.locator(".composer-outbox-row").filter({ hasText: "second queued message" });
  await outboxRow.waitFor({ timeout: 30_000 });
  // Edit: take it back into the composer… (exact: the row ALSO holds a
  // preview button whose label is "Edit queued message: <text>" — substring
  // matching would resolve two elements.)
  await outboxRow.getByRole("button", { name: "Edit queued message", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value.includes("second queued message"),
    null,
    { timeout: 30_000 },
  );
  // …change it and queue the edited text again.
  await composer.fill("second queued message EDITED");
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "queue";
  }, null, { timeout: 30_000 });
  await page.locator(".composer-send-button").click();
  const editedRow = page.locator(".composer-outbox-row").filter({ hasText: "second queued message EDITED" });
  await editedRow.waitFor({ timeout: 30_000 });
  // Send now: the outbox delivers it into the open run.
  await editedRow.getByRole("button", { name: "Send now", exact: true }).click();
  await userMessage(page, "second queued message EDITED").waitFor({ timeout: 60_000 });
  // The outbox row is gone (delivered).
  await page.waitForFunction(
    () => !document.querySelector(".composer-outbox-row"),
    null,
    { timeout: 60_000 },
  );
  // Let the run finish before the stop step.
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") !== "stop";
  }, null, { timeout: 60_000 });

  // ------------------------------------------------------------------ stop
  step("project: stop a hanging run");
  currentScript = "hang";
  await composer.fill("message that will hang");
  await composer.press("Enter");
  await assistantText(page, "HANGING-RUN").waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "stop";
  }, null, { timeout: 30_000 });
  await page.locator(".composer-send-button").click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") !== "stop";
  }, null, { timeout: 60_000 });

  // ------------------------------------------------- unknown park + confirm
  step("project: child dies mid-delivery → row parks unknown → two-click confirm");
  // 1. Another hanging run (the delivery will block on its settle).
  currentScript = "hang";
  await composer.fill("hang for the unknown park");
  await composer.press("Enter");
  await userMessage(page, "hang for the unknown park").waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "stop";
  }, null, { timeout: 30_000 });
  // 2. Queue a message behind the hanging run (the pending row).
  await composer.fill("possibly executed message");
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") === "queue";
  }, null, { timeout: 30_000 });
  await page.locator(".composer-send-button").click();
  const pendingRow = page.locator(".composer-outbox-row").filter({ hasText: "possibly executed message" });
  await pendingRow.waitFor({ timeout: 30_000 });
  // 3. Send now: the host takes the row and delivers it behind the hanging
  //    run — the row disappears and the delivery blocks on the settle wait.
  await pendingRow.getByRole("button", { name: "Send now", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector(".composer-outbox-row"),
    null,
    { timeout: 30_000 },
  );
  //    The prompt round-trip is fast; give it a beat, then kill the session
  //    child — the REAL production trigger for an outcome-unknown delivery.
  await delay(500);
  const killed = killSessionChildren();
  assert.ok(
    killed.length >= 1,
    "found and killed the hanging session child (no --session argv under the sandbox agentDir matched)",
  );
  // 4. The settle wait observes the exit: the row REAPPEARS parked unknown.
  const unknownRow = page
    .locator(".composer-outbox-row-unknown")
    .filter({ hasText: "possibly executed message" });
  await unknownRow.waitFor({ timeout: 60_000 });
  const badge = (await unknownRow.locator(".composer-outbox-unknown").textContent()) ?? "";
  assert.ok(
    badge.includes("Send result unknown"),
    `the unknown badge renders (got: ${badge.trim()})`,
  );
  // 5. The send button on an unknown row says "Confirm send": the FIRST
  //    click only arms — it must not deliver.
  const confirmButton = unknownRow.getByRole("button", { name: "Confirm send", exact: true });
  await confirmButton.waitFor({ timeout: 10_000 });
  await confirmButton.click();
  await page.waitForFunction(() => {
    const row = document.querySelector(".composer-outbox-row-unknown");
    if (!row) return false;
    const badgeText = row.querySelector(".composer-outbox-unknown")?.textContent ?? "";
    const armed = [...row.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Send now",
    );
    return badgeText.includes("Send again?") && armed;
  }, null, { timeout: 10_000 });
  assert.equal(
    await userMessage(page, "possibly executed message").count(),
    0,
    "the armed first click must not deliver the possibly-executed message",
  );
  // 6. The confirmed SECOND click sends for real: the dead session
  //    cold-restarts from disk and the message delivers + settles.
  currentScript = "default";
  await unknownRow.getByRole("button", { name: "Send now", exact: true }).click();
  await userMessage(page, "possibly executed message").waitFor({ timeout: 120_000 });
  await assistantText(page, "FIXTURE-REPLY").waitFor({ timeout: 120_000 });
  await page.waitForFunction(
    () => !document.querySelector(".composer-outbox-row"),
    null,
    { timeout: 60_000 },
  );
  await page.waitForFunction(() => {
    const button = document.querySelector(".composer-send-button");
    return button && button.getAttribute("data-action") !== "stop";
  }, null, { timeout: 60_000 });

  // ------------------------------------------------------------------ chat
  step("chat: New chat → chat folder + policy → send → stream → answer");
  // The section tools are hover-revealed (`pointer-events: none` until the
  // header is hovered — the product's desktop affordance), so hover first.
  await page.locator(".sidebar-chats-header").hover();
  const newChat = page.getByRole("button", { name: "New chat" });
  await newChat.waitFor({ timeout: 30_000 });
  await newChat.click();
  await composer.fill("chat first message");
  await composer.press("Enter");
  await userMessage(page, "chat first message").waitFor({ timeout: 60_000 });
  currentScript = "default";
  await assistantText(page, "FIXTURE-REPLY").waitFor({ timeout: 60_000 });

  // ---------------------------------------------------------------- reopen
  step("reopen: switch away and back — the project session reloads from disk");
  // The sidebar row's title is the session's FIRST message (the stop step's
  // message lives in the same session as the project's first), so both rows
  // are keyed by their first messages.
  const chatRow = page.locator(".session-item").filter({ hasText: "chat first message" }).first();
  const projectRow = page.locator(".session-item").filter({ hasText: "project first message" }).first();
  await projectRow.waitFor({ timeout: 30_000 });
  await chatRow.waitFor({ timeout: 30_000 });
  await chatRow.click();
  await userMessage(page, "chat first message").waitFor({ timeout: 60_000 });
  await projectRow.click();
  await userMessage(page, "project first message").waitFor({ timeout: 60_000 });
  await assistantText(page, "STREAMING-PART-TWO").waitFor({ timeout: 60_000 });

  // The session files exist on disk under the isolated agent dir (the host,
  // not the UI, wrote them).
  const sessionDir = join(agentDir, "sessions");
  const written = readdirSafe(sessionDir);
  assert.ok(written.length >= 2, `expected the session files under ${sessionDir}, saw ${written.length}`);

  // ------------------------------------------------------ settings models
  step("settings: Models panel — the enabled switch toggles, survives a reopen, restores");
  // The REAL settings dialog over the REAL IPC bridge: the panel's provider
  // list loads through modelsConfig.get, its switches through
  // models.enabledGet/models.enabledSet (a raw /api/models/* here would be a
  // production blocker — the static app has no HTTP server).
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-dialog-surface").waitFor({ timeout: 30_000 });
  await page.locator(".settings-section-tab", { hasText: "Models" }).click();
  // The fixture provider's row (models.json providers list) + its detail,
  // auto-selected as the first provider.
  const providerRow = page.locator(".config-sidebar-item", { hasText: "fixture-provider" }).first();
  await providerRow.waitFor({ timeout: 30_000 });
  // The whole-provider switch a models.json provider gets (ADR 0004). It
  // only renders once the enabledModels view arrived — that IS the
  // models.enabledGet round trip.
  const providerSwitch = page.getByRole("switch", { name: "Enable all Fixture Provider models" });
  await providerSwitch.waitFor({ timeout: 30_000 });
  assert.equal(await providerSwitch.getAttribute("aria-checked"), "true", "everything starts enabled");
  // Toggle OFF: one serialized write through the management instance.
  await providerSwitch.click();
  await page.waitForFunction(() => {
    const toggle = [...document.querySelectorAll('[role="switch"]')].find(
      (node) => node.getAttribute("aria-label") === "Enable all Fixture Provider models",
    );
    return toggle && toggle.getAttribute("aria-checked") === "false" && !toggle.getAttribute("aria-busy");
  }, null, { timeout: 60_000 });
  let settingsDisk = readFileSync(join(agentDir, "settings.json"), "utf8");
  assert.ok(settingsDisk.includes("fixture-second"), `the write narrowed the scope to the other provider: ${settingsDisk}`);
  assert.ok(!settingsDisk.includes("fixture-provider/"), `fixture-provider is out of the scope: ${settingsDisk}`);
  // Close and reopen the dialog (a fresh models.enabledGet read): the
  // switch state must come back from disk, not from stale UI state.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".settings-dialog-surface"), null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-dialog-surface").waitFor({ timeout: 30_000 });
  await page.locator(".settings-section-tab", { hasText: "Models" }).click();
  await providerSwitch.waitFor({ timeout: 30_000 });
  assert.equal(
    await providerSwitch.getAttribute("aria-checked"),
    "false",
    "the disabled scope survived the reopen (read from disk)",
  );
  // Toggle back ON: the scope stops narrowing anything, so the setting is
  // dropped again (the engine's serialize rule) — the initial state restored.
  await providerSwitch.click();
  await page.waitForFunction(() => {
    const toggle = [...document.querySelectorAll('[role="switch"]')].find(
      (node) => node.getAttribute("aria-label") === "Enable all Fixture Provider models",
    );
    return toggle && toggle.getAttribute("aria-checked") === "true" && !toggle.getAttribute("aria-busy");
  }, null, { timeout: 60_000 });
  settingsDisk = readFileSync(join(agentDir, "settings.json"), "utf8");
  assert.ok(!settingsDisk.includes("enabledModels"), `everything enabled drops the key again: ${settingsDisk}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".settings-dialog-surface"), null, { timeout: 30_000 });

  // ------------------------------------------- models.json edit + save
  step("settings: Models panel — edit models.json, save over IPC, reopen: persisted, fixture restored");
  // The REAL save path (modelsConfig.put through the management instance):
  // the panel edits a provider KEY (rename), saves, and the write must (a)
  // land on disk, (b) merge back the stored literal apiKey of the provider
  // the draft never saw (GET redacts it), and (c) survive a close/reopen
  // through a fresh modelsConfig.get. The rename is undone at the end so
  // later readers see the original fixture.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-dialog-surface").waitFor({ timeout: 30_000 });
  await page.locator(".settings-section-tab", { hasText: "Models" }).click();
  await page.locator(".config-sidebar-item", { hasText: "fixture-provider" }).first().waitFor({ timeout: 30_000 });
  // The rename flow: type a new provider key + Rename (moves the provider
  // and records the move for the post-save resync).
  await page.getByPlaceholder("provider-name").fill("fixture-renamed");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const renamedRow = page.locator(".config-sidebar-item", { hasText: "fixture-renamed" }).first();
  await renamedRow.waitFor({ timeout: 30_000 });
  // Save: one modelsConfig.put request — the button goes busy then Saved.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Saved"),
    null,
    { timeout: 60_000 },
  );
  let modelsDisk = readFileSync(join(agentDir, "models.json"), "utf8");
  assert.ok(modelsDisk.includes("fixture-renamed"), `the rename landed: ${modelsDisk}`);
  assert.ok(!/"fixture-provider"/.test(modelsDisk), `the old key is gone: ${modelsDisk}`);
  assert.ok(
    modelsDisk.includes("fixture-second-key"),
    `the untouched provider's literal apiKey survived a save whose draft never saw it: ${modelsDisk}`,
  );
  assert.ok(!modelsDisk.includes("fixture-key\""), `the renamed provider's literal did not follow the rename (the merge's own semantics): ${modelsDisk}`);
  // Close and reopen the dialog (a fresh modelsConfig.get): the rename
  // must come back from DISK, not from stale UI state.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".settings-dialog-surface"), null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-dialog-surface").waitFor({ timeout: 30_000 });
  await page.locator(".settings-section-tab", { hasText: "Models" }).click();
  await renamedRow.waitFor({ timeout: 30_000 });
  // Restore the fixture: rename the provider back and save again. The
  // provider KEY returns, but the merge's own name-keyed semantics mean the
  // dropped literal does NOT come back (pinned in the seam tests) — the
  // driver then restores the exact fixture bytes below.
  await renamedRow.click();
  await page.getByPlaceholder("provider-name").fill("fixture-provider");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.locator(".config-sidebar-item", { hasText: "fixture-provider" }).first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Saved"),
    null,
    { timeout: 60_000 },
  );
  modelsDisk = readFileSync(join(agentDir, "models.json"), "utf8");
  assert.ok(modelsDisk.includes("\"fixture-provider\""), `the fixture provider key is restored: ${modelsDisk}`);
  assert.ok(modelsDisk.includes("fixture-second"), `the second provider survived the round trip: ${modelsDisk}`);
  assert.ok(
    !modelsDisk.includes("fixture-key"),
    `the rename round trip left the renamed provider's literal behind (the merge's semantics): ${modelsDisk}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".settings-dialog-surface"), null, { timeout: 30_000 });
  // The sandbox's own baseline back in place (byte-for-byte, the same
  // fixture this run started from) — no later reader of this sandbox sees
  // the step's mutation.
  writeFileSync(join(agentDir, "models.json"), fixtureModelsJson);
  assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), fixtureModelsJson);

  // ---------------------------------------------------------------- report
  const blocking = pageErrors.filter((message) => !message.includes("Failed to load resource"));
  assert.deepEqual(blocking, [], "no page errors during the run");
  const panics = harnessErrors.filter((text) => text.includes("panicked"));
  assert.deepEqual(panics, [], "no harness panics");
  console.log("[acceptance] ALL STEPS PASSED");
  if (apiAttempts.length) {
    const counts = new Map();
    for (const attempt of apiAttempts) counts.set(attempt, (counts.get(attempt) ?? 0) + 1);
    console.log("[acceptance] /api attempts (unmigrated dependencies — production blockers):");
    for (const [attempt, count] of counts) console.log(`  - ${attempt} ×${count}`);
  }
  if (softIssues.length) {
    console.log("[acceptance] known issues observed (not blockers):");
    for (const issue of softIssues) console.log(`  - ${issue}`);
  }
} catch (error) {
  // A failure must be diagnosable: the page state, the console errors and a
  // screenshot, so the fix does not depend on re-running blind.
  console.error("[acceptance] FAILED:", error && error.message ? error.message : error);
  try {
    console.error("[acceptance] page errors so far:\n" + pageErrors.join("\n"));
    const outline = await page.evaluate(() => ({
      url: location.href,
      bodyClasses: document.body.className,
      hasTextarea: Boolean(document.querySelector("textarea")),
      transcript: document.querySelector(".messages-scroll, [data-message-role=\"assistant\"], .message-user") ? "present" : "absent",
      userBubbles: [...document.querySelectorAll(".message-user")].length,
      assistantBubbles: [...document.querySelectorAll(".message-assistant")].length,
      alerts: [...document.querySelectorAll("[role=alert]")].map((n) => n.textContent?.slice(0, 200)),
      sidebarText: document.querySelector(".session-sidebar, aside")?.textContent?.slice(0, 300) ?? null,
      sendAction: document.querySelector(".composer-send-button")?.getAttribute("data-action") ?? null,
      topbar: document.querySelector(".app-topbar-title")?.textContent ?? null,
      notices: [...document.querySelectorAll(".app-notice-message")].map((n) => n.textContent),
      composerValue: document.querySelector("textarea")?.value ?? null,
      invokeTimeline: (window.__harnessInvokes ?? []).map((entry) => `${entry.cmd}${entry.error ? " ERROR" : entry.done ? "" : " PENDING"}`),
    }));
    console.error("[acceptance] page outline: " + JSON.stringify(outline, null, 2));
    await page.screenshot({ path: join(ROOT, "test-results/static-ui-acceptance-failure.png"), fullPage: false });
    console.error("[acceptance] screenshot: test-results/static-ui-acceptance-failure.png");
  } catch (dumpError) {
    console.error("[acceptance] dump failed:", dumpError);
  }
  if (apiAttempts.length) {
    console.error("[acceptance] /api attempts so far (unmigrated dependencies): " + JSON.stringify([...new Set(apiAttempts)], null, 2));
  }
  process.exitCode = 1;
} finally {
  await teardown("finally");
}

function readdirSafe(dir) {
  try {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...readdirSafe(child));
      else out.push(child);
    }
    return out;
  } catch {
    return [];
  }
}
