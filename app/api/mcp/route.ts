import { NextResponse } from "next/server";
import type { McpErrorResponse, McpResponse } from "@/lib/api-types";
import { executeMcpAction, getMcpConfig, McpServiceError } from "@/lib/mcp-service.server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// GET /api/mcp?cwd=<absolute project folder>
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  try {
    const data = await getMcpConfig({ cwd: cwd ?? undefined });
    return NextResponse.json(data satisfies McpResponse);
  } catch (error) {
    if (error instanceof McpServiceError) {
      return NextResponse.json(error.toResponse(), { status: error.status });
    }
    return NextResponse.json({ error: errorMessage(error), reason: "internal" } satisfies McpErrorResponse, { status: 500 });
  }
}

// POST /api/mcp
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", reason: "request-denied" } satisfies McpErrorResponse, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json", reason: "content-type" } satisfies McpErrorResponse, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", reason: "invalid-request" } satisfies McpErrorResponse, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object", reason: "invalid-request" } satisfies McpErrorResponse, { status: 400 });
  }

  try {
    const data = await executeMcpAction({ body: body as Record<string, unknown> });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof McpServiceError) {
      return NextResponse.json(error.toResponse(), { status: error.status });
    }
    return NextResponse.json({ error: errorMessage(error), reason: "internal" } satisfies McpErrorResponse, { status: 500 });
  }
}
