import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The LAN address list names this machine's adapters and the port the server
// listens on: local + desktop token only, like the other /api/desktop routes.
const TOKEN = "t".repeat(48);
const originalToken = process.env.PI_DESKTOP_API_TOKEN;
const originalPort = process.env.PORT;
process.env.PI_DESKTOP_API_TOKEN = TOKEN;
// So the port answer is the request's own host, not whatever launched this test.
delete process.env.PORT;
after(() => {
  if (originalToken === undefined) delete process.env.PI_DESKTOP_API_TOKEN;
  else process.env.PI_DESKTOP_API_TOKEN = originalToken;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");

function request(url, { token = TOKEN, host = "127.0.0.1:30141" } = {}) {
  const headers = { host };
  if (token !== null) headers["x-pi-desktop-token"] = token;
  return new Request(`http://127.0.0.1:30141${url}`, { headers });
}

test("refuses anything but the loopback desktop window", async () => {
  for (const [label, options] of [
    ["no token", { token: null }],
    ["a wrong token", { token: "x".repeat(48) }],
    ["a non-loopback host", { host: "192.168.1.20:30141" }],
  ]) {
    const response = await GET(request("/api/desktop/lan-addresses", options));
    assert.equal(response.status, 403, label);
  }
});

test("answers the desktop window with the running server's real state", async () => {
  const original = process.env.PI_WEB_HOSTNAME;
  process.env.PI_WEB_HOSTNAME = "0.0.0.0";
  try {
    const response = await GET(request("/api/desktop/lan-addresses"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.lanListening, true);
    assert.equal(body.port, 30141, "the request's own host supplies the port");
    assert.ok(Array.isArray(body.addresses));
  } finally {
    if (original === undefined) delete process.env.PI_WEB_HOSTNAME;
    else process.env.PI_WEB_HOSTNAME = original;
  }
});
