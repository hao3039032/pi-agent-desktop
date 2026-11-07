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
  const component = read("components/desktop/LanAccessSection.tsx");
  // The risk confirmation is the shared in-app dialog, never window.confirm
  // (WKWebView does not implement it) nor an OS-native alert.
  assert.match(component, /ChatConfirmDialog/);
  assert.match(component, /appSettings\.lanConfirm/);
  assert.doesNotMatch(component, /window\.confirm/);
  assert.doesNotMatch(component, /confirmLanAccessNative/);
  const bridge = read("lib/desktop-native.ts");
  assert.doesNotMatch(bridge, /confirmLanAccessNative/);
  const host = read("components/desktop/DesktopAppSection.tsx");
  assert.match(host, /if \(!isDesktop\) return null/);
});

test("LAN addresses come from a local-only desktop route, not a guessed port", () => {
  const route = read("app/api/desktop/lan-addresses/route.ts");
  // Same boundary as the other /api/desktop routes: loopback + per-process token.
  assert.match(route, /isDesktopBootstrapRequest\(request\)/);
  assert.match(route, /desktopLanAddressStatus\(request\.headers\.get\("host"\)\)/);
  const lib = read("lib/lan-addresses.ts");
  assert.match(lib, /isListeningBeyondLoopback\(\)/);
  assert.match(lib, /collectLanAddresses/);
  const client = read("lib/desktop-native.ts");
  assert.match(client, /lanAddressesNative[\s\S]*?\/api\/desktop\/lan-addresses[\s\S]*?desktopApiHeaders\(\)/);
});
