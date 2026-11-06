import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("desktop LAN access is opt-in and marks the server network-exposed", () => {
  const prefs = read("src-tauri/src/native_prefs.rs");
  const server = read("src-tauri/src/lib.rs");
  assert.match(prefs, /get\("lanAccess"\).*unwrap_or\(false\)/s);
  assert.match(server, /if lan_access \{ "0\.0\.0\.0" \} else \{ "127\.0\.0\.1" \}/);
  assert.match(server, /\.env\("HOSTNAME", hostname\)/);
  assert.match(server, /\.env\("PI_WEB_HOSTNAME", hostname\)/);
  assert.match(server, /TcpListener::bind\(\(bind_ip, port\)\)/);
});

test("setting is exposed only to the desktop window and warns before enabling", () => {
  const capability = JSON.parse(read("src-tauri/capabilities/desktop-dialog.json"));
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.remote.urls, ["http://127.0.0.1:*/*"]);
  assert.ok(capability.permissions.includes("allow-lan-access-settings"));
  const component = read("components/desktop/DesktopAppSection.tsx");
  assert.ok(capability.permissions.includes("dialog:allow-confirm"));
  assert.match(component, /if \(next && !await confirmLanAccessNative\(/);
  assert.doesNotMatch(component, /window\.confirm/);
  const bridge = read("lib/desktop-native.ts");
  assert.match(bridge, /confirmLanAccessNative[\s\S]*?if \(!isTauriDesktop\(\)\) throw[\s\S]*?import\("@tauri-apps\/plugin-dialog"\)[\s\S]*?return confirm\(message, \{ title, kind: "warning" \}\)/);
  assert.match(component, /if \(!isDesktop\) return null/);
});
