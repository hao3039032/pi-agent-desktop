import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DISTRO, distroProviderBaseUrl, distroServiceBaseUrl, imageGenBaseUrl, mergeDistroModels, rebaseDistroModelUrls } = await jiti.import("./config.ts");
const { LAZY_TOOL_ACTIVATION, LAZY_TOOL_ACTIVATION_FILES } = await jiti.import("./lazy-tool-activation.ts");

test("per-model baseUrls follow the configured service address", () => {
  const models = [
    { id: "plain" },
    { id: "gemini", baseUrl: `${DISTRO.defaultBaseUrl}/v1beta` },
    { id: "elsewhere", baseUrl: "https://other.example.com/v1beta" },
  ];
  const rebased = rebaseDistroModelUrls(models, "https://custom.example.com");
  assert.deepEqual(rebased, [
    { id: "plain" },
    { id: "gemini", baseUrl: "https://custom.example.com/v1beta" },
    { id: "elsewhere", baseUrl: "https://other.example.com/v1beta" },
  ]);
});

test("nothing changes when the service address is the default", () => {
  const models = [{ id: "gemini", baseUrl: `${DISTRO.defaultBaseUrl}/v1beta` }];
  assert.equal(rebaseDistroModelUrls(models, DISTRO.defaultBaseUrl), models);
});

test("trailing slashes on the configured address are normalized", () => {
  const rebased = rebaseDistroModelUrls(
    [{ id: "gemini", baseUrl: `${DISTRO.defaultBaseUrl}/v1beta` }],
    "https://custom.example.com/",
  );
  assert.equal(rebased[0].baseUrl, "https://custom.example.com/v1beta");
});

test("the chat provider's /v1 base and the user-facing service root convert losslessly", () => {
  assert.equal(distroProviderBaseUrl("https://gw.example.com"), "https://gw.example.com/v1");
  assert.equal(distroProviderBaseUrl("https://gw.example.com/"), "https://gw.example.com/v1");
  assert.equal(distroProviderBaseUrl("https://gw.example.com/v1"), "https://gw.example.com/v1");
  assert.equal(distroServiceBaseUrl("https://gw.example.com/v1/"), "https://gw.example.com");
  assert.equal(distroServiceBaseUrl("https://gw.example.com"), "https://gw.example.com");
  assert.equal(distroServiceBaseUrl("https://gw.example.com/v1beta"), "https://gw.example.com/v1beta");
  assert.equal(distroProviderBaseUrl(""), "");
});

test("distro model merges preserve user and previously configured models", () => {
  const builtIn = { id: "built-in", name: "updated" };
  const custom = { id: "my-local-model", name: "My local model", api: "openai-completions", maxTokens: 1234 };
  assert.deepEqual(mergeDistroModels(
    [
      { id: "minimax-m3", name: "previously configured" },
      custom,
      { id: "built-in", name: "old" },
    ],
    [builtIn],
  ), [{ id: "minimax-m3", name: "previously configured" }, custom, builtIn]);

});

