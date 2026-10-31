/**
 * The pure session-view projection (M2 migration seam).
 *
 * Everything here maps an already-read `SessionEntry[]` (plus a branch leaf
 * and the child's tree) onto the shapes the chat UI consumes — the exact
 * code `GET /api/sessions/[id]` runs server-side today. It is deliberately
 * free of `fs`/`node:` imports so THREE runtimes share ONE implementation:
 *
 * - the Next server (`lib/session-reader.ts` re-exports these);
 * - the management instance (this module, bundled into the vendored tree by
 *   scripts/migration/build-management-modules.mjs, backs the
 *   session.readContext / session.projectSnapshot ops);
 * - the static frontend (imported directly when it projects a snapshot).
 *
 * `lib/session-reader.ts` keeps the file-reading half (headers, managers,
 * caches); moving a function here must not change its behavior — the
 * session-reader tests pin both halves.
 */

import type { AgentMessage, ImageContent, SessionContext, SessionEntry } from "./types";
import { normalizeToolCalls } from "./normalize";
import { getThinkingPreview, isSubagentNotificationType } from "./message-display";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";
import { slimToolResultMessage } from "./tool-result-details";
import { projectModelImages } from "./turn-result-images";

export function getLatestModelChange(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return null;
}

/** Model from the newest assistant response metadata — the fallback the
 *  pre-wrapper UI displays when a session has no model_change entries. */
export function getLatestResponseModel(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        return { provider: message.provider, modelId: message.model };
      }
    }
  }
  return null;
}

function getSessionSettings(entries: SessionEntry[], leafId?: string | null): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const branch = sliceActiveBranch(entries, leafId ?? null, entries.length);
  let thinkingLevel: string | undefined;

  for (let i = branch.length - 1; i >= 0 && thinkingLevel === undefined; i--) {
    const entry = branch[i];
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
  }

  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: getLatestModelChange(branch) ?? getLatestResponseModel(branch),
  };
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  /**
   * Let a page run past `tail` to open on a whole turn (its leading user
   * message) instead of cutting a turn in half. Chat-view loads set this so a
   * window that stops mid-turn does not render that turn's leading messages
   * flat. API callers leave it unset: for them `tail` is an exact cap on the
   * ancestor chain (the documented route contract, pinned by e2e).
   */
  wholeTurns?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf, wholeTurns } = options;
  // History pages retain the original branch order, including compacted messages.
  // SDK context filtering can drop a page's messages when firstKeptEntryId is outside it.
  const sliced = leafId === null ? [] : sliceActiveBranch(
    entries, leafId ?? null, tail && tail > 0 ? tail : entries.length, excludeLeaf, wholeTurns,
  );
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);

  // Convert messages and their IDs together to keep fork/navigation targets aligned.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    ...getSessionSettings(entries, leafId),
  };
}

/**
 * Entry that renders as a standalone visible message in the chat window:
 * user / assistant messages plus the compaction divider. toolResult entries,
 * hidden custom messages and session meta render as attachments or nothing,
 * so they must not consume the `tail` budget — counting raw entries starves
 * user messages out of the window in agent-heavy sessions (a 50-entry window
 * over a tool-heavy session can hold a single user message).
 */
function countsTowardTail(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type === "branch_summary") return Boolean((entry as { summary?: string }).summary);
  if (entry.type !== "message") return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === "user" || role === "assistant";
}

/**
 * Raw-entry ceiling for one page, so a span of tool traffic with few visible
 * anchors cannot balloon the payload. Scaled with `tail`; older history still
 * pages in via `before`.
 */
const MIN_RAW_WINDOW_ENTRIES = 200;
const rawWindowCap = (tail: number) => Math.max(MIN_RAW_WINDOW_ENTRIES, tail * 6);

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` visible entries (most-recent first after the final reverse).
 * Iterative: a linear session's chain length equals its entry count, so a
 * recursive walk would overflow the stack. The result is still a valid prefix
 * of the active branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
  wholeTurns = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  let visible = 0;
  const rawCap = rawWindowCap(tail);
  while (current) {
    chain.push(current);
    if (countsTowardTail(current)) visible++;
    if (visible >= tail || chain.length >= rawCap) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // A window that stops mid-turn renders that turn's leading messages flat —
  // ChatWindow can only fold a turn into "Process details" from its anchor —
  // until the older page arrives and they collapse. Walk back to the anchor
  // so the page opens on whole turns; a turn too long to reach is left cut.
  // `wholeTurns` is opt-in: without it `tail` is an exact cap (API contract).
  if (wholeTurns && current && !startsTurn(current)) {
    const extension: SessionEntry[] = [];
    let cursor = current.parentId ? byId.get(current.parentId) : undefined;
    while (cursor && extension.length < MAX_TURN_EXTENSION_ENTRIES) {
      extension.push(cursor);
      if (startsTurn(cursor)) {
        chain.push(...extension);
        break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  chain.reverse();
  return chain;
}

/** Extra raw entries a page may take to reach the start of the turn it cut into. */
const MAX_TURN_EXTENSION_ENTRIES = 1500;

/** Entries that `isMessageGroupAnchor()` treats as the start of a displayed turn. */
function startsTurn(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type === "custom_message") {
    return isSubagentNotificationType((entry as { customType?: string }).customType);
  }
  if (entry.type === "branch_summary") return Boolean((entry as { summary?: string }).summary);
  return entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user";
}
function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function deferToolResultBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const retainedIndices = new Map<number, number>();
  const content = message.content.flatMap((block, blockIndex) => {
    retainedIndices.set(blockIndex, blockIndex - omitted);
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    retainedIndices.delete(blockIndex);
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  const details = isRecord(message.details) ? message.details : undefined;
  const metadata = projectModelImages(details?.modelImages);
  if (metadata) {
    return { ...message, content, details: { ...details, modelImages: {
      version: 1,
      outputs: metadata.outputs.flatMap((output) => {
        const blockIndex = retainedIndices.get(output.blockIndex);
        return blockIndex === undefined ? [] : [{ ...output, blockIndex }];
      }),
    } } };
  }
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      // Tool-result details are projected to the fields the UI renders:
      // extensions can persist megabytes there (see lib/tool-result-details.ts).
      const normalized = slimToolResultMessage(normalizeToolCalls(entry.message));
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalized, options.sessionId, entry.id)
        : normalized;
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: getThinkingPreview(block.thinking), deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      // A divider like compaction, not a user bubble: it was never typed, so it must not
      // offer Edit / Fork or be counted as the user's turn.
      return {
        role: "custom",
        customType: "branch_summary",
        content: entry.summary,
        display: true,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
