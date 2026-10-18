import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  findPiSubagentsPackageDir,
  findSecurityExtensionEntries,
} from "./permission-system-package";

/**
 * Make the pi-subagents package load the security extensions into the child
 * sessions it creates.
 *
 * pi-subagents builds children with its own resource loader, and foreground
 * children never load the parent's ambient extensions, so the permission gate
 * a normal session gets from the settings package list does not reach them.
 * The package's host API — `registerRequiredChildExtensions` from
 * `pi-subagents/required-child-extensions` — is the supported way in: paths
 * registered for a parent session load into every native child it launches
 * (foreground, background, nested, recovered) and survive `extensions: []`.
 *
 * The registry lives on `globalThis` under a `Symbol.for` key, so the copy
 * imported here writes the same map the loaded extension reads, whichever
 * install the import resolves. pi-subagents is optional (a user may remove
 * it, and Pi Web's built-in subagents replace it when switched on); every
 * failure is logged and leaves the session running ungated in children, as it
 * was before.
 */

interface RequiredChildExtensionsApi {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: ReadonlyArray<{ id: string; path: string }>;
  }): { dispose(): void };
}

const REGISTRATIONS_KEY = Symbol.for("pi-web.required-child-extensions.registrations");

interface RegistrationStore {
  /** session id → its live registration. */
  live: Map<string, { dispose(): void }>;
  /** session id → the token of the latest register call still allowed to land. */
  pending: Map<string, number>;
  /** Monotonic across every id, so a token is never reused after a delete. */
  nextToken: number;
}

/** On globalThis so hot reload keeps the registrations it must later dispose. */
function store(): RegistrationStore {
  const root = globalThis as Record<symbol, RegistrationStore | undefined>;
  return (root[REGISTRATIONS_KEY] ??= { live: new Map(), pending: new Map(), nextToken: 0 });
}

async function loadApi(packageDir: string): Promise<RequiredChildExtensionsApi | undefined> {
  const entry = join(packageDir, "src", "api", "required-child-extensions.js");
  const api = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(entry).href) as
    Partial<RequiredChildExtensionsApi>;
  return typeof api.registerRequiredChildExtensions === "function"
    ? (api as RequiredChildExtensionsApi)
    : undefined;
}

/**
 * Register the security extensions for `sessionId`'s pi-subagents children.
 * Idempotent per id: a previous registration (a wrapper replaced under the
 * same id, or one left behind by hot reload) is disposed first, since the
 * package allows one registration per parent session. A register or
 * unregister for the same id that lands while the module import is pending
 * wins, so a session destroyed during that await leaves nothing registered.
 */
export async function registerSecurityChildExtensions(
  sessionId: string,
  agentDir = getAgentDir(),
): Promise<void> {
  const registry = store();
  const token = ++registry.nextToken;
  registry.pending.set(sessionId, token);
  try {
    const packages = SettingsManager.create(agentDir, agentDir).getGlobalSettings().packages;
    const extensions = findSecurityExtensionEntries(packages, agentDir);
    const subagentsDir = extensions.length > 0 ? findPiSubagentsPackageDir(packages, agentDir) : undefined;
    if (!subagentsDir) return;
    const api = await loadApi(subagentsDir);
    if (!api || registry.pending.get(sessionId) !== token) return;
    registry.live.get(sessionId)?.dispose();
    registry.live.delete(sessionId);
    registry.live.set(sessionId, api.registerRequiredChildExtensions({ sessionId, extensions }));
  } catch (error) {
    console.warn(
      `[pi-web] could not require security extensions for pi-subagents children of ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    if (registry.pending.get(sessionId) === token) registry.pending.delete(sessionId);
  }
}

/** Drop `sessionId`'s registration; a no-op when it has none. */
export function unregisterSecurityChildExtensions(sessionId: string): void {
  // Dropping the pending token also invalidates a register still awaiting its
  // import, so nothing outlives the session.
  const { live, pending } = store();
  pending.delete(sessionId);
  live.get(sessionId)?.dispose();
  live.delete(sessionId);
}