test("the bundled catalog keeps its package list and per-model protocol overrides", () => {
  assert.deepEqual(DISTRO.packages, [
    "npm:pi-subagents",
    "npm:pi-web-access",
    "git:github.com/hao3039032/pi-model-images",
    "npm:pi-omp-advisor",
    "npm:@codella/pi-prompt-plan@0.2.2",
    "npm:@gotgenes/pi-permission-system",
    "npm:@erichll/pi-auto-review",
    "git:github.com/hao3039032/pi-permission-yolo-toggle",
  ]);
  // The plan workflow is a pinned prompt-template package now: the version is
  // exact so a rebuild never silently ships a newer template, and the
  // extension-based pi-plan-vanguard is gone from the bundle together with
  // its sandbox runtime. The runtimePackages mechanism itself stays
  // (scripts/distro-seed.mjs, lib/distro/packages.ts) — nothing currently
  // rides on it.
  assert.equal(DISTRO.runtimePackages, undefined);
  assert.ok(!DISTRO.packages.includes("npm:@anthropic-ai/sandbox-runtime"));
  assert.ok(!DISTRO.packages.includes("git:github.com/hao3039032/pi-plan-vanguard"));
  assert.ok(!DISTRO.packages.includes("npm:pi-mcp-adapter"));
  assert.ok(!DISTRO.provider.models.some((model) => model.id === "minimax-m3"));
  assert.ok(!DISTRO.provider.models.some((model) => model.id === "gemini-3.8-flash"));
  // Withdrawn in revision 3; Gemini 4 Neon takes its place. A merge or a copy
  // of the local catalog must not bring it back.
  assert.ok(!DISTRO.provider.models.some((model) => model.id === "gemini-4-argon"));
  const gemini = DISTRO.provider.models.find((model) => model.id === "gemini-3.5-flash-lite");
  assert.equal(gemini?.api, "google-generative-ai");
  assert.equal(gemini?.baseUrl, `${DISTRO.defaultBaseUrl}/v1beta`);
  assert.equal(DISTRO.provider.api, "openai-completions");
  const claude = DISTRO.provider.models.find((model) => model.id === "claude-opus-5-5");
  assert.equal(claude?.api, "anthropic-messages");
  assert.equal(claude?.baseUrl, DISTRO.defaultBaseUrl);
  for (const id of ["gpt-6-astra", "gpt-6.1-terra"]) {
    const model = DISTRO.provider.models.find((entry) => entry.id === id);
    assert.equal(model?.api, "openai-responses");
    assert.equal(model?.baseUrl, `${DISTRO.defaultBaseUrl}/v1`);
  }
});

test("every GLM model inherits OpenAI and carries pi's official zai compatibility", () => {
  for (const id of ["glm-5.3", "glm-5.4", "glm-5.3-flash"]) {
    const model = DISTRO.provider.models.find((entry) => entry.id === id);
    assert.ok(model, `${id} must stay in the distro catalog`);
    assert.equal(model.api, undefined, `${id} inherits the provider default`);
    assert.equal(model.baseUrl, undefined, `${id} inherits the provider /v1 base`);
    assert.deepEqual(model.thinkingLevelMap, {
      off: null, minimal: null, low: "low", medium: null,
      high: "high", xhigh: null, max: "max",
    });
    assert.deepEqual(model.compat, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
      supportsStrictMode: true,
      zaiToolStream: true,
    });
  }
});

// The distro default is glm-5.4 (revision 3; glm-5.3 before it). It is written
// only when a fresh install saves its service config without a default
// provider of its own (lib/distro/service-config.ts), and it must name a
// catalog model, or that first save would select a model the provider cannot
// resolve.
test("the distro default model is a catalog model", () => {
  assert.equal(DISTRO.provider.defaultModel, "glm-5.4");
  assert.ok(DISTRO.provider.models.some((model) => model.id === DISTRO.provider.defaultModel));
});

// Drift guard: Gemini 4 Neon mirrors the local catalog entry (reasoning, text
// and image input, 1M context, 64K output, the Gemini thinking levels) on the
// LW Gemini endpoint. It ships without `cost`, exactly like the local entry it
// was taken from: this repo has no pricing source for it, and a guessed price
// would show up as invented spend in the session stats.
test("Gemini 4 Neon keeps the local catalog's capabilities and uses the LW Gemini endpoint", () => {
  const model = DISTRO.provider.models.find((entry) => entry.id === "gemini-4-neon");
  assert.ok(model, "Gemini 4 Neon must be in the distro catalog");
  assert.equal(model.name, "Gemini 4 Neon");
  assert.equal(model.api, "google-generative-ai");
  assert.equal(model.baseUrl, `${DISTRO.defaultBaseUrl}/v1beta`);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 65536);
  assert.equal(model.cost, undefined);
  assert.deepEqual(model.thinkingLevelMap, {
    off: null, minimal: null, low: "low", medium: "medium",
    high: "high", xhigh: null, max: null,
  });
});

// The prompt-based /plan seeds no config of its own, and the retired plan
// extension's config file and legacy names must not come back either: a
// user's leftover pi-plan-vanguard.json stays on disk untouched (the seeder
// simply never writes it again), so nothing here may re-create it.
test("the retired plan extension leaves no agentFiles or legacy seeds", () => {
  assert.equal("pi-plan-vanguard.json" in DISTRO.agentFiles, false);
  assert.equal(DISTRO.legacyAgentFiles, undefined);
  for (const [name, legacy] of Object.entries(DISTRO.legacyAgentFiles ?? {})) {
    assert.ok(!name.includes("plan"), `${name} is a leftover plan seed`);
    assert.deepEqual(legacy.filter((entry) => entry.includes("plan")), [], `${name} has leftover plan legacy names`);
  }
});

