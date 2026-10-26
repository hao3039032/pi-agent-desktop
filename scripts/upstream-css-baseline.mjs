/**
 * Keeps the upstream stylesheets byte-identical to pi-web.
 *
 * app/globals.css and app/settings.css belong to agegr/pi-web. Every fork style
 * rule lives in app/native-theme.css, which layout.tsx imports after them, so
 * an upstream merge never has to reconcile fork lines inside those two files.
 * The rule used to be documentation only, and ~700 fork lines accumulated in
 * them anyway. scripts/upstream-css-baseline.json records the hash of each
 * file as shipped by the last merged upstream commit; the test beside this
 * script fails as soon as the working copy differs.
 *
 * CLI (run after merging upstream; the sync workflow does it automatically):
 *   node scripts/upstream-css-baseline.mjs update <upstream-git-ref>
 *
 * `update` refuses to record a hash unless each file matches <ref> exactly, so
 * it can only ever move the baseline to a real upstream version.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(rootDir, "scripts", "upstream-css-baseline.json");

export const UPSTREAM_CSS_FILES = ["app/globals.css", "app/settings.css"];

// Hash LF-normalized text so a Windows checkout with autocrlf still matches.
export function hashCss(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

export async function readUpstreamCssBaseline() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function hashWorkingCss(path) {
  return hashCss(await readFile(join(rootDir, path), "utf8"));
}

async function update(ref) {
  const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
  const manifest = await readUpstreamCssBaseline();
  const files = {};
  const drifted = [];

  for (const path of UPSTREAM_CSS_FILES) {
    const upstream = hashCss(git("show", `${ref}:${path}`));
    const working = await hashWorkingCss(path);
    if (upstream !== working) drifted.push(path);
    files[path] = upstream;
  }

  if (drifted.length > 0) {
    console.error(`These files differ from ${ref}:\n  ${drifted.join("\n  ")}`);
    console.error("Move the fork rules into app/native-theme.css (see docs/native-theme.md),");
    console.error(`then restore the upstream copy: git checkout ${ref} -- <file>`);
    process.exitCode = 1;
    return;
  }

  manifest.upstreamRef = git("rev-parse", "--short", `${ref}^{commit}`).trim();
  manifest.files = files;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Upstream CSS baseline set to ${manifest.upstreamRef}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ref] = process.argv.slice(2);
  if (command !== "update" || !ref) {
    console.error("Usage: node scripts/upstream-css-baseline.mjs update <upstream-git-ref>");
    process.exitCode = 2;
  } else {
    await update(ref);
  }
}
