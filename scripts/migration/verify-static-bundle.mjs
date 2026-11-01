#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { verifyBundle } from "./static-bundle-manifest.mjs";

if (process.argv.length !== 3) throw new Error("usage: node scripts/migration/verify-static-bundle.mjs <resource-dir>");
const root = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(root, "bundle-manifest.json"), "utf8"));
const files = verifyBundle(root, manifest);
console.log(`Verified ${files.length} resource files; this is not native package or WebView acceptance.`);
