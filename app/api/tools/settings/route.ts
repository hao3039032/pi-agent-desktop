import { NextResponse } from "next/server";
import type { McpErrorResponse, McpRefusalReason } from "@/lib/api-types";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  applyToolSettingsChange,
  readToolSettings,
  ToolSettingsRefusalError,
} from "@/lib/tool-settings-service.server";

export const dynamic = "force-dynamic";

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

function errorResponse(error: unknown) {
  if (error instanceof ToolSettingsRefusalError) {
    return refusal(error.status, error.reason, error.message);
  }
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}

export async function GET() {
  try {
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }

  try {
    const updated = await applyToolSettingsChange(body);
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error);
  }
}
