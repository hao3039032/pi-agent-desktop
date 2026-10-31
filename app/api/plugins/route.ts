import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { managePlugins, PluginServiceError, readPlugins } from "@/lib/plugins-service.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    return NextResponse.json(await readPlugins(cwd));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as Parameters<typeof managePlugins>[0];
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
    if (!isExistingFilePathAllowed(body.cwd, await getAllowedFileRoots())) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    return NextResponse.json(await managePlugins(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof PluginServiceError ? error.status : 500 });
  }
}
