import { runNpx } from "@/lib/npx";
import type { SkillSearchResult } from "@/lib/api-types";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

function parseSearchOutput(raw: string): SkillSearchResult[] {
  const lines = raw.replace(ANSI_RE, "").split("\n");
  const results: SkillSearchResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
    if (!match) continue;
    const url = lines[i + 1]?.trim().replace(/^└\s*/, "");
    results.push({ package: match[1], installs: match[2], url: url?.startsWith("https://") ? url : "" });
  }
  return results;
}

function formatInstalls(count?: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function installCount(installs: string): number {
  const match = installs.match(/^([\d.]+)([KMB])?\s+installs?$/);
  if (!match) return 0;
  return Number(match[1]) * (match[2] === "B" ? 1e9 : match[2] === "M" ? 1e6 : match[2] === "K" ? 1e3 : 1);
}

export async function searchSkills(query: string, rawLimit?: unknown, signal?: AbortSignal): Promise<SkillSearchResult[]> {
  if (!query.trim()) throw new Error("query required");
  const number = rawLimit == null ? NaN : typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  const limit = Number.isFinite(number) ? Math.min(50, Math.max(1, Math.floor(number))) : 50;
  try {
    const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`;
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`);
    const data = await response.json() as { skills?: { id?: string; name?: string; source?: string; installs?: number }[] };
    return (data.skills ?? []).map((skill): SkillSearchResult | null => {
      const name = skill.name?.trim(), source = skill.source?.trim(), slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;
      return { package: `${source || slug}@${name}`, installs: formatInstalls(skill.installs), url: slug ? `${SEARCH_API_BASE}/${slug}` : "" };
    }).filter((item): item is SkillSearchResult => item !== null).sort((a, b) => installCount(b.installs) - installCount(a.installs));
  } catch (error) {
    if (signal?.aborted) throw error;
    try {
      const { stdout, stderr } = await runNpx(["skills", "find", query.trim()], { timeout: 20000, env: { ...process.env, FORCE_COLOR: "0" }, signal });
      return parseSearchOutput(stdout + stderr).slice(0, limit);
    } catch (fallback) {
      const err = fallback as { stdout?: string; stderr?: string };
      const results = parseSearchOutput((err.stdout ?? "") + (err.stderr ?? ""));
      if (results.length) return results;
      throw fallback;
    }
  }
}
