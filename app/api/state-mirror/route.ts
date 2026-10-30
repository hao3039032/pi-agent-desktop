import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readStateMirror, writeStateMirror } from "@/lib/state-mirror-store";
import { STATE_MIRROR_SCHEMA_VERSION } from "@/lib/state-mirror";

export const dynamic = "force-dynamic";

/** The transition-version state mirror (docs/migration/README.md §M1). */
export async function GET() {
  const result = readStateMirror();
  if (!result.ok) {
    // No mirror yet (or a corrupt one): the client keeps revision 0 and
    // starts fresh; a corrupt file is left for the next accepted write to
    // replace rather than being silently deleted.
    return NextResponse.json({ schemaVersion: STATE_MIRROR_SCHEMA_VERSION, revision: 0, entries: {}, reason: result.reason });
  }
  return NextResponse.json(result.payload);
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const result = writeStateMirror(body);
  if (!result.ok) {
    const status = result.reason === "invalid" ? 400 : result.reason === "stale" ? 409 : 500;
    return NextResponse.json({ error: result.reason, detail: result.error }, { status });
  }
  return NextResponse.json({ ok: true, revision: result.revision, bytes: result.bytes });
}
