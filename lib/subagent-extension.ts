/**
 * What remains of the builtin subagent system after M4: the run-info type
 * the message renderer still reads from legacy transcripts, and the
 * pi-subagents package detection the restricted fleet API gates on. The
 * controller, tools and notifications are gone — sessions run on the pi
 * CLI child, where the pi-subagents package spawns its own children.
 */

import type { SubagentRunInfo } from "./subagents";
import { PI_SUBAGENTS_PACKAGE_NAME } from "./subagent-settings";

export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

function isPiSubagentsExtensionFile(path: string, source: string | undefined): boolean {
  if ((source ?? "").replace(/^npm:/, "").split("@")[0] === PI_SUBAGENTS_PACKAGE_NAME) return true;
  // Path segments of either the extension file or its package source: covers the
  // npm install layout (`.../node_modules/pi-subagents/...`) and the absolute
  // pi-seed paths the distro seeder writes as package sources.
  const segments = [path, source ?? ""]
    .flatMap((value) => value.replaceAll("\\", "/").split("/"));
  return segments.some((segment) => segment === PI_SUBAGENTS_PACKAGE_NAME);
}

/**
 * Whether a session's extension load result contains a pi-subagents extension
 * file — the restricted subagents API (`app/api/agent/[id]/subagents`) gates on
 * this, detecting the package by its source or path, never by tool names.
 */
export function loadResultHasPiSubagentsExtension(
  extensions: Iterable<{ path: string; sourceInfo?: { source?: string } }>,
): boolean {
  for (const extension of extensions) {
    if (isPiSubagentsExtensionFile(extension.path, extension.sourceInfo?.source)) return true;
  }
  return false;
}
