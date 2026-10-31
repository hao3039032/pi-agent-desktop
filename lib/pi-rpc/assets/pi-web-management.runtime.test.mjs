import assert from "node:assert/strict";
import test from "node:test";
import management from "./pi-web-management.mjs";

test("management commands enforce nonce and return detached terminal envelopes", async () => {
  const previous = process.env.PI_WEB_MGMT_NONCE;
  process.env.PI_WEB_MGMT_NONCE = "test-nonce";
  try {
    let handler;
    management({ registerCommand(_name, definition) { handler = definition.handler; } });
    const messages = [];
    const ctx = { ui: { notify(message) { messages.push(message); } } };
    const request = (rid, payload) => handler(`${rid} ${Buffer.from(JSON.stringify(payload)).toString("base64url")}`, ctx);
    await request("bad", { op: "sys.capabilities", nonce: "wrong" });
    assert.equal(messages.length, 0);
    await request("good", { op: "sys.capabilities", nonce: "test-nonce" });
    await new Promise((resolve) => setImmediate(resolve));
    const result = JSON.parse(messages[0].slice("PI_WEB_MGMT_V1 ".length));
    assert.equal(result.rid, "good");
    assert.equal(result.nonce, "test-nonce");
    assert.equal(result.ok, true);
    await request("cancel", { op: "__cancel", args: { rid: "missing" }, nonce: "test-nonce" });
    const cancel = JSON.parse(messages[1].slice("PI_WEB_MGMT_V1 ".length));
    assert.equal(cancel.result.requested, false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MGMT_NONCE;
    else process.env.PI_WEB_MGMT_NONCE = previous;
  }
});
