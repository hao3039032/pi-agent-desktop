import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * `noExtensions: true` keeps subagent sessions isolated from every settings
 * package — except `additionalExtensionPaths`, which the loader resolves even
 * then (they are the CLI `-e` channel). That is the seam both subagent
 * creation paths use to load the security packages (permission gate + model
 * reviewer) into subagent sessions, so this test pins the loader contract
 * against the installed SDK: drop it and subagent sessions silently lose
 * catastrophic-operation denial and the authorizer chain.
 */

const agentDir = path.join(os.homedir(), ".pi", "agent");
const gateDir = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
const reviewerDir = path.join(agentDir, "npm", "node_modules", "@erichll", "pi-auto-review");
const installed = [gateDir, reviewerDir].filter((dir) => existsSync(path.join(dir, "package.json")));

const SECURITY_PATH_SEGMENTS = ["@gotgenes/pi-permission-system", "@erichll/pi-auto-review"];

function isSecurityExtensionPath(extensionPath) {
  const normalized = extensionPath.replaceAll("\\", "/");
  return SECURITY_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

test("the permission system package is installed where the agent dir layout puts it", { skip: installed.length === 0 ? "security packages not installed on this machine" : false }, () => {
  assert.ok(existsSync(path.join(gateDir, "package.json")));
});

test("noExtensions still loads additionalExtensionPaths, and only those", async () => {
  if (installed.length === 0) return; // dev machines without the packages
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-web-perm-loader-"));
  try {
    // A settings file with other packages installed would load them without
    // noExtensions; with it, only the additional path may appear.
    writeFileSync(path.join(cwd, "settings.json"), "{}");
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: installed,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.equal(errors.length, 0, errors.map((error) => error.error).join("; "));
    assert.equal(extensions.length, installed.length);
    for (const extension of extensions) {
      assert.ok(
        isSecurityExtensionPath(extension.path),
        `unexpected extension: ${extension.path}`,
      );
    }
    // The gate registered its enforcement surface; the reviewer registers
    // handlers of its own (authorizer link, prompt widgets).
    const gate = extensions.find((extension) => extension.path.replaceAll("\\", "/").includes("@gotgenes/pi-permission-system"));
    assert.ok(gate, "permission system extension must load");
    assert.ok(gate.handlers.has("tool_call"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
