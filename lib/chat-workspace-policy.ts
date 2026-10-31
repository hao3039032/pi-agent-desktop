import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isMcpTool } from "./mcp-read-only-policy";
import { isSensitivePath, type ChatFileGrants } from "./chat-file-access";
import { SAVE_TO_DOWNLOADS_TOOL_NAME } from "./chat-downloads-tool";
import { userHome } from "./user-home";
// The exact chat preamble lives in its own dependency-free module
// (lib/chat-workspace-prompt.ts) so the management instance bundles the ONE
// implementation; re-exported here so every existing import keeps working.
export {
  chatWorkspacePrompt,
  CHAT_WORKSPACE_PROMPT,
  type ChatPromptScope,
} from "./chat-workspace-prompt";

/**
 * What a chat (the non-project workspace) may and may not do.
 *
 * A chat loads the same extensions, skills, prompt templates and MCP servers as a
 * project session, so a skill or an MCP tool works there. What it never gets of its own is
 * a shell or the user's filesystem:
 *
 * - A chat made after chats got folders (`folder`) owns a folder; `read`, `write`, `edit`,
 *   `grep`, `find` and `ls` work inside that folder and nowhere else. `read` also opens
 *   skill files and files the user named by full path in their own message (never to
 *   write). MCP tools run only when their server marks them read-only.
 * - A legacy chat (the old shared cwd, no folder) keeps its original policy: `read` for
 *   skills and named files, `save_to_downloads` as its one write, no other coding tool.
 * - `bash` and `powershell` are blocked in both, unless the user unlocked the chat
 *   (`unrestricted`): then this extension only adds the chat prompt and leaves the tools alone.
 */

export const CHAT_WORKSPACE_EXTENSION_NAME = "pi-web-chat-workspace";

/** Coding tools that reach a shell; a chat never runs them unless the user unlocked it. */
export const CHAT_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** Coding tools a legacy chat (no folder) never runs, whoever asks. */
export const CHAT_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** The only coding tool a legacy chat keeps active; see `chatReadBlockReason`. */
export const CHAT_READ_TOOL_NAME = "read";

/** The file tools a chat with a folder keeps, all confined to that folder (read also to named files and skills). */
export const CHAT_FOLDER_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "grep", "find", "ls"];

/** Coding tools a chat never runs, whoever asks (the model, tool_search, a codemode script). */
export function chatBlockedToolNames(hasFolder: boolean): ReadonlySet<string> {
  return hasFolder ? CHAT_SHELL_TOOL_NAMES : CHAT_BLOCKED_TOOL_NAMES;
}

/**
 * The tools a legacy chat may use by default: `read` (confined, see above), the two that
 * reach other tools, every read-only MCP tool, `save_to_downloads`, and the well-known
 * read-only web tools (search and fetch). Any other extension tool stays off, because an
 * installed extension can carry file readers, computer control or sub-agents (which run
 * with their own tools); the user adds those by name in Settings › Chats.
 */
export const CHAT_DEFAULT_TOOL_NAMES: readonly string[] = [
  CHAT_READ_TOOL_NAME,
  "codemode",
  "tool_search",
  SAVE_TO_DOWNLOADS_TOOL_NAME,
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
];
/** The default loadout of a chat with a folder: the file tools replace `save_to_downloads`. */
export const CHAT_FOLDER_DEFAULT_TOOL_NAMES: readonly string[] = [
  ...CHAT_FOLDER_TOOL_NAMES,
  ...CHAT_DEFAULT_TOOL_NAMES.filter((name) => name !== CHAT_READ_TOOL_NAME && name !== SAVE_TO_DOWNLOADS_TOOL_NAME),
];
const CHAT_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(CHAT_DEFAULT_TOOL_NAMES);
const CHAT_FOLDER_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(CHAT_FOLDER_DEFAULT_TOOL_NAMES);

/**
 * `extraAllowed` is the user's own list (Settings › Chats). It can add an extension tool
 * but never one of the blocked coding tools, which stay off whoever asks.
 */
export function isChatToolAllowed(
  tool: { name: string; sourceInfo?: unknown },
  extraAllowed: ReadonlySet<string> = NO_EXTRA_TOOLS,
  hasFolder = false,
): boolean {
  if (chatBlockedToolNames(hasFolder).has(tool.name)) return false;
  return (hasFolder ? CHAT_FOLDER_ALLOWED_TOOL_NAMES : CHAT_ALLOWED_TOOL_NAMES).has(tool.name)
    || extraAllowed.has(tool.name)
    || isMcpTool({ name: tool.name, sourceInfo: tool.sourceInfo as never });
}

const NO_EXTRA_TOOLS: ReadonlySet<string> = new Set();

export function chatUnavailableToolReason(toolName: string): string {
  return `"${toolName}" is not available in a chat. Chats can use skills and MCP tools; open a project to use other tools.`;
}

export function chatBlockedToolReason(toolName: string, hasFolder = false): string {
  if (hasFolder) {
    return `"${toolName}" is not available in a chat: a chat has no shell. The user can let this chat use their computer from the chat's menu, or open a project to use it.`;
  }
  return `"${toolName}" is not available in a chat. Chats have no access to the user's files or shell; open a project to use it.`;
}

