import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DISTRO, imageGenBaseUrl, rebaseDistroModelUrls } = await jiti.import("./config.ts");

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

test("the bundled catalog is the distro's package list plus the advisor model", () => {
  assert.deepEqual(DISTRO.packages, [
    "npm:pi-subagents",
    "npm:pi-web-access",
    "git:github.com/hao3039032/pi-model-images",
    "npm:pi-omp-advisor",
    "git:github.com/hao3039032/pi-plan-vanguard",
  ]);
  assert.ok(!DISTRO.packages.includes("npm:pi-mcp-adapter"));
  const gemini = DISTRO.provider.models.find((model) => model.id === "gemini-3.8-flash");
  assert.equal(gemini?.api, "google-generative-ai");
  assert.equal(gemini?.baseUrl, `${DISTRO.defaultBaseUrl}/v1beta`);
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

test("subagent runs default to a 60-minute deadline with a pre-deadline checkpoint", () => {
  // pi-subagents' built-in backstop is 30 minutes; the distro seeds
  // extensions/subagent/config.json (write-when-missing) to raise it and to
  // enable the runner's wrap-up checkpoint 5 minutes before the deadline.
  const config = DISTRO.agentFiles["extensions/subagent/config.json"];
  assert.equal(config.timeoutMs, 3_600_000);
  assert.equal(config.checkpointBeforeDeadlineMs, 300_000);
});
