import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Isolated fault fixture for the management protocol; no real services.
export default function fixture(pi) {
  pi.registerCommand("pi-web:mgmt", {
    handler: async (text, ctx) => {
      const [rid, token] = text.trim().split(/\s+/);
      const request = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      const nonce = process.env.PI_WEB_MGMT_NONCE;
      if (request.nonce !== nonce) return rid;
      void (async () => {
        let reply;
        if (request.op === "trust.setFenced") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (request.args.fail) {
            writeFileSync(join(request.args.agentDir, "trust.json"), "{partial");
            reply = request.args.fail === "refusal"
              ? { ok: true, result: { trustWriteAttempted: true, result: { mcpRefusal: { reason: "trust-unreadable", message: "fixture write failed", details: { name: "fixture" } } } } }
              : { ok: false, code: "op_failed", error: "fixture failed after partial write" };
          } else {
            writeFileSync(join(request.args.agentDir, "trust.json"), request.args.mismatch ? "{}\n" : "{\"fixture\":true}\n");
            reply = { ok: true, result: { trustWriteAttempted: true, result: { decision: true, trusted: true } } };
          }
        } else if (request.op === "trust.projectStatus") {
          let decision = false;
          try { decision = JSON.parse(readFileSync(join(request.args.agentDir, "trust.json"), "utf8")).fixture === true; } catch {}
          reply = { ok: true, result: { decision } };
        } else reply = { ok: false, code: "unknown_op", error: "unknown" };
        ctx.ui.notify("PI_WEB_MGMT_V1 " + JSON.stringify({ rid, nonce, ...reply }), "info");
      })();
      return rid;
    },
  });
}
