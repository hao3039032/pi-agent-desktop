/**
 * The pi-web chat policy, loaded into `pi --mode rpc` children that serve a
 * non-project chat (`--extension <this file>`). Ported from
 * lib/chat-workspace-policy.ts, lib/chat-file-access.ts and
 * lib/chat-downloads-tool.ts: the policy is pure Node computation, so it runs
 * inside the child exactly as it ran in-process.
 *
 * Configuration arrives through the environment (set by the session factory):
 *   PI_WEB_CHAT_MODE   "folder" | "legacy" | "unlocked"
 *   PI_WEB_CHAT_FILES  "1" when the server may touch the user's files
 *                      (loopback-only server; see isNetworkExposedServer)
 *
 * The chat instructions / allowed tools / confirm-save switches are read from
 * Pi Web's own settings file (~/.pi/agent/pi-web/settings.json, reachable via
 * PI_CODING_AGENT_DIR) on every run, like the in-process extension did.
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child, which does not share pi-web's module graph.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * The TypeBox builder: pi bundles it for extensions; pi-web's own process
 * reaches it through @earendil-works/pi-ai. Either way, a plain-object
 * fallback keeps the asset loadable where neither resolves (tests).
 */
let Type;
try {
  ({ Type } = await import("@sinclair/typebox"));
} catch {
  try {
    ({ Type } = await import("@earendil-works/pi-ai"));
  } catch {
    Type = {
      Object: (properties) => ({ type: "object", properties }),
      String: (options = {}) => ({ type: "string", ...options }),
      Optional: (schema) => ({ ...schema, optional: true }),
      Union: (members, options = {}) => ({ anyOf: members, ...options }),
      Literal: (value) => ({ const: value }),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (path containment, realpath)
// ---------------------------------------------------------------------------

function userHome() {
  // The documented override pi-web itself honours (lib/user-home.ts); the
  // factory's env carries it into the child.
  return process.env.PI_AGENT_HOME || os.homedir();
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(userHome(), ".pi", "agent");
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function expandPath(rawPath, cwd) {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = userHome();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(userHome(), value.slice(2));
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

/**
 * The real path of `rawPath` as far as the filesystem can say: the deepest
 * ancestor that exists is resolved through symlinks, and what does not exist
 * yet is appended unchanged (a `write` to a new file is judged by where it
 * would land, and a symlink inside the folder that points out of it is seen
 * for what it is).
 */
function resolveThroughSymlinks(absolute) {
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const real = safeRealpath(current) || current;
  return missing.length ? path.join(real, ...missing) : real;
}

// ---------------------------------------------------------------------------
// Chat settings (Pi Web's own file, read per run)
// ---------------------------------------------------------------------------

function readChatSettings() {
  try {
    const settingsPath = path.join(agentDir(), "pi-web", "settings.json");
    if (!fs.existsSync(settingsPath)) return { instructions: "", allowedTools: [], confirmSave: false };
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const chats = parsed && typeof parsed === "object" && parsed.chats && typeof parsed.chats === "object"
      ? parsed.chats
      : {};
    // Same caps as lib/chat-settings-shared.ts: instructions truncated, tool
    // names filtered to the documented pattern and count.
    const instructions = typeof chats.instructions === "string" ? chats.instructions.slice(0, 8000) : "";
    const allowedTools = Array.isArray(chats.allowedTools)
      ? [...new Set(chats.allowedTools.filter((name) => typeof name === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(name)))].slice(0, 50)
      : [];
    return { instructions, allowedTools, confirmSave: chats.confirmSave === true };
  } catch {
    return { instructions: "", allowedTools: [], confirmSave: false };
  }
}

/** The wrapped instructions section, mirroring lib/chat-settings.ts. */
function chatInstructionsSection(settings) {
  const text = settings.instructions.trim();
  return text
    ? `The user's own instructions for every chat. Follow them unless they conflict with this prompt:\n${text}`
    : undefined;
}

// ---------------------------------------------------------------------------
// User-named file grants (chat-file-access.ts)
// ---------------------------------------------------------------------------

const MAX_PATH_CHARS = 1024;
const MAX_NAMED_PATHS = 100;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}，。；：！？、）】」』》”’]+$/;

/** Attached files travel as <attached_file> blocks whose text is not the user's words. */
function splitAttachedFiles(text) {
  const parts = [];
  const pattern = /<attached_file[^>]*>([\s\S]*?)<\/attached_file>/g;
  let rest = text.replace(pattern, (_match, body) => {
    parts.push(body);
    return " ";
  });
  return { text: rest, attachments: parts };
}

function extractUserNamedPaths(text) {
  const found = [];
  const add = (raw) => {
    let value = raw.trim();
    if (value.startsWith("file://")) {
      try {
        value = decodeURIComponent(new URL(value).pathname);
      } catch {
        return;
      }
    }
    value = value.replace(/\\ /g, " ").replace(TRAILING_PUNCTUATION, "");
    if (!value || value.length > MAX_PATH_CHARS || value.includes("\0")) return;
    if (!/^(~[\\/]|\/|[A-Za-z]:[\\/])/.test(value)) return;
    if (/^(~?[\\/]?|[A-Za-z]:[\\/]?)$/.test(value)) return;
    if (!found.includes(value)) found.push(value);
  };

  const quoted = /["'`]((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])[^"'`\n]*)["'`]|[“‘「『]((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])[^”’」』\n]*)[”’」』]/g;
  const withoutQuoted = text.replace(quoted, (_match, straight, curly) => {
    add(straight || curly);
    return " ";
  });
  const bare = /(?<![\w.~/:@\\-])((?:file:\/\/)?(?:~[\\/]|\/|[A-Za-z]:[\\/])(?:\\ |[^\s"'`<>|*?])*)/g;
  for (const match of withoutQuoted.matchAll(bare)) add(match[1]);

  return found.slice(0, MAX_NAMED_PATHS);
}

const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gcloud", "Library/Keychains"];
const SECRET_FILE_NAMES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa"]);

function isSensitivePath(realPath) {
  const home = safeRealpath(userHome()) || userHome();
  if (SECRET_HOME_DIRS.some((dir) => isInside(path.join(home, dir), realPath))) return true;
  if (SECRET_FILE_NAMES.has(path.basename(realPath))) return true;
  const dir = safeRealpath(agentDir()) || agentDir();
  return isInside(dir, realPath)
    && !isInside(path.join(dir, "sessions"), realPath)
    && path.basename(realPath).toLowerCase().endsWith(".json");
}

function userPath(value, cwd) {
  let next = value.trim();
  if (next === "~") next = userHome();
  else if (next.startsWith("~/") || next.startsWith("~\\")) next = path.join(userHome(), next.slice(2));
  return path.isAbsolute(next) ? path.resolve(next) : path.resolve(cwd, next);
}

function resolveNamedFile(candidate, cwd) {
  const real = safeRealpath(userPath(candidate, cwd));
  if (!real || isSensitivePath(real)) return null;
  try {
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

class ChatFileGrants {
  constructor() {
    this.named = new Set();
    this.saved = new Set();
    this.scannedSession = false;
  }

  noteUserText(text) {
    for (const target of extractUserNamedPaths(splitAttachedFiles(text).text)) {
      if (this.named.size >= MAX_NAMED_PATHS) break;
      this.named.add(target);
    }
  }

  noteSessionOnce(userTexts) {
    if (this.scannedSession) return;
    this.scannedSession = true;
    for (const text of userTexts()) this.noteUserText(text);
  }

  noteSaved(realPath) {
    this.saved.add(realPath);
  }

  allows(real, cwd) {
    if (isSensitivePath(real)) return false;
    if (this.saved.has(real)) return true;
    for (const candidate of this.named) {
      if (resolveNamedFile(candidate, cwd) === real) return true;
    }
    return false;
  }
}

function* userMessageTexts(entries) {
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") {
      yield content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") yield block.text;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Saving to Downloads (chat-file-access.ts + chat-downloads-tool.ts)
// ---------------------------------------------------------------------------

const DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
  ".app", ".command", ".pkg", ".dmg", ".mpkg", ".exe", ".msi", ".bat", ".cmd", ".com", ".scr",
  ".vbs", ".vbe", ".jse", ".wsf", ".jar", ".apk", ".deb", ".rpm", ".run", ".workflow", ".action",
  ".terminal", ".desktop", ".lnk", ".scpt", ".dll", ".dylib", ".pif", ".reg", ".hta", ".cpl",
]);

function chatDownloadsDir() {
  const configured = (process.env.XDG_DOWNLOAD_DIR || "").trim();
  return configured && path.isAbsolute(configured) ? configured : path.join(userHome(), "Downloads");
}

function checkDownloadName(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "filename must be a string" };
  const name = raw.normalize("NFC").trim();
  if (!name) return { ok: false, reason: "filename is empty" };
  if (name.length > 200) return { ok: false, reason: "filename is too long" };
  if (/[\\/\0]/.test(name) || name.includes("..")) {
    return { ok: false, reason: "give a file name only, without a folder or path" };
  }
  if (name.startsWith(".")) return { ok: false, reason: "hidden files are not saved" };
  if (/[\x00-\x1f<>:"|?*]/.test(name)) return { ok: false, reason: "filename contains characters that are not allowed" };
  if (/[. ]$/.test(name)) return { ok: false, reason: "filename must not end with a dot or space" };
  const extension = path.extname(name).toLowerCase();
  if (BLOCKED_DOWNLOAD_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `${extension} files can run code, so a chat does not save them` };
  }
  return { ok: true, name };
}

function saveDownload(dir, filename, data) {
  if (data.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`file is larger than ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MB`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const name = attempt === 0 ? filename : `${stem} (${attempt})${extension}`;
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error("invalid file name");
    let fd;
    try {
      fd = fs.openSync(target, "wx", 0o644);
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return { path: target, name, size: data.length };
  }
  throw new Error("too many files with this name already exist");
}

// ---------------------------------------------------------------------------
// The chat policy (chat-workspace-policy.ts)
// ---------------------------------------------------------------------------

const CHAT_SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
const CHAT_BLOCKED_TOOL_NAMES = new Set(["bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const CHAT_READ_TOOL_NAME = "read";
const CHAT_FOLDER_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"];
const CHAT_DEFAULT_TOOL_NAMES = [
  CHAT_READ_TOOL_NAME,
  "codemode",
  "tool_search",
  "save_to_downloads",
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
];
const CHAT_FOLDER_DEFAULT_TOOL_NAMES = [
  ...CHAT_FOLDER_TOOL_NAMES,
  ...CHAT_DEFAULT_TOOL_NAMES.filter((name) => name !== CHAT_READ_TOOL_NAME && name !== "save_to_downloads"),
];
const CHAT_ALLOWED_TOOL_NAMES = new Set(CHAT_DEFAULT_TOOL_NAMES);
const CHAT_FOLDER_ALLOWED_TOOL_NAMES = new Set(CHAT_FOLDER_DEFAULT_TOOL_NAMES);

function chatBlockedToolNames(hasFolder) {
  return hasFolder ? CHAT_SHELL_TOOL_NAMES : CHAT_BLOCKED_TOOL_NAMES;
}

function isMcpTool(tool) {
  return (tool.sourceInfo && tool.sourceInfo.path === "builtin:mcp")
    || tool.name.startsWith("mcp__");
}

function isChatToolAllowed(tool, extraAllowed, hasFolder) {
  if (chatBlockedToolNames(hasFolder).has(tool.name)) return false;
  return (hasFolder ? CHAT_FOLDER_ALLOWED_TOOL_NAMES : CHAT_ALLOWED_TOOL_NAMES).has(tool.name)
    || extraAllowed.has(tool.name)
    || isMcpTool({ name: tool.name, sourceInfo: tool.sourceInfo });
}

function chatUnavailableToolReason(toolName) {
  return `"${toolName}" is not available in a chat. Chats can use skills and MCP tools; open a project to use other tools.`;
}

function chatBlockedToolReason(toolName, hasFolder) {
  if (hasFolder) {
    return `"${toolName}" is not available in a chat: a chat has no shell. The user can let this chat use their computer from the chat's menu, or open a project to use it.`;
  }
  return `"${toolName}" is not available in a chat. Chats have no access to the user's files or shell; open a project to use it.`;
}

function chatMcpWriteBlockReason(toolName) {
  return `"${toolName}" is an MCP tool its server does not mark read-only, and a chat does not run tools that may write files or run commands. The user can let this chat use their computer from the chat's menu, or allow this tool by name in Settings › Chats.`;
}

const CHAT_PROMPT_INTRO = "You are a helpful, knowledgeable assistant in a desktop chat app. Answer directly and accurately, and ask a clarifying question only when the request is genuinely ambiguous. Reply in the language the user writes in, and use Markdown when it makes the answer easier to read.";
const CHAT_PROMPT_TOOLS = "You may use the tools and skills made available to you. MCP tools work here only when their server marks them read-only.";
const CHAT_PROMPT_UNLOCKED_TOOLS = "You may use the tools and skills made available to you. Tools from MCP servers the user has set up can do more than read: some write files or run commands, so use those only for what the user asked and say what you did.";
const CHAT_PROMPT_FILES = `This is a general chat, not a project. You have no shell and no file editing of your own. The user can attach images and files to a message; what they attach is included in the message itself. You can read a file only when the user writes its full path in their own message, and you can save a file they ask for into their Downloads folder with save_to_downloads (a file name only, never overwriting). ${CHAT_PROMPT_TOOLS} When the task needs a shell or editing a project, tell the user to open a project instead.`;
const CHAT_PROMPT_NO_FILES = `This is a general chat, not a project. You have no access of your own to the user's files and no shell. The user can attach images and files to a message; what they attach is included in the message itself. ${CHAT_PROMPT_TOOLS} When the task needs files or a shell, tell the user to open a project instead.`;
const CHAT_PROMPT_FOLDER = "This is a general chat, not a project. This chat has a working folder of its own: relative paths start there, and you can read, write, edit, search and list files inside it. Keep what you create there and tell the user the file name so they can find it in the chat's folder. You have no shell and cannot read or change files outside that folder. The user can attach images and files to a message; what they attach is included in the message itself.";
const CHAT_PROMPT_FOLDER_NAMED = " You can also read (never change) a file elsewhere on the computer when the user writes its full path in their own message.";
const CHAT_PROMPT_FOLDER_END = " When the task needs a shell or to change files outside the folder, tell the user they can let this chat use their computer from the chat's menu, or open a project.";
const CHAT_PROMPT_UNLOCKED = "This is a general chat, not a project, and the user has let it use their computer: you have a shell and can read and change files anywhere their account can. This chat's working folder is where new files go by default. Do only what the user asked, say what you changed, and ask before anything destructive or outside the working folder. The user can attach images and files to a message; what they attach is included in the message itself.";

function chatDateSection(now = new Date()) {
  let timeZone;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  return `Today's date is ${date} (${weekday})${timeZone ? `, time zone ${timeZone}` : ""}.`;
}

function skillReadRoots(skills) {
  const directories = new Set();
  const files = new Set();
  for (const skill of skills) {
    const real = safeRealpath(skill.filePath);
    if (!real) continue;
    if (path.basename(skill.filePath).toLowerCase() === "skill.md") {
      directories.add(path.dirname(real));
    } else {
      files.add(real);
    }
  }
  return { directories: [...directories], files: [...files] };
}

function isInsideChatFolder(rawPath, folder) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) return false;
  const realFolder = safeRealpath(folder) || folder;
  return isInside(realFolder, resolveThroughSymlinks(expandPath(rawPath, folder)));
}

const FOLDER_ONLY_REFUSAL = (toolName) =>
  `"${toolName}" only works inside this chat's own folder. Give a path in the folder (relative paths start there), or let this chat use the computer from the chat's menu, or open a project.`;

function chatReadBlockReason(rawPath, cwd, skills, grants, hasFolder) {
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
  if (grants && grants.allows(real, cwd)) return null;
  return refusal;
}

function chatFolderToolBlockReason(toolName, input, folder, skills, grants) {
  const args = input && typeof input === "object" ? input : {};
  if (toolName === "read") {
    if (isInsideChatFolder(args.path, folder)) return null;
    return chatReadBlockReason(args.path, folder, skills, grants, true);
  }
  if (toolName === "write" || toolName === "edit") {
    return isInsideChatFolder(args.path, folder) ? null : FOLDER_ONLY_REFUSAL(toolName);
  }
  if (toolName === "ls" || toolName === "find" || toolName === "grep") {
    if (args.path !== undefined && !isInsideChatFolder(args.path, folder)) return FOLDER_ONLY_REFUSAL(toolName);
    const globs = [toolName === "find" ? args.pattern : undefined, toolName === "grep" ? args.glob : undefined];
    for (const glob of globs) {
      if (typeof glob !== "string") continue;
      if (path.isAbsolute(glob) || /^[A-Za-z]:[\\/]/.test(glob) || glob.startsWith("~") || glob.split(/[\\/]/).includes("..")) {
        return FOLDER_ONLY_REFUSAL(toolName);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export default function piWebChat(pi) {
  const mode = process.env.PI_WEB_CHAT_MODE || "legacy";
  const hasFolder = mode === "folder";
  const unrestricted = mode === "unlocked";
  const filesEnabled = process.env.PI_WEB_CHAT_FILES === "1";
  const grants = filesEnabled && !unrestricted ? new ChatFileGrants() : undefined;
  const getCwd = () => process.cwd();

  pi.on("before_agent_start", (event, ctx) => {
    const settings = readChatSettings();
    if (grants) {
      // Only the user's own words name a readable file: not tool output, not the model.
      grants.noteSessionOnce(() => userMessageTexts(ctx.sessionManager.getEntries()));
      if (event.messageType === "user") grants.noteUserText(event.prompt);
    }
    if (!unrestricted) {
      const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
      const selected = event.systemPromptOptions.selectedTools;
      const extra = new Set(settings.allowedTools);
      const allowed = selected.filter((name) => isChatToolAllowed(registered.get(name) || { name }, extra, hasFolder));
      if (allowed.length !== selected.length) event.systemPromptOptions.selectedTools = allowed;
    }
    event.systemPromptOptions.sections.date = chatDateSection();
    const instructions = chatInstructionsSection(settings);
    if (instructions) event.systemPromptOptions.sections.instructions = instructions;
    else delete event.systemPromptOptions.sections.instructions;
    event.systemPromptOptions.cwd = hasFolder ? getCwd() : "(none)";
    return undefined;
  });

  if (unrestricted) return;

  pi.on("tool_call", (event) => {
    if (chatBlockedToolNames(hasFolder).has(event.toolName)) {
      return { block: true, reason: chatBlockedToolReason(event.toolName, hasFolder) };
    }
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    const settings = readChatSettings();
    const extra = new Set(settings.allowedTools);
    if (!isChatToolAllowed(tool || { name: event.toolName }, extra, hasFolder)) {
      return { block: true, reason: chatUnavailableToolReason(event.toolName) };
    }
    if (
      isMcpTool({ name: event.toolName, sourceInfo: tool && tool.sourceInfo })
      && (!tool || !tool.annotations || tool.annotations.readOnlyHint !== true)
      && !extra.has(event.toolName)
    ) {
      return { block: true, reason: chatMcpWriteBlockReason(event.toolName) };
    }
    const skills = (pi.getSkills && pi.getSkills()) || [];
    if (hasFolder) {
      const reason = chatFolderToolBlockReason(event.toolName, event.input, getCwd(), skills, grants);
      if (reason) return { block: true, reason };
    } else if (event.toolName === CHAT_READ_TOOL_NAME) {
      const input = event.input || {};
      const reason = chatReadBlockReason(input.path, getCwd(), skills, grants);
      if (reason) return { block: true, reason };
    }
    return undefined;
  });

  // The one write a legacy chat has (Settings file gates the confirm dialog).
  if (!hasFolder && filesEnabled) {
    pi.registerTool({
      name: "save_to_downloads",
      label: "Save to Downloads",
      description: `Save a file to the user's Downloads folder, for example a document, a script or exported data they asked for. Give a file name only (no folders) and the content. An existing file is never replaced: a taken name gets " (1)" added. Programs and installers are refused. Up to ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
      promptSnippet: "Save a file the user asked for to their Downloads folder",
      parameters: Type.Object({
        filename: Type.String({ description: "File name with extension, for example notes.md. No folder." }),
        content: Type.String({ description: "The file's content: text, or base64 when encoding is base64." }),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
          description: "How content is encoded. Default utf8.",
        })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = checkDownloadName(params.filename);
        if (!name.ok) throw new Error(`Not saved: ${name.reason}.`);
        const data = params.encoding === "base64"
          ? Buffer.from(params.content, "base64")
          : Buffer.from(params.content, "utf8");
        const settings = readChatSettings();
        if (settings.confirmSave) {
          const allowed = await ctx.ui.confirm(
            "Save a file?",
            `Save "${name.name}" (${data.length} bytes) to your Downloads folder?`,
          );
          if (!allowed) throw new Error("The user declined to save the file.");
        }
        const saved = saveDownload(chatDownloadsDir(), name.name, data);
        try {
          grants.noteSaved(fs.realpathSync(saved.path));
        } catch {
          grants.noteSaved(saved.path);
        }
        return {
          content: [{ type: "text", text: `Saved ${saved.name} (${saved.size} bytes) to ${saved.path}` }],
          details: { path: saved.path, name: saved.name, size: saved.size },
        };
      },
    });
  }
}
