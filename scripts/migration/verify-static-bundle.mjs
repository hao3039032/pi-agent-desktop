#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { verifyBundle } from "./static-bundle-manifest.mjs";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== "--management-sdk") || args[0].startsWith("--")) throw new Error("usage: node scripts/migration/verify-static-bundle.mjs <resource-dir> [--management-sdk]");
const root = resolve(args[0]);
const manifest = JSON.parse(readFileSync(join(root, "bundle-manifest.json"), "utf8"));
const files = verifyBundle(root, manifest, { requireManagementSdk: args.length === 2 });
console.log(`Verified ${files.length} resource files; this is not native package or WebView acceptance.`);
