import { composeProviderLists } from "@/lib/provider-auth-service.server";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309). The composition
// (extension providers included, custom models.json ids excluded from the
// API-key list) is lib/provider-auth-service.server.ts, shared with the
// management instance's auth.providers op.
export async function GET() {
  return Response.json(await composeProviderLists());
}
