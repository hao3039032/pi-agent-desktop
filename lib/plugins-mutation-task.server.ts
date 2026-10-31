import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { managePlugins } from "@/lib/plugins-service.server";
import type { PluginScope } from "@/lib/api-types";

/** This worker must only run in a host-owned, killable management instance. */
export async function runPluginMutationTask(
  input: { cwd: string; action: "install" | "remove" | "update"; source?: string; scope: PluginScope },
  context: { signal: AbortSignal; progress: (value: { phase: string }) => void },
) {
  if (context.signal.aborted) throw new Error("Plugin operation cancelled before it started");
  if (input.scope === "project" && !getProjectTrustStatus(input.cwd, getAgentDir()).trusted) throw new Error("Project resources must be trusted");
  context.progress({ phase: "running" });
  // The SDK does not accept a signal. The host must stop the exclusive process
  // tree on cancellation and retain an unknown outcome, not reuse this worker.
  let result;
  try {
    result = await managePlugins(input);
  } catch (error) {
    throw Object.assign(new Error("Plugin operation outcome unknown"), { code: "outcome_unknown", cause: error });
  }
  if (context.signal.aborted) throw Object.assign(new Error("Plugin operation outcome unknown"), { code: "outcome_unknown" });
  context.progress({ phase: "complete" });
  return result;
}
