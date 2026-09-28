import { configureDistroPath, findDistroResourcesDir, runPortableGitPostInstall } from "./runtime-env";
import { seedAgentDir } from "./seed";
import { applyNpmMirrorEnvFromSettings } from "./npm-mirror";

/**
 * Server-start hook for the distribution overlay (called from
 * instrumentation-node.ts). A no-op in dev builds and in upstream-style
 * bundles without `resources/pi-seed`. Never throws: a seeding problem must
 * not keep the app from starting.
 */
export async function initDistro(): Promise<void> {
  const resourcesDir = findDistroResourcesDir();
  if (!resourcesDir) return;
  try {
    configureDistroPath(resourcesDir);
    runPortableGitPostInstall(resourcesDir);
    await seedAgentDir(resourcesDir);
  } catch (error) {
    console.error("[distro] initialization failed:", error);
  }
  try {
    applyNpmMirrorEnvFromSettings();
  } catch (error) {
    console.warn("[distro] npm mirror could not be applied:", error);
  }
}
