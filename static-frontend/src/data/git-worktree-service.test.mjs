import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const worktrees = await jiti.import("./worktree-service.ts");
const git = await jiti.import("./git-status-service.ts");

test("Git and worktree services issue named IPC operations without retry", async () => {
  const calls = [];
  const transport = new MockTransport();
  for (const op of ["git.status", "git.diff", "worktrees.list", "worktrees.create", "worktrees.switch", "worktrees.delete", "worktrees.fetch"]) {
    transport.on(op, (args) => { calls.push([op, args]); return op === "git.diff" ? { supported: false } : {}; });
  }
  const client = new IpcClient(transport); worktrees.bindWorktreeService(client); git.bindGitStatusService(client);
  await git.fetchGitStatus("/repo"); await git.fetchGitDiff("/repo", "/repo/file");
  await worktrees.listWorktrees("/repo", true); await worktrees.createWorktree("/repo", "branch");
  await worktrees.switchWorktreeBranch("/repo", "branch"); await worktrees.deleteWorktree("/repo", "/repo-worktrees/branch", false);
  await worktrees.fetchWorktreeBranches("/repo");
  assert.deepEqual(calls.map(([op]) => op), ["git.status", "git.diff", "worktrees.list", "worktrees.create", "worktrees.switch", "worktrees.delete", "worktrees.fetch"]);
  assert.deepEqual(calls[5][1], { cwd: "/repo", path: "/repo-worktrees/branch", force: false });
});
