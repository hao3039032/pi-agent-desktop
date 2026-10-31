import { NextResponse } from "next/server";
import { discoverModels } from "@/lib/models-extras-service.server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    try {
      const result = await discoverModels({ providerName, provider: body.provider });
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === "Base URL is required" ||
        message === "Base URL is invalid" ||
        message.startsWith("No API key found for")
      ) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      if (
        message === "No models found in the upstream response" ||
        message === "Upstream model list was not valid JSON" ||
        message.includes("Upstream returned HTTP")
      ) {
        return NextResponse.json({ error: message }, { status: 502 });
      }
      const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
      return NextResponse.json({ error: message }, { status });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
