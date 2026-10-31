import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * The thinking levels the selectors offer (client-safe: type imports only,
 * so "use client" modules may import this — the write path's
 * lib/default-preferences.ts re-exports it to keep one spelling).
 */
export const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}
