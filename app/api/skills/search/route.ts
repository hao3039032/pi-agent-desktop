import { NextResponse } from "next/server";
import { searchSkills } from "@/lib/skills-search.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { query, limit } = await req.json() as { query?: string; limit?: unknown };
    if (!query?.trim()) return NextResponse.json({ error: "query required" }, { status: 400 });
    return NextResponse.json({ results: await searchSkills(query, limit, req.signal) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
