import { realpathSync } from "fs";
import path from "path";
import { userHome } from "./user-home.ts";
import { browserPasswordPath } from "./browser-password.ts";

/**
 * Credential stores under the home directory that /api/files never reads,
 * lists or writes into, even when a session's cwd is the home directory.
 * Reaching the API already grants a shell to whoever drives the agent, but a
 * network-exposed server behind a password would otherwise hand over private
 * keys and provider tokens with one GET, without a prompt or a transcript.
 * Project files such as `.env` stay viewable: they belong to the workspace.
 * The relay and push stores are secret on the same terms as auth.json: the
 * relay identity holds the Noise and signing private keys (`relayDir()`, which
 * is `<agentDir>/pi-web`), `relay.json` holds the relay's admin token,
 * `relay-devices.json` the paired phones' keys, and `web-push.json` holds the
 * VAPID private key. `models.json` may hold literal provider API keys, which
 * the settings API redacts but a file read would not. The whole `pi-web`
 * directory is refused rather than the three secret files inside it: the other
 * files there (pi-web settings, the artifact index) are not meant to be opened
 * through this API either, and a future key file cannot be forgotten.
 */
const CREDENTIAL_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh/hosts.yml",
  ".password-store",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".npmrc",
  ".pi/agent/auth.json",
  ".pi/agent/models.json",
  ".pi/agent/pi-web",
  ".pi/agent/web-push.json",
] as const;

// Default macOS and Windows volumes are case-insensitive: `~/.SSH/id_rsa` opens the key.
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

function isUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** Whether `target`, or the file a link at `target` points to, is a credential store. */
export function isCredentialPath(target: string, home: string = userHome()): boolean {
  const candidates = [comparable(target)];
  try {
    candidates.push(comparable(realpathSync.native(target)));
  } catch {
    // A missing path is checked lexically only.
  }
  // The browser verifier is a credential even with a custom PI_CODING_AGENT_DIR.
  const passwordPaths = [comparable(browserPasswordPath())];
  try { passwordPaths.push(comparable(realpathSync.native(browserPasswordPath()))); } catch { /* Missing file: lexical check still applies. */ }
  if (candidates.some((candidate) => passwordPaths.some((secret) => isUnder(candidate, secret)))) return true;
  const homes = [comparable(home)];
  try {
    homes.push(comparable(realpathSync.native(home)));
  } catch {
    // Unreadable home: the lexical form still applies.
  }
  return candidates.some((candidate) => homes.some((base) =>
    CREDENTIAL_PATHS.some((entry) => isUnder(candidate, comparable(path.join(base, entry))))));
}
