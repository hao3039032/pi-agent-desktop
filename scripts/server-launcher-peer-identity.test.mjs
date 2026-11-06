import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": rootDir } });
const { isLocalRequest } = await jiti.import("../lib/remote-access.ts");
const { isApiRequestHostAllowed } = await jiti.import("../lib/request-security.ts");

// Load the actual launcher in a child, as packaging does. Use real Node
// IncomingMessage objects: headers are lazily derived from rawHeaders, as on
// HTTP requests, rather than an unrelated plain-object header mock.
const fakeServer = `
const { EventEmitter } = require("node:events");
const { IncomingMessage, Server } = require("node:http");
const { Socket } = require("node:net");
const cases = [
  ["first-lan-forgery", "192.168.1.50", "127.0.0.1", ["127.0.0.1"]],
  ["later-lan-duplicates", "192.168.1.50", "127.0.0.1", ["127.0.0.1", "::1, 10.0.0.1"]],
  ["lan-without-forwarded", "192.168.1.50", "192.168.1.2", []],
  ["lan-forwarded-chain", "192.168.1.50", "192.168.1.2", ["127.0.0.1, 10.0.0.1"]],
  ["ipv6-forgery", "2001:db8::50", "127.0.0.1", ["::1"]],
  ["mapped-lan-forgery", "::ffff:192.168.1.50", "127.0.0.1", ["127.0.0.1"]],
  ["loopback-proxy", "127.0.0.1", "127.0.0.1", ["100.80.1.2, 127.0.0.1"]],
  ["other-loopback-proxy", "127.0.0.2", "127.0.0.1", ["100.80.1.2"]],
  ["ipv6-loopback-proxy", "::1", "127.0.0.1", ["100.80.1.2"]],
  ["mapped-loopback-proxy", "::ffff:127.0.0.1", "127.0.0.1", ["100.80.1.2"]],
  ["mapped-hex-loopback-proxy", "::ffff:7f00:1", "127.0.0.1", ["100.80.1.2"]],
  ["local-desktop", "127.0.0.1", "127.0.0.1", []],
];
const results = [];
const server = new Server((request, response) => {
  // Next's actual forwarding default: existing values are preserved.
  request.headers["x-forwarded-for"] ??= request.socket.remoteAddress;
  results.push({ name: request.url.slice(1), address: request.socket.remoteAddress,
    headers: request.headers, raw: request.rawHeaders, distinct: request.headersDistinct });
  response.statusCode = 204;
  response.emit("finish");
});
// This and the first request make the startup-timing wrapper uninstall itself.
server.emit("connection", new Socket());
for (const [name, address, host, forwarded] of cases) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: address });
  const request = new IncomingMessage(socket);
  request.method = "PUT";
  request.url = "/" + name;
  const raw = ["Host", host + ":38471"];
  for (const value of forwarded) raw.push("X-FoRwArDeD-FoR", value);
  request._addHeaderLines(raw, raw.length);
  server.emit("request", request, new EventEmitter());
}
console.log("RESULT " + JSON.stringify(results));
`;

test("packaged launcher pins every non-loopback request to its socket peer, preserving local proxies", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-peer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop/server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), fakeServer);
  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid), PI_WEB_HOSTNAME: "0.0.0.0" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout.match(/RESULT (.+)/)[1]);
  assert.equal(rows.length, 12);
  for (const row of rows) {
    const req = new Request("http://127.0.0.1:38471/api/relay", { headers: row.headers });
    if (row.name.includes("proxy")) {
      assert.match(row.headers["x-forwarded-for"], /^100\.80\.1\.2/);
      assert.equal(isLocalRequest(req), false, row.name);
    } else if (row.name === "local-desktop") {
      assert.equal(isLocalRequest(req), true, row.name);
    } else {
      assert.equal(row.headers["x-forwarded-for"], row.address, row.name);
      assert.deepEqual(row.distinct["x-forwarded-for"], [row.address], row.name);
      const rawValues = row.raw.filter((_, index) => index % 2 === 1 && row.raw[index - 1].toLowerCase() === "x-forwarded-for");
      assert.deepEqual(rawValues, [row.address], row.name);
      assert.equal(isLocalRequest(req), false, row.name);
      if (row.headers.host.startsWith("127.")) {
        assert.equal(isApiRequestHostAllowed(req, [], null), false, row.name);
      }
    }
  }
  const oldHost = process.env.PI_WEB_HOSTNAME;
  try {
    process.env.PI_WEB_HOSTNAME = "0.0.0.0";
    for (const name of ["lan-without-forwarded", "lan-forwarded-chain"]) {
      const row = rows.find((row) => row.name === name);
      assert.equal(isApiRequestHostAllowed(new Request("http://192.168.1.2:38471/api/agent/running", { headers: row.headers }), [], null), true);
    }
  } finally {
    if (oldHost === undefined) delete process.env.PI_WEB_HOSTNAME;
    else process.env.PI_WEB_HOSTNAME = oldHost;
  }
  assert.equal(result.stderr.match(/first request/g).length, 1, "startup timing still uninstalls independently");
});
