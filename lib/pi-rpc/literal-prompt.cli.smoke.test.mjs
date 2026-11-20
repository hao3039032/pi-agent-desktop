/**
 * Real-CLI admission for literal attached-file submissions (the v0.8.7 merge's
 * expandPromptTemplates: false port). The stock RPC `prompt` command has no
 * expandPromptTemplates field, so RpcAgentSession.prompt guards a literal
 * submission that starts with "/" with ONE leading newline: the child's
 * extension-command dispatch, _expandSkillCommand and expandPromptTemplate all
 * gate on a raw leading "/", so the submission stays literal while admission,
 * errors and settle remain the SDK's real preflight contract.
 *
 * These drive the production startRpcSession -> CLI factory -> real wrapper over
 * a real `pi --mode rpc` child (PI_CLI_BIN), with a faux provider so no model
 * network is touched. They pin what a mock cannot: a rejected prompt rejects the
 * caller (no false acceptance / hang), a plain command still dispatches, a
 * literal "/command" does NOT dispatch, an input hook still runs (transform and
 * handled), and the persisted user record round-trips losslessly through
 * splitAttachedFiles despite the transport newline.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { startRpcSession } = await jiti.import("../rpc-manager.ts");
const { splitAttachedFiles, composeMessageWithAttachedFiles } = await jiti.import("../chat-attachments.ts");
const executable = resolvePiCliBin();
const skip = executable ? false : "PI_CLI_BIN not set";

/** The child flushes the session file a beat after agent_settled; poll for it. */
async function waitFor(predicate, what, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const attached = (text, body = "/command is literal file content") =>
  composeMessageWithAttachedFiles(text, [{ name: "Pasted text.txt", text: body }]);

function userEntries(file, sessionDir) {
  return SessionManager.open(file, sessionDir).getEntries()
    .filter((entry) => entry.type === "message" && entry.message?.role === "user");
}

test("real CLI: a literal prompt's preflight rejection reaches the caller; plain commands still dispatch", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-literal-nomodel-"));
  const agentDir = join(root, "agent"), cwd = join(root, "work"), sessionDir = join(root, "sessions");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd); await mkdir(sessionDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let wrapper;
  try {
    // No settings.json / auth.json: the child has no model. Admission must fail
    // loudly, not false-accept and hang waiting for a run that never starts.
    const started = await startRpcSession(`__new__${randomUUID()}`, "", cwd);
    wrapper = started.session;
    const state = await wrapper.send({ type: "get_state" });
    assert.equal(state.model?.provider, "unknown", "the child really has no usable model");

    // A plain extension command (no attachments) still dispatches: the bridge's
    // /pi-web:reload is handled without a model.
    await wrapper.send({ type: "prompt", message: "/pi-web:reload" });

    // The SAME command text with an attached file is literal model input: it must
    // not dispatch, and with no model it must reject (the old fire-and-forget
    // bridge corridor answered ok here and hung).
    await assert.rejects(
      wrapper.send({ type: "prompt", message: attached("/pi-web:reload") }),
      /model/i,
    );
    // A non-slash literal submission also gets real admission.
    await assert.rejects(
      wrapper.send({ type: "prompt", message: attached("explain this") }),
      /model/i,
    );
    assert.equal(userEntries(state.sessionFile, sessionDir).length, 0, "a rejected prompt persists no user turn");
  } finally {
    if (wrapper?.isAlive()) await wrapper.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanupDir(root);
  }
});

test("real CLI: literal guard, input hooks and lossless record over a faux run", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-literal-faux-"));
  const agentDir = join(root, "agent"), cwd = join(root, "work"), sessionDir = join(root, "sessions");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd); await mkdir(sessionDir);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const fauxPath = `${process.cwd().replaceAll("\\", "/")}/node_modules/@earendil-works/pi-ai/dist/providers/faux.js`;
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
  // A command that records its dispatch, an input hook that transforms text
  // carrying HOOK-ME and swallows text carrying SWALLOW-ME.
  await writeFile(join(agentDir, "extensions", "literal-fixture.js"), `import { fauxAssistantMessage, fauxProvider } from "${fauxPath}";
export default async function (pi) {
  const faux = fauxProvider({ provider: "faux" });
  faux.setResponses([fauxAssistantMessage("LITERAL-OK"), fauxAssistantMessage("PLAIN-OK"), fauxAssistantMessage("HOOK-OK")]);
  pi.registerProvider(faux.provider);
  pi.registerCommand("literaltrap", { description: "records dispatch", handler: async () => { pi.appendEntry("trap-fired", {}); } });
  pi.on("input", (event) => {
    if (event.text.includes("SWALLOW-ME")) return { action: "handled" };
    if (event.text.includes("HOOK-ME")) return { action: "transform", text: event.text + " [hooked]" };
    return undefined;
  });
}
`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let wrapper;
  try {
    const started = await startRpcSession(`__new__${randomUUID()}`, "", cwd);
    wrapper = started.session;
    const state = await wrapper.send({ type: "get_state" });
    const file = state.sessionFile;

    // A plain "/literaltrap" (no attachment) dispatches the command: handled, no
    // run, and the trap entry lands.
    await wrapper.send({ type: "prompt", message: "/literaltrap" });
    const trapCount = () => SessionManager.open(file, sessionDir).getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "trap-fired").length;
    await waitFor(() => trapCount() === 1, "the plain command's trap entry");
    assert.equal(userEntries(file, sessionDir).length, 0, "a handled command starts no user turn");

    // The SAME "/literaltrap" with an attached file is literal: the command must
    // NOT fire; a normal faux run starts instead and settles.
    const literalText = attached("/literaltrap", "body HOOK-ME");
    await wrapper.send({ type: "prompt", message: literalText });
    await waitFor(() => userEntries(file, sessionDir).length === 1, "the literal run's user turn");
    assert.equal(trapCount(), 1, "the literal submission did not dispatch the command a second time");
    const users = userEntries(file, sessionDir);
    const persisted = users[0].message.content;
    const persistedText = typeof persisted === "string" ? persisted : persisted.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    assert.ok(persistedText.startsWith("\n/literaltrap"), "the transport newline is present in the record");
    assert.ok(persistedText.includes("[hooked]"), "the input hook still ran on a literal submission");
    // Display/restore round-trip is lossless: the attachment comes back exactly,
    // and the transport newline is trimmed away from the typed text.
    const split = splitAttachedFiles(persistedText);
    assert.ok(split.text.startsWith("/literaltrap"), "the typed text survives");
    assert.ok(!split.text.startsWith("\n"), "the transport newline is trimmed for display");
    assert.equal(split.files.length, 1);
    assert.equal(split.files[0].name, "Pasted text.txt");
    assert.equal(split.files[0].text, "body HOOK-ME");
    assert.ok(SessionManager.open(file, sessionDir).getEntries().some((entry) => entry.type === "message" && entry.message?.role === "assistant"), "a real run answered");

    // An input hook that swallows the submission is a real "handled": it resolves
    // without a run and without a user turn (the old corridor guessed "started"
    // and would hang here).
    const before = userEntries(file, sessionDir).length;
    await wrapper.send({ type: "prompt", message: attached("SWALLOW-ME") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(userEntries(file, sessionDir).length, before, "a handled literal submission persists no user turn");
  } finally {
    if (wrapper?.isAlive()) await wrapper.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanupDir(root);
  }
});
