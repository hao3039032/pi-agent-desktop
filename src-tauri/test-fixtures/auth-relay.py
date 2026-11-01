#!/usr/bin/python3
"""Offline management protocol fixture; auth work deliberately stays unresolved."""
import base64
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if request.get("type") != "prompt":
        continue
    parts = request["message"].split(" ")
    payload = json.loads(base64.urlsafe_b64decode(parts[2] + "=" * ((-len(parts[2])) % 4)))
    print(json.dumps({"type": "response", "id": request["id"], "success": True,
                      "data": {"disposition": "handled"}}), flush=True)
    if payload["op"] == "auth.loginPoll":
        body = {"rid": parts[1], "nonce": payload["nonce"], "ok": True,
                "result": {"events": [], "lastSeq": 0}}
        print(json.dumps({"type": "extension_ui_request", "id": "notify", "method": "notify",
                          "message": "PI_WEB_MGMT_V1 " + json.dumps(body)}), flush=True)
