import { NextResponse } from "next/server";
import { resolveSessionPath, openSessionManager, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;
  // Chat-view loads ask for whole turns so a window never cuts a turn in half;
  // without the flag `tail` is an exact cap on the returned ancestor chain.
  const wholeTurns = url.searchParams.has("wholeTurns");

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Only an ACTIVE-branch read (no explicit leafId, no pagination cursor)
    // depends on where the CLI's in-memory leaf points: navigateTree moves it
    // in memory while the file keeps the abandoned branch's tail, so the
    // leafId must come from the child together with the entries it was
    // computed against (one get_entries response). A failed live query is an
    // explicit error, never the disk tail presented as the live branch.
    // Explicit-branch browsing and `before` pagination address entries the
    // append-only file already holds, so the file view stays correct there
    // (and stays the only source once the wrapper is gone).
    if (liveRpc?.inner.getActiveSnapshot && !leafId && !before) {
      let snapshot: { entries: unknown[]; leafId: string | null };
      try {
        snapshot = await liveRpc.inner.getActiveSnapshot();
      } catch (error) {
        throw new Error(
          "the live session's active branch could not be read from the CLI process: "
            + (error instanceof Error ? error.message : String(error)),
        );
      }
      const context = buildSessionContext(snapshot.entries as never, snapshot.leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        wholeTurns,
        sessionId: id,
      });
      return NextResponse.json({ context, tail, before: null });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      wholeTurns,
      sessionId: id,
    });

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
