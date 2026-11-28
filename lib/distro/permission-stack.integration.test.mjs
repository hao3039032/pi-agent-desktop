/**
 * The seeded permission stack end to end, against the real seed (gitignored;
 * built by `npm run distro:seed`) and the real SDK at the version the distro
 * pins:
 *
 *  1. lib/distro/seed.ts registers the bundled packages and writes the distro's
 *     permission config into a throwaway agent dir (first-start order:
 *     `agentFiles`, then release migration 0.8.704, which leaves the new seed
 *     alone and writes no toggle file);
 *  2. an in-process session over that agent dir loads exactly the three
 *     security packages — the gate, the reviewer and the YOLO toggle — with a
 *     faux model (no network, no paid API) that calls `bash`;
 *  3. with YOLO on (the toggle's default), the `yolo-session` link answers the
 *     bash ask before the reviewer is consulted: the command runs, the review
 *     log names the link, and no prompt is raised;
 *  4. `/yolo` turns it off for the session; the next ask defers to the
 *     reviewer, whose model the faux runtime does not have, so it fails
 *     closed (`failureMode: "deny"`): the command is blocked and the log does
 *     not name the link.
 *
 * The reviewer is never reachable here on purpose: its failure is what shows
 * which link decided.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..", "..");
const resourcesDir = join(rootDir, "src-tauri", "resources");
const seedManifest = join(resourcesDir, "pi-seed", "manifest.json");
const skip = !existsSync(seedManifest) ? "src-tauri/resources/pi-seed not built (run npm run distro:seed)" : false;

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true, moduleCache: false });
const { seedAgentDir } = await jiti.import("./seed.ts");

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-permission-agent-"));
  const home = mkdtempSync(join(tmpdir(), "distro-permission-home-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { agentDir, home };
}

/** One turn's tool results of `entries`, as the chat sees them. */
function toolResults(entries) {
  return entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
    .map((entry) => entry.message)
    .filter((message) => message.toolName === "bash");
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? "").join("");
}

