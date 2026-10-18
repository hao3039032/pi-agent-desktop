import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("visual output uses artifacts without the retired widget tool extension", async () => {
  const runtime = await read("./rpc-manager.ts");
  assert.match(runtime, /createArtifactGuideExtension\(\)/);
  assert.doesNotMatch(runtime, /createGenerativeUiExtension|preferBuiltinGenerativeUiExtension/);
  const pkg = JSON.parse(await read("../package.json"));
  const lock = JSON.parse(await read("../package-lock.json"));
  assert.equal(pkg.dependencies["@ryan_nookpi/pi-extension-generative-ui"], undefined);
  assert.equal(pkg.allowScripts?.glimpseui, undefined);
  for (const key of Object.keys(lock.packages)) {
    assert.doesNotMatch(key, /(?:pi-extension-generative-ui|glimpseui)$/);
  }
  for (const path of ["./generative-ui.ts", "./widget-tool.ts", "./widget-window.ts", "../app/api/widgets/open/route.ts"]) {
    await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" });
  }
  for (const path of ["../components/ChatWindow.tsx", "../components/MessageView.tsx"]) {
    assert.doesNotMatch(await read(path), /TurnWidgetResults|WidgetToolView|suppressWidgets/);
  }
});
