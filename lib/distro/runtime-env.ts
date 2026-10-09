import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Directory holding the packaged app's bundled resources (`server/`, `node/`,
 * `pi-seed/`, and on Windows `git/`). The packaged server runs with its cwd set
 * to `resources/server`, so the parent is the resources dir. Dev builds have no
 * seed unless `PI_DISTRO_RESOURCES_DIR` points at `src-tauri/resources`.
 */
export function findDistroResourcesDir(): string | null {
  const explicit = process.env.PI_DISTRO_RESOURCES_DIR;
  const candidates = explicit ? [resolve(explicit)] : [resolve(process.cwd(), "..")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "pi-seed", "manifest.json"))) return dir;
  }
  return null;
}

/**
 * The packaged distribution updates as one application through its own
 * updater (Settings → General → Version & Updates, backed by this
 * repository's releases), so upstream's @agegr/pi-web npm version check has
 * no meaning here: between our merges it can only tell the user about an
 * agegr release they cannot install piecemeal. The new-session row's update
 * link is fed by /api/app-update, which honours this flag; dev builds and
 * upstream-style bundles without the seed keep upstream's behaviour. An
 * explicit value set by the operator wins.
 */
export function applyUpstreamWebUpdateSkip(): void {
  if (process.env.PI_WEB_SKIP_VERSION_CHECK === undefined) {
    process.env.PI_WEB_SKIP_VERSION_CHECK = "1";
  }
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function setPathEntries(entries: string[]): void {
  process.env.PATH = entries.join(delimiter);
}

export function isCommandOnPath(name: string, entries = pathEntries()): boolean {
  const names = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => name + ext.toLowerCase())
      .concat((process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => name + ext))
    : [name];
  return entries.some((dir) => names.some((candidate) => existsSync(join(dir, candidate))));
}

export function hasSystemGitBash(): boolean {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
  return roots.some((root) => existsSync(join(root, "Git", "bin", "bash.exe")));
}

/**
 * Make the bundled tools reachable for pi and everything it spawns:
 *
 * - npm: pi installs/updates packages by spawning `npm` from PATH. The Rust
 *   shell only puts the bundled `node` on PATH, so without a system Node.js
 *   every plugin install failed with `spawn npm ENOENT`. Appended, so a
 *   user-installed npm still wins.
 * - Git Bash (Windows): pi's bash tool looks for Git in Program Files first,
 *   then `bash.exe` on PATH. The bundled PortableGit is prepended only when no
 *   system Git for Windows exists, otherwise `System32\bash.exe` (WSL) would
 *   be found first.
 */
export function configureDistroPath(resourcesDir: string): void {
  const entries = pathEntries();

  // npm/npm.cmd shims written by scripts/distro-seed.mjs, wrapping the npm
  // CLI bundled at resources/node/node_modules/npm.
  const npmShims = join(resourcesDir, "pi-seed", "bin");
  const npmCli = join(resourcesDir, "node", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmShims) && existsSync(npmCli) && !isCommandOnPath("npm", entries) && !entries.includes(npmShims)) {
    entries.push(npmShims);
  }

  if (process.platform === "win32") {
    const gitBin = join(resourcesDir, "git", "bin");
    if (existsSync(join(gitBin, "bash.exe")) && !hasSystemGitBash() && !entries.includes(gitBin)) {
      entries.unshift(gitBin);
    }
  }

  setPathEntries(entries);
}

/**
 * PortableGit must run its `post-install.bat` once after extraction (the
 * self-extractor normally does it). The installer ships the extracted tree, so
 * run it on first start of each installed version; the script deletes itself.
 */
export function runPortableGitPostInstall(resourcesDir: string): void {
  if (process.platform !== "win32") return;
  const gitDir = join(resourcesDir, "git");
  if (!existsSync(join(gitDir, "post-install.bat"))) return;
  try {
    const child = spawn(
      join(gitDir, "git-bash.exe"),
      ["--no-needs-console", "--hide", "--no-cd", "--command=post-install.bat"],
      { cwd: gitDir, windowsHide: true, stdio: "ignore", detached: false },
    );
    child.on("error", (error) => console.warn("[distro] PortableGit post-install failed:", error));
    child.unref();
  } catch (error) {
    console.warn("[distro] PortableGit post-install failed:", error);
  }
}
