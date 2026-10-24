/**
 * The pi-web bridge extension, loaded into every `pi --mode rpc` child the
 * CLI engine spawns (`--extension <this file>`).
 *
 * It carries what pi's RPC protocol (1.4.0) has no commands for, plus the
 * host policies pi-web used to inject as in-process extensions:
 *
 *   - `/pi-web:navigate` and `/pi-web:reload`: tree navigation and reload
 *     run through the ExtensionCommandContext only command handlers get.
 *     The factory verifies "pi-web:navigate" answered get_commands after
 *     spawn, so a bridge that failed to load fails the session loudly.
 *   - the read-only MCP policy (lib/mcp-read-only-policy.ts, ported): while
 *     a read-only tool pin is recorded in the session file, MCP tools whose
 *     server does not mark readOnlyHint are blocked. The pin entry is in the
 *     file before the child opens it, so ctx.sessionManager sees it.
 *   - the artifacts prompt section (lib/artifact-guide-extension.ts,
 *     ported): reads Pi Web's own settings file per run, same default-on
 *     semantics.
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child, which does not share pi-web's module graph.
 */

const READ_ONLY_MCP_POLICY_NAME = "pi-web-read-only-mcp";
const WRITE_CAPABLE_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const MCP_EXTENSION_PATH = "builtin:mcp";
const TOOL_SELECTION_TYPE = "pi-web:tool-selection";
// Mirrors lib/session-tool-selection.ts's BUILTIN_TOOL_NAMES (PRESET_FULL
// without powershell: a hand-crafted pin naming powershell must stay invalid
// so an older valid pin below it keeps deciding the read-only policy).
const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
const ARTIFACT_GUIDE_SECTION = "artifacts";

const ARTIFACT_GUIDE = [
  "Replies are shown in Pi Web, which renders an artifact block in a side panel next to the chat. Use an artifact only when the user benefits from viewing or interacting with standalone content: a complete HTML page, app, game, visualization or dashboard; a React component; an SVG image; a Mermaid diagram; or a long self-contained document they will reuse. Do not use one for short snippets, explanations, answers that fit in the message, or changes to project files (edit those with tools).",
  "",
  "Format (the inner code fence is required):",
  ':::artifact{identifier="tip-calculator" type="html" title="Tip calculator"}',
  "```html",
  "<!DOCTYPE html>",
  "...",
  "```",
  ":::",
  "",
  '- type: html, react, svg, mermaid, markdown, or code (for code, put the language on the inner fence).',
  '- react: one JSX/TSX module whose default export is the component, with no required props. Import React hooks from "react" and any npm package by name (loaded from esm.sh, e.g. lucide-react, recharts); no local or "@/..." imports. Style with Tailwind classes.',
  "- To change an artifact, output the whole artifact again with the same identifier; it becomes a new version. Use a new identifier for unrelated content.",
  "- HTML must be one complete file. It runs in a sandboxed frame with no access to this app, the user's files or cookies, and storage that resets on reload. Scripts and styles may load from public CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net) but can be unavailable offline.",
  "- Keep commentary outside the block, usually one or two sentences.",
].join("\n");

/** The newest pinned tool selection in the session entries, pi-web's format. */
function readSessionToolSelection(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const data = entry.data;
    if (!data || data.version !== 1) continue;
    if (data.cleared === true) return undefined;
    if (Array.isArray(data.tools) && data.tools.every((tool) => typeof tool === "string" && BUILTIN_TOOL_NAMES.has(tool))) {
      return [...new Set(data.tools)];
    }
  }
  return undefined;
}

/** A pinned selection that cannot write or run commands. */
function isReadOnlySelection(tools) {
  return tools !== undefined && tools.length > 0 && !tools.some((name) => WRITE_CAPABLE_TOOLS.has(name));
}

function isMcpTool(tool) {
  return (tool.sourceInfo && tool.sourceInfo.path === MCP_EXTENSION_PATH)
    || tool.name.startsWith("mcp__");
}

/** Pi Web's own settings (~/.pi/agent/pi-web/settings.json), shared with the child. */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

function isArtifactsPromptEnabled() {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR
      || path.join(os.homedir(), ".pi", "agent");
    const settingsPath = path.join(agentDir, "pi-web", "settings.json");
    if (!fs.existsSync(settingsPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return true;
    return parsed.artifactsPrompt !== false;
  } catch {
    return true;
  }
}

export default function piWebBridge(pi) {
  // --- session-tree operations (the RPC protocol gap) ----------------------
  pi.registerCommand("pi-web:navigate", {
    description: "pi-web internal: move the session's active leaf",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) throw new Error("pi-web:navigate requires an entry id");
      const entryId = parts[0];
      const summarize = parts.includes("--summarize");
      const instructionsStart = parts.indexOf("--instructions");
      const customInstructions = instructionsStart >= 0
        ? parts.slice(instructionsStart + 1).join(" ") || undefined
        : undefined;
      const result = await ctx.navigateTree(entryId, {
        ...(summarize ? { summarize: true } : {}),
        ...(customInstructions !== undefined ? { customInstructions } : {}),
      });
      if (result.cancelled) throw new Error("pi-web:navigate was cancelled");
      return "navigated";
    },
  });

  pi.registerCommand("pi-web:reload", {
    description: "pi-web internal: reload extensions, skills and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return "reloaded";
    },
  });

  // --- read-only MCP policy (ported from lib/mcp-read-only-policy.ts) ------
  pi.on("tool_call", (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (!tool || !isMcpTool(tool) || (tool.annotations && tool.annotations.readOnlyHint === true)) return undefined;
    // Nested calls (a codemode script's) pass through tool_call as well.
    const selection = readSessionToolSelection(ctx.sessionManager.getEntries());
    if (!isReadOnlySelection(selection)) return undefined;
    return {
      block: true,
      reason: 'This session uses a read-only tool selection, and the MCP server does not mark "'
        + event.toolName + '" as read-only (readOnlyHint), so the call was blocked. '
        + "Switch the session to a preset that allows changes to use it.",
    };
  });

  // --- artifacts prompt section (ported from lib/artifact-guide-extension.ts)
  pi.on("before_agent_start", (event) => {
    if (isArtifactsPromptEnabled()) event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION] = ARTIFACT_GUIDE;
    else delete event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION];
    return undefined;
  });
}
