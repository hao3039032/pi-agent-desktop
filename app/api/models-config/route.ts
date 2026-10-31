import { NextResponse } from "next/server";
import { ModelsConfigReadError, readRedactedModelsConfig, saveModelsConfig } from "@/lib/models-config-service.server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Literal apiKey values never leave the server; shell/env references and
    // every other field are configuration the editor needs to see.
    return NextResponse.json(readRedactedModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    saveModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
