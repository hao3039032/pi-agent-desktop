import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { projectionEntry, titleEntry } from "./build-management-modules.mjs";

// Exercise esbuild's actual JS string parser, without Windows tools, SDK
// copies, disk output or provider calls. These are encoding tests, not a
// claim that the Windows resource tree has been built successfully.
for (const root of [
  String.raw`D:\a\pi-agent-desktop\new\tab # % '日本語'`,
  String.raw`\\server\share\pi-agent-desktop`,
  '/tmp/pi "quoted" # %/back\\slash\nnewline',
]) {
  test(`generated management/title imports preserve root ${JSON.stringify(root)}`, async () => {
    for (const entry of [projectionEntry(root), titleEntry(root)]) {
      const exports = new Set([...entry.matchAll(/export\s*\{([\s\S]*?)\}\s*from/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
      const resolved = new Set();
      const result = await build({
        stdin: { contents: entry, loader: "ts", resolveDir: process.cwd() },
        bundle: true, format: "esm", platform: "node", write: false,
        plugins: [{
          name: "assert-decoded-import-paths",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.path.startsWith("@earendil-works/")) return { path: args.path, external: true };
              assert.ok(args.path.startsWith(`${root}/lib/`), `corrupted import: ${JSON.stringify(args.path)}`);
              resolved.add(args.path);
              return { path: args.path, namespace: "path-fixture" };
            });
            builder.onLoad({ filter: /.*/, namespace: "path-fixture" }, () => ({
              contents: [...exports].map((name) => `export const ${name} = undefined;`).join("\n"),
              loader: "js",
            }));
          },
        }],
      });
      assert.ok(result.outputFiles[0].text.length > 0);
      if (entry.includes("projectionSessionManager")) {
        assert.ok(resolved.size >= 40, "projection imports must actually pass through the parser");
        assert.ok(resolved.has(`${root}/lib/mcp-oauth-hosted.server.ts`));
        assert.ok(resolved.has(`${root}/lib/mcp-sign-in-service.server.ts`));
      } else {
        assert.deepEqual([...resolved], [`${root}/lib/session-title.ts`]);
      }
    }
  });
}
