import { NextResponse } from "next/server";
import { ModelsConfigReadError } from "@/lib/models-config-store";
import {
  applyDistroServiceConfig,
  DistroConfigError,
  readDistroServiceStatus,
} from "@/lib/distro/service-config";

export const dynamic = "force-dynamic";

/** Service address/key status for the distro provider. Never returns the key. */
export async function GET() {
  return NextResponse.json(readDistroServiceStatus());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { baseUrl?: unknown; apiKey?: unknown };
    return NextResponse.json(await applyDistroServiceConfig(body));
  } catch (error) {
    if (error instanceof DistroConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