test("the seeded advisor uses DeepSeek without changing its opt-in or read-only defaults", () => {
  const watchdog = DISTRO.agentTextFiles["WATCHDOG.yml"];
  assert.match(watchdog, /^main: false$/m);
  assert.match(watchdog, /^subagents: false$/m);
  assert.match(watchdog, /^    model: lw\/deepseek-v4\.1-flash$/m);
  assert.match(watchdog, /^    tools: \[read, grep, glob\]$/m);
  assert.match(watchdog, /^    contextTokens: 48000$/m);
  assert.doesNotMatch(watchdog, /gemini-3\.8-flash/);
  assert.ok(DISTRO.provider.models.some((model) => model.id === "deepseek-v4.1-flash"));
});

test("DeepSeek text roles use Exa search and retain Gemini media settings", () => {
  const web = DISTRO.webSearch.defaults;
  assert.equal(web.provider, "exa");
  assert.equal(web.searchModel, "gemini-3.8-flash");
  assert.equal(web.summaryModel, "lw/deepseek-v4.1-flash");
  assert.equal(web.queryRewriteModel, "lw/deepseek-v4.1-flash");
  assert.equal(web.youtube.preferredModel, "gemini-3.5-flash-lite");
  assert.equal(web.video.preferredModel, "gemini-3.5-flash-lite");
  assert.equal(web.youtube.enabled, true);
  assert.equal(web.video.enabled, true);
  // Summaries are opt-in: the distro seeds workflow "none" and the already
  // saved web-search.json keeps its own workflow (the file wins over the
  // defaults in applyDistroServiceConfig, see lib/distro/service-config.ts).
  assert.equal(web.workflow, "none");
  assert.equal(DISTRO.webSearch.apiKeyKey, "geminiApiKey");
});

// Exa is the default provider, but its derived connection stays outside
// `webSearch.defaults`: those re-merge on every service-form save and would
// put a deliberately deleted connection back. The pair is written separately
// only when absent or provably distro-owned.
test("the default Exa connection is derived outside the service defaults", () => {
  const exa = DISTRO.webSearch.exaFallback;
  assert.equal(exa.baseUrlKey, "exaBaseUrl");
  assert.equal(exa.apiKeyKey, "exaApiKey");
  assert.equal(exa.baseUrlSuffix, "/exa");
  assert.equal(DISTRO.webSearch.defaults.provider, "exa");
  assert.equal(DISTRO.webSearch.defaults.workflow, "none");
  assert.equal(DISTRO.webSearch.defaults.exaBaseUrl, undefined);
  assert.equal(DISTRO.webSearch.defaults.exaApiKey, undefined);
});

test("the imagegen CLI config follows the service address in OpenAI form", () => {
  // pi-model-images 0.2+ ships the CLI as a skill; its config must exist and
  // point at the same service with the OpenAI suffix.
  assert.equal(DISTRO.imageGen?.configFile, "pi-model-images.json");
  assert.equal(imageGenBaseUrl("https://gw.example.com"), "https://gw.example.com/v1");
  assert.equal(imageGenBaseUrl("https://gw.example.com/"), "https://gw.example.com/v1");
  assert.equal(imageGenBaseUrl("https://gw.example.com/v1"), "https://gw.example.com/v1");
  assert.equal(imageGenBaseUrl("https://gw.example.com/v1/"), "https://gw.example.com/v1");
  assert.equal(imageGenBaseUrl("https://gw.example.com", "/openai/v1"), "https://gw.example.com/openai/v1");
});

