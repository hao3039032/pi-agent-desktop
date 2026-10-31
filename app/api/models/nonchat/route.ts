import { loadNonChatModels } from "@/lib/models-extras-service.server";

export const runtime = "nodejs";

/**
 * GET: classifier and image models (Settings › Models › Non-chat models), with the global
 * Code mode choice, since codemode scripts are the only way a session reaches them.
 * Read-only and offline: the runtime restores catalogs without fetching them.
 */
export async function GET() {
  try {
    const result = await loadNonChatModels();
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
