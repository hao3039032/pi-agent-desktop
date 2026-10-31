import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { isChatFolderPath, isChatWorkspacePath } from "@/lib/chat-workspace";
import { allowFileRoot } from "@/lib/file-access";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  invalidateSessionListCache,
  readSessionHeader,
  resolveSessionPath,
} from "@/lib/session-reader";
import { copyChatToProject } from "@/lib/chat-continue";

export const runtime = "nodejs";

/**
 * Continue a chat inside a project: the conversation is copied into a new session whose
 * cwd is the chosen project, so the model gains that project's tools while the chat stays
 * exactly as it was. The copy records the chat as its parent, like a fork.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const cwd = resolve(body.cwd);
    if (isChatWorkspacePath(cwd)) {
      return NextResponse.json({ error: "Choose a project folder" }, { status: 400 });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const header = readSessionHeader(filePath);
    if (!header || !isChatWorkspacePath(header.cwd)) {
      return NextResponse.json({ error: "Only a chat can be continued in a project" }, { status: 400 });
    }
    if (getRpcSession(id)?.isRunning()) {
      return NextResponse.json({ error: "Wait for the chat to finish first" }, { status: 409 });
    }

    const copy = copyChatToProject(filePath, cwd);
    allowFileRoot(cwd);
    invalidateSessionListCache();
    return NextResponse.json({
      sessionId: copy.sessionId,
      path: copy.path,
      cwd,
      // Files the chat made stay in its folder; the project session starts without them.
      chatFolder: isChatFolderPath(header.cwd) ? header.cwd : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