test("the seeded permission system config gates every platform's catastrophic shells", () => {
  const cfg = DISTRO.agentFiles["extensions/pi-permission-system/config.json"];
  assert.ok(cfg, "permission system config must be seeded");
  // pi-permission-system 45 no longer reads `yoloMode` (accepted with a warning
  // until removed). YOLO is the bundled toggle's `yolo-session` chain link,
  // first in the chain so it answers before the model reviewer is asked; off
  // for the session, the link defers to the reviewer, then the human.
  assert.equal("yoloMode" in cfg, false, "the retired yoloMode key must not be seeded");
  assert.deepEqual(cfg.authorizerChain, ["yolo-session", "pi-auto-review"]);
  assert.ok(DISTRO.packages.includes("git:github.com/hao3039032/pi-permission-yolo-toggle"), "the YOLO toggle must be bundled");
  // The toggle reads its own config from this path, written when missing only
  // by the 0.8.704 migration (lib/distro/yolo-toggle-migration.ts), never
  // seeded: a fresh install uses the extension's default (on).
  assert.equal("extensions/pi-permission-yolo-toggle/config.json" in DISTRO.agentFiles, false);
  // PowerShell goes through the same bash enforcement stack, so its commands
  // hit the deny rules below instead of an ungated extension surface.
  assert.deepEqual(cfg.shellTools, { powershell: { commandArgument: "command" } });
  // Child sessions have no watcher for their prompts: an unanswered prompt must
  // time out and deny instead of hanging the subagent run forever.
  assert.ok(Number.isInteger(cfg.promptTimeoutMs) && cfg.promptTimeoutMs > 0);
  // The reviewer the chain names must be configured and its model registered
  // in the distro provider, or fresh installs review-fail on every ask.
  const reviewer = DISTRO.agentFiles["extensions/pi-auto-review/config.json"];
  assert.ok(reviewer, "auto-review config must be seeded");
  assert.equal(reviewer.failureMode, "deny");
  const reviewerModel = DISTRO.provider.models.find((model) => model.id === "deepseek-v4.1-flash");
  assert.ok(reviewerModel, "reviewer model must be in the provider list");
  assert.equal(reviewerModel.api, "openai-completions");
  assert.equal(reviewer.model, "lw/deepseek-v4.1-flash");
  const bash = cfg.permission.bash;
  assert.equal(bash["*"], "ask");
  // POSIX roots and homes.
  for (const pattern of ["rm -rf /", "rm -fr /", "rm -r /", "rm * ~", "mkfs*", "dd if=* of=/dev/*"]) {
    assert.equal(bash[pattern], "deny", pattern);
  }
  // Git Bash drive-mount roots (/c, /d, ...) — `?` matches the drive letter;
  // patterns are anchored, so the trailing-slash spelling needs its own rule.
  for (const pattern of ["rm -rf /?", "rm -fr /?", "rm -r /?", "rm -rf /?/", "rm -fr /?/", "rm -r /?/"]) {
    assert.equal(bash[pattern], "deny", pattern);
  }
  // bash-surface matching is case-sensitive while PowerShell is not: each
  // destructive cmdlet is listed in its common spellings.
  for (const cmdlet of ["Remove-Item * ?:\\", "Remove-Item * ?:", "Format-Volume*", "Clear-Disk*", "Remove-Partition*"]) {
    for (const spelled of [cmdlet, cmdlet.toLowerCase(), cmdlet.toUpperCase()]) {
      assert.equal(bash[spelled], "deny", spelled);
    }
  }
  // Windows raw-device dd and drive-root deletion on any drive letter (`?:`).
  for (const pattern of ["dd * of=\\\\.\\*", "rm * ?:\\", "rm * ?:", "format ?:*"]) {
    assert.equal(bash[pattern], "deny", pattern);
  }
  // The catch-all ask must come first: rules are last-match-wins, and these
  // denies have to shadow it, not the other way around.
  assert.equal(Object.keys(bash)[0], "*");
});

test("subagent runs default to a 60-minute deadline with a pre-deadline checkpoint", () => {
  // pi-subagents' built-in backstop is 30 minutes; the distro seeds
  // extensions/subagent/config.json (write-when-missing) to raise it and to
  // enable the runner's wrap-up checkpoint 5 minutes before the deadline.
  const config = DISTRO.agentFiles["extensions/subagent/config.json"];
  assert.equal(config.timeoutMs, 3_600_000);
  assert.equal(config.checkpointBeforeDeadlineMs, 300_000);
});

test("new sessions start with Code mode active", () => {
  // +codemode in the global defaultTools; seeded once, only for users whose
  // settings.json carries no defaultTools of their own (lib/distro/seed.ts).
  assert.deepEqual(DISTRO.settingsDefaults.defaultTools, ["+codemode"]);
});

