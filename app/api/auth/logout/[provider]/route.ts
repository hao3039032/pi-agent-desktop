import { NextResponse } from "next/server";
import { logoutProvider, ProviderAuthRefusalError } from "@/lib/provider-auth-service.server";

export const dynamic = "force-dynamic";

// The composition (the OAuth-method gate and the type-gated credential
// delete) is lib/provider-auth-service.server.ts, shared with the
// management instance's auth.logout op.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  try {
    await logoutProvider(provider);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ProviderAuthRefusalError && error.reason === "unknown_provider") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ProviderAuthRefusalError && error.reason === "credential_type_mismatch") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