/**
 * Roots a chat's `read` may open: the directory of every skill that ships as a
 * `SKILL.md` folder (its scripts and references live beside it) and the exact file of a
 * single-file skill.
 */
export function skillReadRoots(
  skills: readonly { filePath: string; baseDir?: string }[],
): { directories: string[]; files: string[] } {
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const skill of skills) {
    const real = safeRealpath(skill.filePath);
    if (!real) continue;
    if (basename(skill.filePath).toLowerCase() === "skill.md") {
      directories.add(dirname(real));
    } else {
      files.add(real);
    }
  }
  return { directories: [...directories], files: [...files] };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function expandPath(rawPath: string, cwd: string): string {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = userHome();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(userHome(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/**
 * The real path of `rawPath` as far as the filesystem can say: the deepest ancestor that
 * exists is resolved through symlinks, and what does not exist yet is appended unchanged.
 * A `write` to a new file is judged by where it would land, and a symlink inside the folder
 * that points out of it is seen for what it is.
 */
function resolveThroughSymlinks(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const real = safeRealpath(current) ?? current;
  return missing.length ? join(real, ...missing) : real;
}

/** Whether `rawPath` (relative paths start in `folder`) stays inside the chat's folder. */
export function isInsideChatFolder(rawPath: unknown, folder: string): boolean {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) return false;
  const realFolder = safeRealpath(folder) ?? folder;
  return isInside(realFolder, resolveThroughSymlinks(expandPath(rawPath, folder)));
}

const FOLDER_ONLY_REFUSAL = (toolName: string): string =>
  `"${toolName}" only works inside this chat's own folder. Give a path in the folder (relative paths start there), or let this chat use the computer from the chat's menu, or open a project.`;

/**
 * Why a chat with a folder may not run this file tool with these arguments, or null. `write`,
 * `edit`, `ls`, `find` and `grep` stay inside the folder; `read` additionally opens skill
 * files and files the user named (see `chatReadBlockReason`).
 */
export function chatFolderToolBlockReason(
  toolName: string,
  input: unknown,
  folder: string,
  skills: readonly { filePath: string; baseDir?: string }[],
  grants?: ChatFileGrants,
): string | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (toolName === "read") {
    if (isInsideChatFolder(args.path, folder)) return null;
    return chatReadBlockReason(args.path, folder, skills, grants, true);
  }
  if (toolName === "write" || toolName === "edit") {
    return isInsideChatFolder(args.path, folder) ? null : FOLDER_ONLY_REFUSAL(toolName);
  }
  if (toolName === "ls" || toolName === "find" || toolName === "grep") {
    if (args.path !== undefined && !isInsideChatFolder(args.path, folder)) return FOLDER_ONLY_REFUSAL(toolName);
    // A glob that starts at the root or climbs out would look beyond the searched folder.
    const globs = [toolName === "find" ? args.pattern : undefined, toolName === "grep" ? args.glob : undefined];
    for (const glob of globs) {
      if (typeof glob !== "string") continue;
      if (isAbsolute(glob) || /^[A-Za-z]:[\\/]/.test(glob) || glob.startsWith("~") || glob.split(/[\\/]/).includes("..")) {
        return FOLDER_ONLY_REFUSAL(toolName);
      }
    }
  }
  return null;
}

/**
 * Why a chat's `read` of `rawPath` is refused, or null when the path is inside a skill or a
 * file the user named. The path is resolved through symlinks before it is compared, so a
 * link inside a skill folder cannot lead out of it.
 */
export function chatReadBlockReason(
  rawPath: unknown,
  cwd: string,
  skills: readonly { filePath: string; baseDir?: string }[],
  grants?: ChatFileGrants,
  hasFolder = false,
): string | null {
  const refusal = hasFolder
    ? "Chats can read files in their own folder, skill files, and files the user named by full path in their own message. Ask the user to give the file's full path or attach it, or let this chat use the computer, or open a project."
    : grants
    ? "Chats can read skill files, files you saved, and files the user named by full path in their own message. Ask the user to give the file's full path or attach it, or open a project to read files."
    : "Chats can only read skill files. Ask the user to attach the file to the message, or open a project to read files.";
  if (typeof rawPath !== "string" || !rawPath.trim()) return refusal;
  const real = safeRealpath(expandPath(rawPath, cwd));
  if (!real) return refusal;
  if (grants && isSensitivePath(real)) {
    return "Credentials and keys (such as ~/.ssh and Pi's own settings) are never readable in a chat, even when named.";
  }
  const roots = skillReadRoots(skills);
  if (roots.files.includes(real)) return null;
  if (roots.directories.some((root) => isInside(root, real))) return null;
  if (grants?.allows(real, cwd)) return null;
  return refusal;
}

/**
 * Drop every extension that registers a tool able to hand work to another agent. A
 * subagent runs with its own tools, so it would carry the file and shell access a chat
 * is denied; the tool_call guard cannot see inside it.
 */
export function withoutAgentDelegation(
  base: LoadExtensionsResult,
  delegationToolNames: ReadonlySet<string>,
): LoadExtensionsResult {
  const dropped = new Set(
    base.extensions
      .filter((extension) => [...delegationToolNames].some((name) => extension.tools.has(name)))
      .map((extension) => extension.path),
  );
  if (dropped.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !dropped.has(extension.path)),
    errors: base.errors.filter((error) => !dropped.has(error.path)),
  };
}