// The lazy switch is written by the seed exactly once, so it must not be reachable
// through a path that rewrites the file on every start. `applyDistroServiceConfig()`
// re-merges `webSearch.defaults` into web-search.json on every service-form save, so
// a switch kept there would come back after a user deliberately deleted the key to
// fall back to the extension's own `auto`. Keep it in the write-once seeds instead.
test("lazy tool activation lives in the one-shot seeds, not the service defaults", () => {
  assert.equal(DISTRO.webSearch.defaults.toolActivation, undefined);

  // web-search.json is deliberately *not* seeded: pi-web-access resolves
  // <agentDir>/web-search.json first and only then falls back to the legacy
  // ~/.pi/web-search.json, so a bare seeded file would silently move an existing
  // user off their legacy config (losing provider/apiKey). The service form adds
  // the key when it creates the file on the first save instead
  // (lib/distro/service-config.ts).
  assert.equal("web-search.json" in DISTRO.agentFiles, false);
  assert.equal(DISTRO.agentFiles["extensions/subagent/config.json"].toolActivation, LAZY_TOOL_ACTIVATION);
});

// Drift guard: every file the one-shot migration touches must also be seeded for
// new installs, or the two paths disagree about a fresh agent dir.
test("every lazily activated config is also seeded for a fresh agent dir", () => {
  for (const name of LAZY_TOOL_ACTIVATION_FILES) {
    if (name === "web-search.json") {
      // Created by the service form instead, see above: a bare seeded file here
      // would mask the legacy config of an existing user.
      assert.equal("web-search.json" in DISTRO.agentFiles, false);
      continue;
    }
    const config = DISTRO.agentFiles[name];
    assert.ok(config, `${name} must be an agentFiles entry`);
    assert.equal(config.toolActivation, LAZY_TOOL_ACTIVATION, `${name} must be seeded with the lazy switch`);
  }
});

// Drift guard: DeepSeek needs its own thinking compat in addition to the
// provider's OpenAI default. pi-ai only auto-detects those from a `deepseek` provider id
// or a deepseek.com baseUrl, and the service address is neither — dropping
// either field makes the model send reasoning_effort with no thinking block and
// drop reasoning_content from assistant turns, which the API rejects.
test("the DeepSeek model keeps its own API and DeepSeek thinking compat", () => {
  const model = DISTRO.provider.models.find((entry) => entry.id === "deepseek-v4.1-flash");
  assert.ok(model, "the distro must keep the DeepSeek model");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat?.thinkingFormat, "deepseek");
  assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(model.compat?.maxTokensField, "max_tokens");
});

// Drift guard: hy4 keeps its explicit OpenAI endpoint and compatibility — the
// gateway only accepts reasoning_effort values "none" and "high" (declared
// by the litellm deployment), which is why its thinkingLevelMap maps exactly
// those two and nulls the rest. Dropping the compat block or widening the map
// silently sends efforts the upstream rejects or clamps.
test("the hy4 model keeps its API override, OpenAI thinking compat and two-level effort map", () => {
  const model = DISTRO.provider.models.find((entry) => entry.id === "hy4");
  assert.ok(model, "the distro must keep the hy4 model");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat?.thinkingFormat, "openai");
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.maxTokensField, "max_tokens");
  assert.equal(model.compat?.supportsStore, false);
  assert.equal(model.compat?.supportsDeveloperRole, false);
  const supported = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, value]) => value !== null)
    .map(([level]) => level)
    .sort();
  assert.deepEqual(supported, ["high", "off"]);
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(model.thinkingLevelMap?.high, "high");
});

// Drift guard: the gateway (a LiteLLM deployment) identifies a conversation
// by the OpenRouter-style `x-session-id` header, so the distro provider must
// declare the session-affinity compat pair — pi 1.5.2 and 1.6.0 send it on the
// anthropic-messages and openai-completions paths and it is what lets the
// gateway route a whole conversation to one upstream and hit its prompt
// cache. A distro.json edit that drops it silently loses cache affinity for
// every fresh install (existing installs are backfilled by release migration
// 0.8.402; `openrouter` is only the header format name, nothing is re-routed).
test("the distro provider declares the session-affinity compat pair", () => {
  assert.equal(DISTRO.provider.compat?.sendSessionAffinityHeaders, true);
  assert.equal(DISTRO.provider.compat?.sessionAffinityFormat, "openrouter");
});
