import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  GENERATIVE_UI_EXTENSION_NAME,
  createGenerativeUiExtension,
  generativeUiPackageDir,
  preferBuiltinGenerativeUiExtension,
} = await jiti.import("./generative-ui.ts");

const INLINE_PATH = `<inline:${GENERATIVE_UI_EXTENSION_NAME}>`;

// The loader's jiti instance and the extension cache are shared process-wide;
// keep this test out of the hot reload paths by using a throwaway cwd/agentDir.
const cwd = await mkdtemp(join(tmpdir(), "pi-web-gen-ui-cwd-"));
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-gen-ui-agent-"));
test.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(agentDir, { recursive: true, force: true })]));

test("a package copy present alongside the builtin factory is dropped, inline wins", async () => {
  const packageDir = generativeUiPackageDir();
  assert.ok(packageDir, "the dependency must be installed for this test to mean anything");
  // Load the package as an additional path — the same shape a user-level copy
  // of the package takes (the loader treats both as file extensions).
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    eventBus: new EventEmitter(),
    additionalExtensionPaths: [packageDir],
    extensionFactories: [createGenerativeUiExtension()],
    extensionsOverride: (base) => preferBuiltinGenerativeUiExtension(base),
  });
  await loader.reload();
  const result = loader.getExtensions();

  // The package copy's conflict error and the copy itself are gone.
  assert.deepEqual(result.errors, []);
  const generative = result.extensions.filter((extension) =>
    extension.path === INLINE_PATH || extension.path.includes("pi-extension-generative-ui"));
  assert.equal(generative.length, 1, "only the builtin generative-ui extension survives");
  assert.equal(generative[0].path, INLINE_PATH);
  assert.deepEqual([...generative[0].tools.keys()].sort(), ["show_widget", "visualize_read_me"]);
  assert.deepEqual([...generative[0].commands.keys()], [], "the /widgets gallery command does not load");
});