/** `Today's date is …` for the model; a chat has no environment section of its own. */
export function chatDateSection(now: Date = new Date()): string {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  return `Today's date is ${date} (${weekday})${timeZone ? `, time zone ${timeZone}` : ""}.`;
}

/**
 * Registers the chat's prompt sections and tool guard.
 *
 * `getSkills` and `getCwd` are read lazily on each call: the session (and with it the
 * resource loader) does not exist yet when the extension factory is built.
 */
export function createChatWorkspaceExtension(options: {
  getSkills: () => readonly { filePath: string; baseDir?: string }[];
  getCwd: () => string;
  /** The user's own chat instructions, read on every run so an edit applies to the next prompt. */
  getInstructions?: () => string | undefined;
  /** Extension tools the user allows in chats; read on every run and call. */
  getExtraTools?: () => readonly string[];
  /** Files the user named or the chat saved; omitted where the server must not touch the user's files. */
  grants?: ChatFileGrants;
  /** The chat owns a folder (its cwd): file tools work inside it, only the shell is blocked. */
  folder?: boolean;
  /** The user let this chat use their computer: keep the chat prompt, lift every tool limit. */
  unrestricted?: boolean;
}): InlineExtension {
  const hasFolder = options.folder === true;
  return {
    name: CHAT_WORKSPACE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event, ctx) => {
        if (options.grants) {
          // Only the user's own words name a readable file: not tool output, not the model.
          options.grants.noteSessionOnce(() => userMessageTexts(ctx.sessionManager.getEntries()));
          if (event.messageType === "user") options.grants.noteUserText(event.prompt);
        }
        if (!options.unrestricted) {
          // An edit to selectedTools wins over the live loadout, so a tool an extension or
          // tool_search switched on cannot reach the model's declarations.
          const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
          const selected = event.systemPromptOptions.selectedTools;
          const extra = new Set(options.getExtraTools?.() ?? []);
          const allowed = selected.filter((name) => isChatToolAllowed(registered.get(name) ?? { name }, extra, hasFolder));
          if (allowed.length !== selected.length) event.systemPromptOptions.selectedTools = allowed;
        }
        event.systemPromptOptions.sections.date = chatDateSection();
        const instructions = options.getInstructions?.();
        if (instructions) event.systemPromptOptions.sections.instructions = instructions;
        else delete event.systemPromptOptions.sections.instructions;
        // Pi appends the working directory to every prompt: a chat with a folder names it,
        // the legacy shared cwd is not worth naming.
        event.systemPromptOptions.cwd = hasFolder ? options.getCwd() : "(none)";
        return undefined;
      });
      if (options.unrestricted) return;
      // Nested calls (a codemode script's) pass through tool_call as well.
      pi.on("tool_call", (event) => {
        if (chatBlockedToolNames(hasFolder).has(event.toolName)) {
          return { block: true, reason: chatBlockedToolReason(event.toolName, hasFolder) };
        }
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        const extra = new Set(options.getExtraTools?.() ?? []);
        if (!isChatToolAllowed(tool ?? { name: event.toolName }, extra, hasFolder)) {
          return { block: true, reason: chatUnavailableToolReason(event.toolName) };
        }
        // An MCP tool that its server does not mark read-only can write files or run commands,
        // which is the shell this chat does not have. The user can name a tool in
        // Settings › Chats to allow it anyway.
        if (
          isMcpTool({ name: event.toolName, sourceInfo: tool?.sourceInfo } as Parameters<typeof isMcpTool>[0])
          && tool?.annotations?.readOnlyHint !== true
          && !extra.has(event.toolName)
        ) {
          return { block: true, reason: chatMcpWriteBlockReason(event.toolName) };
        }
        if (hasFolder) {
          const reason = chatFolderToolBlockReason(
            event.toolName,
            event.input,
            options.getCwd(),
            options.getSkills(),
            options.grants,
          );
          if (reason) return { block: true, reason };
        } else if (event.toolName === CHAT_READ_TOOL_NAME) {
          const input = event.input as { path?: unknown } | undefined;
          const reason = chatReadBlockReason(input?.path, options.getCwd(), options.getSkills(), options.grants);
          if (reason) return { block: true, reason };
        }
        return undefined;
      });
    },
  };
}

export function chatMcpWriteBlockReason(toolName: string): string {
  return `"${toolName}" is an MCP tool its server does not mark read-only, and a chat does not run tools that may write files or run commands. The user can let this chat use their computer from the chat's menu, or allow this tool by name in Settings › Chats.`;
}

function* userMessageTexts(entries: readonly unknown[]): Iterable<string> {
  for (const entry of entries) {
    const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if ((entry as { type?: string }).type !== "message" || message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      yield content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ((block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
          yield (block as { text: string }).text;
        }
      }
    }
  }
}
