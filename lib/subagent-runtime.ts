/**
 * What remains of the builtin subagent runtime after the CLI-engine migration
 * (M4): sessions run on a `pi --mode rpc` child, where the pi-subagents package
 * spawns and tracks its own children, so this host process has no subagent run
 * map. Upstream pi-web's lease, running and Debug-panel code asks this module
 * whether a session still has subagents at work; here the answer is always no
 * (the package reports completion through the displayed `subagent-notify`
 * message that anchors the parent's next turn — see lib/message-display.ts).
 *
 * The historical controller, its tools and notifications are gone with the
 * in-process engine; legacy subagent-child session files keep only their
 * markers, read by lib/subagents.ts for the session routes.
 */

import type { DebugParentNotification, DebugSubagentRun } from "./debug-types";

/** No host-side run map exists: nothing is ever "still at work" here. */
export function hasUnsettledSubagentRun(_sessionId: string): boolean {
  return false;
}

/** The running snapshot's badge source: no session ever qualifies. */
export function getSessionIdsWithUnsettledSubagentRuns(): string[] {
  return [];
}

/** The Debug panel's subagent section reads empty. */
export function subagentDebugSnapshot(_sessionId?: string): { runs: DebugSubagentRun[]; notifications: DebugParentNotification[] } {
  return { runs: [], notifications: [] };
}
