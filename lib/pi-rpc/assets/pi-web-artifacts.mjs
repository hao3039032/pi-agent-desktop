/**
 * The pi-web artifacts guide extension, loaded into every `pi --mode rpc`
 * child the CLI engine spawns (`--extension <this file>`), next to the bridge
 * (assets/pi-web-bridge.mjs). The bridge carries only protocol and security
 * bridging; this asset is the one that talks to the model.
 *
 * It is the CLI-engine port of the removed lib/artifact-guide-extension.ts:
 * while Pi Web's artifacts switch (Settings › General › Chat) is on, every
 * run's system prompt gains an `<artifacts>` section telling the model when
 * and how to emit `:::artifact` blocks. The switch lives in Pi Web's own
 * settings file (`<agentDir>/pi-web/settings.json`, shared with the child),
 * is re-read on EVERY run (before_agent_start), and defaults to on when the
 * file is unreadable or missing — the cost of a wrong "on" is one prompt
 * section, a silent "off" would look like the feature broke.
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child, which does not share pi-web's module graph.
 */

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

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/** Pi Web's own settings (~/.pi/agent/pi-web/settings.json), shared with the child. */
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

export default function piWebArtifacts(pi) {
  pi.on("before_agent_start", (event) => {
    if (isArtifactsPromptEnabled()) event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION] = ARTIFACT_GUIDE;
    else delete event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION];
    return undefined;
  });
}