function reviewEvents(agentDir) {
  const path = join(agentDir, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("yolo-session answers the seeded stack's asks first, and /yolo hands them to the fail-closed reviewer", { skip, timeout: 120_000 }, async (t) => {
  const { agentDir, home } = sandbox(t);
  await seedAgentDir(resourcesDir, agentDir);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const seedPath = (...segments) => settings.packages.find((entry) => typeof entry === "string" && entry.includes(join("pi-seed", ...segments)));
  const permissionDir = seedPath("npm", "node_modules", "@gotgenes", "pi-permission-system");
  const reviewerDir = seedPath("npm", "node_modules", "@erichll", "pi-auto-review");
  const toggleDir = seedPath("git", "github.com", "hao3039032", "pi-permission-yolo-toggle");
  assert.ok(permissionDir && reviewerDir && toggleDir, `the seed registers the security stack (${JSON.stringify(settings.packages)})`);
  const permission = JSON.parse(readFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), "utf8"));
  assert.deepEqual(permission.authorizerChain, ["yolo-session", "pi-auto-review"]);
  assert.equal("yoloMode" in permission, false);
  assert.equal(existsSync(join(agentDir, "extensions", "pi-permission-yolo-toggle", "config.json")), false, "a fresh install writes no toggle file");

  const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } =
    await import("@earendil-works/pi-coding-agent");
  const faux = fauxProvider({ models: [{ id: "faux-permission" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.create(home, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [permissionDir, reviewerDir, toggleDir],
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], loaded.errors.map((error) => error.error).join("; "));
  assert.equal(loaded.extensions.length, 3, "gate, reviewer and toggle, nothing else");

  const { session } = await createAgentSession({
    cwd: home,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-permission"),
    sessionManager: SessionManager.inMemory(home),
    settingsManager,
    resourceLoader,
    tools: ["bash"],
  });
  t.after(async () => {
    // The modes emit `session_shutdown` before disposing (RuntimeHost.dispose());
    // AgentSession.dispose() alone does not, and the permission system's
    // forwarding heartbeat would keep the test process alive.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
    session.dispose();
  });
  // The modes dispatch `session_start` after createAgentSession(); so does Pi
  // Web's wrapper. The permission system publishes its service and announces
  // `permissions:ready` there, which is where the chain links register. The
  // UI context records every dialog: neither turn below may reach a prompt.
  const prompts = [];
  const dialog = (method) => async (title, message) => {
    prompts.push({ method, title, ...(message === undefined ? {} : { message }) });
    return method === "confirm" ? { confirmed: false } : { cancelled: true };
  };
  await session.bindExtensions({
    uiContext: {
      select: dialog("select"),
      confirm: dialog("confirm"),
      input: dialog("input"),
      editor: dialog("editor"),
      setStatus: () => {},
      notify: () => {},
    },
  });

  const bashTurn = (command) => [
    () => fauxAssistantMessage([fauxToolCall("bash", { command })]),
    () => fauxAssistantMessage([fauxText("done")]),
  ];

  // 3. YOLO on by default: the link allows the ask, the reviewer is never asked.
  faux.setResponses(bashTurn("echo yolo-ok"));
  await session.prompt("run the first command");
  let results = toolResults(session.sessionManager.getEntries());
  assert.equal(results.length, 1, "the bash call ran");
  assert.equal(results[0].isError, false, JSON.stringify(results[0]));
  assert.match(textOf(results[0].content), /yolo-ok/);
  let decided = reviewEvents(agentDir).filter((event) => event.event === "permission_request.approved");
  assert.equal(decided.length, 1, JSON.stringify(reviewEvents(agentDir).map((event) => event.event)));
  assert.deepEqual(decided[0].decidedBy, { kind: "authorizer", name: "yolo-session", verdict: "allow", reason: null });
  assert.ok(reviewEvents(agentDir).some((event) => event.event === "authorizer_chain_resolved" && event.links?.includes("yolo-session")), "the chain resolved the link");

  // 4. /yolo turns the link off for this session: the ask defers to the reviewer,
  //    which fails closed here, so the command never runs.
  await session.prompt("/yolo");
  faux.setResponses(bashTurn("echo yolo-off"));
  await session.prompt("run the second command");
  results = toolResults(session.sessionManager.getEntries());
  assert.equal(results.length, 2, "the second bash call produced a result entry");
  assert.equal(results[1].isError, true, `blocked, not run: ${JSON.stringify(results[1])}`);
  assert.doesNotMatch(textOf(results[1].content), /yolo-off/);
  const events = reviewEvents(agentDir);
  const second = events.filter((event) => event.event === "permission_request.approved" || event.event === "permission_request.denied");
  assert.equal(second.length, 2, JSON.stringify(events.map((event) => event.event)));
  assert.equal(second[1].event, "permission_request.denied");
  assert.equal(second[1].decidedBy?.name, "pi-auto-review", JSON.stringify(second[1]));
  assert.deepEqual(prompts, [], "no turn reached a human prompt");
});

test("an invalid legacy toggle stays unloaded and fail-closed until a later seed succeeds", { skip, timeout: 120_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const { agentDir, home } = sandbox(t);
  await seedAgentDir(resourcesDir, agentDir);
  const packageDir = (owner, name) => {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return settings.packages.find((entry) => typeof entry === "string" && entry.includes(join("pi-seed", ...owner, name)));
  };
  const permissionDir = packageDir(["npm", "node_modules", "@gotgenes"], "pi-permission-system");
  const reviewerDir = packageDir(["npm", "node_modules", "@erichll"], "pi-auto-review");
  const bundledToggleDir = packageDir(["git", "github.com", "hao3039032"], "pi-permission-yolo-toggle");
  assert.ok(permissionDir && reviewerDir && bundledToggleDir);

  // This is an old dormant chain, not a file created by the next seed run.
  // Reopen the release receipt while leaving the previously managed fork in
  // settings, then give the extension config a BOM that its raw JSON.parse
  // rejects even though the boolean text says false.
  const statePath = join(agentDir, "desktop-distro.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  delete state.releaseMigrations["0.8.704"];
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const permissionPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
  const permissionBefore = readFileSync(permissionPath, "utf8");
  const togglePath = join(agentDir, "extensions", "pi-permission-yolo-toggle", "config.json");
  mkdirSync(dirname(togglePath), { recursive: true });
  writeFileSync(togglePath, "\uFEFF{\"defaultEnabled\":false}");

  await seedAgentDir(resourcesDir, agentDir);

  let settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.includes(bundledToggleDir), false, "the failing migration unregisters only the bundled fork");
  assert.equal(readFileSync(permissionPath, "utf8"), permissionBefore);
  assert.equal(readFileSync(togglePath, "utf8"), "\uFEFF{\"defaultEnabled\":false}");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).releaseMigrations["0.8.704"], undefined);

  const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } =
    await import("@earendil-works/pi-coding-agent");
  const faux = fauxProvider({ models: [{ id: "faux-permission" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.create(home, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [permissionDir, reviewerDir],
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 2, "gate and reviewer load without the rejected toggle");

  const { session } = await createAgentSession({
    cwd: home,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-permission"),
    sessionManager: SessionManager.inMemory(home),
    settingsManager,
    resourceLoader,
    tools: ["bash"],
  });
  let sessionDisposed = false;
  t.after(async () => {
    if (sessionDisposed) return;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
    session.dispose();
  });
  await session.bindExtensions({
    uiContext: {
      select: async () => ({ cancelled: true }),
      confirm: async () => ({ confirmed: false }),
      input: async () => ({ cancelled: true }),
      editor: async () => ({ cancelled: true }),
      setStatus: () => {},
      notify: () => {},
    },
  });
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("bash", { command: "echo must-not-run" })]),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("run the command");
  const results = toolResults(session.sessionManager.getEntries());
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true, JSON.stringify(results[0]));
  assert.doesNotMatch(textOf(results[0].content), /must-not-run/);
  const denied = reviewEvents(agentDir).filter((event) => event.event === "permission_request.denied");
  assert.equal(denied.length, 1, JSON.stringify(reviewEvents(agentDir)));
  assert.equal(denied[0].decidedBy?.name, "pi-auto-review");
  assert.equal(reviewEvents(agentDir).some((event) => event.decidedBy?.name === "yolo-session"), false);

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  sessionDisposed = true;

  writeFileSync(togglePath, "{\"defaultEnabled\":false}\n");
  await seedAgentDir(resourcesDir, agentDir);
  settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.ok(settings.packages.includes(bundledToggleDir), "the successful retry performs the second reconcile");
  assert.equal(readFileSync(permissionPath, "utf8"), permissionBefore);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).releaseMigrations["0.8.704"], true);

  const reloaded = new DefaultResourceLoader({
    cwd: home,
    agentDir,
    settingsManager: SettingsManager.create(home, agentDir),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [permissionDir, reviewerDir, bundledToggleDir],
  });
  await reloaded.reload();
  assert.deepEqual(reloaded.getExtensions().errors, []);
  assert.equal(reloaded.getExtensions().extensions.length, 3);
});
