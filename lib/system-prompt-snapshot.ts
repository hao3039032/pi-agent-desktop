/**
 * Honest system-prompt display for the CLI engine.
 *
 * The RPC protocol has no "what is the composed system prompt" command, and
 * `RpcAgentSession.systemPrompt` cannot answer it: the base prompt is fixed
 * when the pi child spawns, and the CLI plus its extensions (the artifacts
 * guide, exact prompt files, before_agent_start handlers) compose the rest
 * per run. What pi DOES leave behind is a record: every run appends a
 * `system` message entry to the session file describing the section changes
 * of that request, and the SDK's own transcript replay
 * (`getCurrentSystemPrompt` from @earendil-works/pi-ai/utils/transcript) —
 * the same function the CLI uses to collapse those entries into a request's
 * leading prompt — renders the effective prompt they add up to.
 *
 * This module is the pure half: it replays the system messages of the entries
 * it is handed and reports whether any exist. It never composes a prompt from
 * pi-web's own options (that would be a guess, and would drift from what the
 * model saw), and it makes no claim beyond the record: the text is what the
 * transcript records for the inspected chain, not a live reading of what a
 * provider received on the wire (a run in progress can differ until its
 * changes are recorded).
 *
 * Live callers supply entries and leafId from ONE CLI response. Projection
 * uses the SDK's own branch/compaction semantics, including the system-message
 * checkpoint in a compaction entry, never the disk tail as an active pointer.
 */

import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** A replayable system message, the fields the SDK's transcript replay reads. */
type ReplayableSystemMessage = {
  role: "system";
  content: unknown;
  sections?: Record<string, string | null> | null;
  timestamp?: number;
};

/** A session entry as the file view returns it. */
export type SystemPromptEntryLike = {
  type?: string;
  message?: ReplayableSystemMessage;
};

export interface RecordedSystemPrompt {
  /** Whether any system message exists in the inspected entries. */
  recorded: boolean;
  /** The replayed prompt text ("" when no record exists). */
  text: string;
}

/**
 * The recorded system prompt of ONE entry chain, replayed with the SDK's own
 * semantics (later sections replace older ones, a null section deletes).
 * Pass one branch's entries only — mixing entries from sibling chains would
 * splice two histories together.
 */
export function extractActiveSystemPrompt(entries: SessionEntry[], leafId: string | null): RecordedSystemPrompt {
  const projection = buildSessionProjection(entries, leafId);
  return extractRecordedSystemPrompt(projection.messages.map(message => ({
    type: "message",
    message: message as unknown as ReplayableSystemMessage,
  })));
}

export function extractRecordedSystemPrompt(entries: readonly SystemPromptEntryLike[]): RecordedSystemPrompt {
  const messages: ReplayableSystemMessage[] = [];
  for (const entry of entries) {
    const message = entry?.message as ReplayableSystemMessage | undefined;
    if (entry?.type !== "message" || !message || message.role !== "system") continue;
    // The SDK's replay treats a message without a timestamp AND without tool
    // deltas as "no system message at all"; real CLI entries always carry
    // one, but a hand-built fixture (or an older writer) may not.
    messages.push(message.timestamp === undefined ? { ...message, timestamp: 0 } : message);
  }
  if (messages.length === 0) return { recorded: false, text: "" };
  return { recorded: true, text: getCurrentSystemPrompt(messages as Parameters<typeof getCurrentSystemPrompt>[0]) };
}
