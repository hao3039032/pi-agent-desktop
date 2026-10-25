/** Bounded diagnostic lines. Never log environment values or RPC payloads. */
export function redactCliDiagnostic(line: string, env: NodeJS.ProcessEnv = process.env): string {
  let text = line;
  for (const [key, value] of Object.entries(env)) {
    if (value && /token|secret|password|credential|api.?key|authorization/i.test(key)) {
      text = text.split(value).join("[REDACTED]");
    }
  }
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[REDACTED]")
    .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    .slice(0, 2048);
}
