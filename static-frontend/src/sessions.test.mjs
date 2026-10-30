/**
 * The sessions view's data path: sessions.list over the typed client with
 * the mock transport (grouping is the host's job; the view consumes the
 * envelope's projects shape and surfaces failures honestly).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { IpcClient, IpcFailure, MockTransport } from "./ipc/client.ts";

test("sessions.list consumes the projects shape", async () => {
  const mock = new MockTransport().on("sessions.list", () => ({
    projects: [
      {
        cwd: "/p/one",
        sessions: [
          { id: "s1", file: "/f1", timestampMs: 1, cwd: "/p/one", sizeBytes: 10 },
          { id: "s2", file: "/f2", timestampMs: 2, cwd: "/p/one", name: "Second", sizeBytes: 20 },
        ],
      },
    ],
    skipped: [],
  }));
  const data = await new IpcClient(mock).request("sessions.list");
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].sessions.length, 2);
  assert.equal(data.projects[0].sessions[1].name, "Second");
});

test("sessions.list failures surface their protocol code", async () => {
  // No handler registered: unknown_op.
  const error = await new IpcClient(new MockTransport())
    .request("sessions.list")
    .catch((error) => error);
  assert.ok(error instanceof IpcFailure);
  assert.equal(error.error.code, "unknown_op");
});

test("empty listings are a valid ready state", async () => {
  const mock = new MockTransport().on("sessions.list", () => ({ projects: [], skipped: [] }));
  const data = await new IpcClient(mock).request("sessions.list");
  assert.deepEqual(data.projects, []);
});
