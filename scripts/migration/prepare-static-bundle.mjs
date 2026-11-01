#!/usr/bin/env node
// Development-only static resource staging. It does not replace desktop:prepare
// or select a production lifecycle. Supply a verified, pinned release tree.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stagePiDistribution } from "../pi-cli-distribution.mjs";
import { stageManagedTree } from "./stage-managed-tree.mjs";
import { bundleFiles, verifyBundle } from "./static-bundle-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} is required`); return resolve(args[i + 1]); }
const out = arg("--out");
const piDir = arg("--pi-dir");
const node = arg("--node");
const npm = arg("--npm-dir");
const frontend = arg("--frontend");
if (existsSync(out)) throw new Error("output must not already exist");
if (!existsSync(join(frontend, "index.html")) || !existsSync(join(npm, "bin", "npm-cli.js"))) throw new Error("missing frontend or npm runtime");
const expected = JSON.parse(readFileSync(join(root, "scripts/release-component-pins.json"), "utf8")).pi.version;
const binary = join(piDir, process.platform === "win32" ? "pi.exe" : "pi");
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000, env: { PATH: "", HOME: out, USERPROFILE: out } });
if (version.status !== 0 || version.stdout.trim() !== expected) throw new Error(`pi version does not match pinned ${expected}: ${version.stdout} ${version.stderr}`);
mkdirSync(out, { recursive: false });
stagePiDistribution({ sourceDir: piDir, destDir: join(out, "pi") });
mkdirSync(join(out, "node"));
const nodeDest = join(out, "node", process.platform === "win32" ? "node.exe" : "node");
cpSync(node, nodeDest);
if (process.platform !== "win32") chmodSync(nodeDest, 0o755);
cpSync(npm, join(out, "node/node_modules/npm"), { recursive: true, dereference: false });
cpSync(frontend, join(out, "frontend"), { recursive: true, dereference: false });
cpSync(join(root, "lib/pi-rpc/assets"), join(out, "server/lib/pi-rpc/assets"), { recursive: true, dereference: false });
await stageManagedTree(join(out, "managed"));
// npm's installation-time .bin link is not a module dependency. In this
// checkout cpSync preserves it as an absolute link into the build machine.
const yamlBin = join(out, "managed/@earendil-works/pi-coding-agent/node_modules/.bin/yaml");
if (existsSync(yamlBin) && lstatSync(yamlBin).isSymbolicLink()) unlinkSync(yamlBin);
const files = bundleFiles(out);
const manifest = { version: 1, piVersion: expected, files };
writeFileSync(join(out, "bundle-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
verifyBundle(out, manifest);
console.log(`Staged ${files.length} files, ${files.reduce((n, f) => n + f.size, 0)} bytes in ${out}; not a native package or platform acceptance.`);
