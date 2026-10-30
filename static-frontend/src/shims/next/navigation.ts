/**
 * next/navigation shim for the Vite build (M2 UI migration): the app uses
 * exactly two APIs — router.replace(url, { scroll: false }) and
 * useSearchParams(). The History/URLSearchParams adapter the migration plan
 * froze (§四: 集中式 History/URLSearchParams 适配，保留 session/cwd/view，URL
 * 优先于工作区恢复) lives behind these same signatures, so the existing
 * components keep working unchanged while the Next router is gone.
 *
 * router.replace → history.replaceState (no entry, no scroll, URL wins)
 * router.push   → history.pushState
 * useSearchParams → a live view of location.search
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type ReplaceOptions = { scroll?: boolean };

export interface AppRouter {
  replace(url: string, options?: ReplaceOptions): void;
  push(url: string, options?: ReplaceOptions): void;
}

export function useRouter(): AppRouter {
  const replace = useCallback((url: string, _options?: ReplaceOptions) => {
    // The app always replaces (never pushes entries mid-interaction); URL
    // state is the source of truth for session/cwd/view.
    window.history.replaceState(null, "", normalize(url));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const push = useCallback((url: string, _options?: ReplaceOptions) => {
    window.history.pushState(null, "", normalize(url));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return useMemo(() => ({ replace, push }), [replace, push]);
}

function normalize(url: string): string {
  // Next's router accepts relative query strings ("?session=x"); resolve
  // them against the current pathname for History.
  if (url.startsWith("?") || url === "" || !url.startsWith("/")) {
    const path = window.location.pathname || "/";
    return url.startsWith("?") ? `${path}${url}` : path;
  }
  return url;
}

export function useSearchParams(): URLSearchParams {
  const [search, setSearch] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search,
  );
  useEffect(() => {
    const onPop = (): void => setSearch(window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}
