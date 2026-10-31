import { NextResponse } from "next/server";
import {
  ProviderAuthRefusalError,
  removeProviderApiKey,
  storeProviderApiKey,
} from "@/lib/provider-auth-service.server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
// The composition (the headless login prompt shim, the direct credential
// store that never waits on a catalog refresh) is
// lib/provider-auth-service.server.ts, shared with the management
// instance's auth.apiKeyStore op.
export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { apiKey } = await req.json() as { apiKey?: string };
    if (typeof apiKey !== "string") {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    await storeProviderApiKey(provider, apiKey, req.signal);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProviderAuthRefusalError && error.reason === "invalid_args") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes a stored API key, but never
// an OAuth credential (the 409 keeps the account signed in).
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    await removeProviderApiKey(provider);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProviderAuthRefusalError && error.reason === "credential_type_mismatch") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
