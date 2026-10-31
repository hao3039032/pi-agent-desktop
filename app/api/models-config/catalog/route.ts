import { NextResponse } from "next/server";
import { queryModelCatalog } from "@/lib/models-extras-service.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? undefined;
  const provider = searchParams.get("provider") ?? undefined;
  const baseUrl = searchParams.get("baseUrl") ?? undefined;
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const result = await queryModelCatalog({ q, provider, baseUrl, limit });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
