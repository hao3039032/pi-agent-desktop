import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyDeepSeekMigration, migrateAdvisorText, DEEPSEEK_MODEL } = await jiti.import("./deepseek-migration.ts");
const OLD = "lw/gemini-3.8-flash";
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "distro-deepseek-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  };
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  return { dir, write, read };
}

test("advisor changes only the exact old model and preserves comments, quoting, CRLF and opt-in settings", () => {
  for (const quote of ["", "'", '"']) {
    const source = `# old default: ${OLD}\r\nmain: true\r\nsubagents: false\r\nadvisors:\r\n  - name: custom-name\r\n    model: ${quote}${OLD}${quote} # keep\r\n    tools: [read]\r\n    contextTokens: 12345\r\n  - name: other\r\n    model: custom/model\r\n`;
    const next = migrateAdvisorText(source);
    assert.equal(next, source.replace(`model: ${quote}${OLD}`, `model: ${quote}${DEEPSEEK_MODEL}`));
    assert.equal(migrateAdvisorText(next), next);
  }
});

test("custom/absent models stay byte-identical; malformed or unsafe YAML stays unwritten", () => {
  for (const source of ["", "main: false\n", "advisors:\n  - model: lw/custom\n", `advisors:\n  - model: ${OLD}-custom\n`]) {
    assert.equal(migrateAdvisorText(source), source);
  }
  assert.equal(migrateAdvisorText("advisors: ["), null);
  // A model-looking line in a prompt is not a configuration setting.
  assert.equal(migrateAdvisorText(`advisors:\n  - model: ${OLD}\n    prompt: |\n      model: ${OLD}\n`), null);
  // Changing an anchor must not silently change some unrelated configuration.
  assert.equal(migrateAdvisorText(`base: &model ${OLD}\nadvisors:\n  - model: *model\n`), null);
});

test("old global roles migrate, Lite/media/credentials/custom models remain, and rerun is idempotent", (t) => {
  const { dir, write, read } = sandbox(t);
  write("WATCHDOG.yaml", `main: false\nadvisors:\n  - model: ${OLD}\n`);
  write("extensions/pi-auto-review/config.json", { model: "lw/gemini-3.5-flash-lite", failureMode: "deny", custom: 7 });
  const media = { enabled: true, preferredModel: "gemini-3.5-flash-lite" };
  write("web-search.json", { provider: "gemini", searchModel: "gemini-3.8-flash", summaryModel: "gemini-3.5-flash-lite", youtube: media, video: media, geminiApiKey: "test-secret", geminiBaseUrl: "https://custom.example", workflow: "none" });
  write("models.json", { providers: { lw: { apiKey: "test-secret", baseUrl: "https://custom.example", models: [{ id: "gemini-3.8-flash" }, { id: "gemini-3.5-flash-lite" }, { id: "custom" }] }, other: { models: [{ id: "gemini-3.8-flash" }] } } });
  write("settings.json", { defaultProvider: "lw", defaultModel: "gemini-3.8-flash", enabledModels: ["lw/*"], custom: 1 });
  const report = applyDeepSeekMigration(dir);
  assert.equal(report.written.length, 5);
  assert.deepEqual(report.kept, []);
  assert.match(readFileSync(join(dir, "WATCHDOG.yaml"), "utf8"), /lw\/deepseek-v4\.1-flash/);
  assert.deepEqual(read("extensions/pi-auto-review/config.json"), { model: DEEPSEEK_MODEL, failureMode: "deny", custom: 7 });
  assert.deepEqual(read("web-search.json"), { provider: "exa", summaryModel: DEEPSEEK_MODEL, queryRewriteModel: DEEPSEEK_MODEL, youtube: media, video: media, geminiApiKey: "test-secret", geminiBaseUrl: "https://custom.example", workflow: "none" });
  const providers = read("models.json").providers;
  assert.deepEqual(providers.lw.models.map((m) => m.id), ["gemini-3.5-flash-lite", "custom"]);
  assert.equal(providers.lw.apiKey, "test-secret");
  assert.equal(providers.lw.baseUrl, "https://custom.example");
  assert.equal(providers.other.models[0].id, "gemini-3.8-flash");
  assert.deepEqual(read("settings.json"), { defaultProvider: "lw", defaultModel: "deepseek-v4.1-flash", enabledModels: ["lw/*"], custom: 1 });
  assert.deepEqual(applyDeepSeekMigration(dir), { written: [], kept: [] });
});

test("user-selected models, providers and media settings are not replaced", (t) => {
  const { dir, write, read } = sandbox(t);
  write("extensions/pi-auto-review/config.json", { model: "custom/reviewer" });
  const web = { provider: "gemini", searchModel: "custom-search", summaryModel: "current", queryRewriteModel: "custom/rewrite", video: { enabled: false } };
  write("web-search.json", web);
  write("settings.json", { defaultProvider: "other", defaultModel: "gemini-3.8-flash" });
  assert.deepEqual(applyDeepSeekMigration(dir), { written: [], kept: [] });
  assert.deepEqual(read("web-search.json"), web);
  assert.equal(read("extensions/pi-auto-review/config.json").model, "custom/reviewer");
  assert.equal(read("settings.json").defaultModel, "gemini-3.8-flash");
});

test("missing files are not created; invalid files are reported without overwrite; I/O errors throw", (t) => {
  const { dir, write } = sandbox(t);
  assert.deepEqual(applyDeepSeekMigration(dir), { written: [], kept: [] });
  write("web-search.json", "{bad json");
  assert.deepEqual(applyDeepSeekMigration(dir).kept, ["web-search.json: invalid JSON"]);
  assert.equal(readFileSync(join(dir, "web-search.json"), "utf8"), "{bad json");
  mkdirSync(join(dir, "WATCHDOG.yml"));
  assert.throws(() => applyDeepSeekMigration(dir));
});
