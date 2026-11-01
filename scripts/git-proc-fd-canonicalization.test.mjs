import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// A controlled interposition only for this fixture: stop Git after it has
// canonicalized --work-tree but immediately before it changes directory.
const interposer = String.raw`
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
int chdir(const char *path) {
    int (*real_chdir)(const char *) = dlsym(RTLD_NEXT, "chdir");
    const char *target = getenv("FIXTURE_TARGET");
    if (target && strcmp(path, target) == 0) {
        const char *ready = getenv("FIXTURE_READY"), *release = getenv("FIXTURE_RELEASE");
        int fd = open(ready, O_CREAT | O_WRONLY | O_TRUNC, 0600);
        if (fd >= 0) close(fd);
        struct timespec pause = {0, 10000000};
        for (int i = 0; i < 1000 && access(release, F_OK) != 0; ++i) nanosleep(&pause, 0);
    }
    return real_chdir(path);
}
`;

for (const linked of [false, true]) test(`Git canonicalizes a held ${linked ? "linked" : "ordinary"} work-tree fd before checkout`, { skip: process.platform !== "linux", timeout: 20000 }, async (t) => {
  if (spawnSync("cc", ["--version"], { stdio: "ignore" }).error) return t.skip("C compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "git-held-fd-"));
  let child, exited;
  try {
    const main = join(dir, "main"), repo = linked ? join(dir, "linked") : main, moved = join(dir, "moved");
    const home = join(dir, "home"), source = join(dir, "interpose.c"), library = join(dir, "interpose.so");
    await mkdir(main); await mkdir(home); await writeFile(source, interposer);
    const compile = spawnSync("cc", ["-shared", "-fPIC", "-o", library, source, "-ldl"], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr);
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
    const gitAt = (cwd, ...args) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    const git = (...args) => gitAt(repo, ...args);
    gitAt(main, "init", "-q"); gitAt(main, "config", "user.name", "Fixture"); gitAt(main, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(main, "file"), "initial\n"); gitAt(main, "add", "file"); gitAt(main, "commit", "-qm", "initial");
    if (linked) gitAt(main, "worktree", "add", "-qb", "linked-fixture", repo);
    git("checkout", "-qb", "target"); await writeFile(join(repo, "file"), "target\n"); git("commit", "-qam", "target");
    git("checkout", "-q", "-");
    const gitdir = await open(git("rev-parse", "--absolute-git-dir").trim(), constants.O_RDONLY | constants.O_DIRECTORY);
    const worktree = await open(repo, constants.O_RDONLY | constants.O_DIRECTORY);
    const common = await open(join(main, ".git"), constants.O_RDONLY | constants.O_DIRECTORY);
    const ready = join(dir, "ready"), release = join(dir, "release");
    try {
      child = spawn("git", ["--git-dir=/proc/self/fd/3", "--work-tree=/proc/self/fd/4", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "checkout", "target"], {
        // Git starts inside the original checkout (the process cwd itself
        // pins that directory), in addition to both explicitly held fds.
        cwd: repo, env: { ...env, GIT_COMMON_DIR: "/proc/self/fd/5", LD_PRELOAD: library, FIXTURE_TARGET: repo, FIXTURE_READY: ready, FIXTURE_RELEASE: release },
        stdio: ["ignore", "pipe", "pipe", gitdir.fd, worktree.fd, common.fd],
      });
      let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => stderr += chunk);
      exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
      let seen = false;
      for (let i = 0; i < 500; i++) { if (await stat(ready).then(() => true, () => false)) { seen = true; break; } await delay(10); }
      assert.ok(seen, "Git did not call chdir with the canonical work-tree path");
      await rename(repo, moved); await mkdir(repo); await writeFile(join(repo, "file"), "initial\n");
      await writeFile(release, "go");
      const result = await exited; child = undefined;
      assert.equal(result.code, 0, `${JSON.stringify(result)} ${stderr}`);
      assert.equal(await readFile(join(repo, "file"), "utf8"), "target\n", "replacement worktree was modified");
      assert.equal(await readFile(join(moved, "file"), "utf8"), "initial\n", "held directory was not modified");
    } finally { await gitdir.close(); await worktree.close(); await common.close(); }
  } finally {
    if (child) { child.kill("SIGKILL"); await exited?.catch(() => {}); }
    await rm(dir, { recursive: true, force: true });
  }
});
