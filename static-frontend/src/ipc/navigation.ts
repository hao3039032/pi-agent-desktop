/**
 * Centralized navigation state for the static frontend (plan §四: 集中式
 * History/URLSearchParams 适配，保留 `session/cwd/view`、刷新、前进后退，URL
 * 优先于工作区恢复). Next.js's router is gone; this adapter owns the URL.
 */

export interface WorkspaceRoute {
  /** The open session id (absent on the welcome view). */
  session?: string;
  /** The selected project cwd (absent → the Chats/root view). */
  cwd?: string;
  /** The main view: chat (default), files, scheduled… */
  view?: string;
  /** Extra per-view parameters (file tabs, artifact tabs…). */
  params: URLSearchParams;
}

export const DEFAULT_VIEW = "chat";

/** Parse one URL into the route shape (pure; used by tests and the router). */
export function parseRoute(url: string): WorkspaceRoute {
  const parsed = new URL(url, "http://static.local");
  const params = new URLSearchParams(parsed.search);
  const session = params.get("session") ?? undefined;
  const cwd = params.get("cwd") ?? undefined;
  const view = params.get("view") ?? undefined;
  const rest = new URLSearchParams(params);
  rest.delete("session");
  rest.delete("cwd");
  rest.delete("view");
  return {
    ...(session ? { session } : {}),
    ...(cwd ? { cwd } : {}),
    ...(view && view !== DEFAULT_VIEW ? { view } : {}),
    params: rest,
  };
}

/** Serialize a route back into a relative URL (search-only, hashless). */
export function serializeRoute(route: WorkspaceRoute): string {
  const params = new URLSearchParams(route.params);
  if (route.session) params.set("session", route.session);
  if (route.cwd) params.set("cwd", route.cwd);
  if (route.view && route.view !== DEFAULT_VIEW) params.set("view", route.view);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/**
 * The router: one History entry per navigation, back/forward restore the
 * route, and `replace` (e.g. after a session id is learned) does not add
 * entries. The URL is the source of truth on load; workspace restore only
 * fills an EMPTY URL (URL wins over restored state).
 */
export class RouteNavigator {
  private readonly location: Location;
  private readonly history: History;
  private readonly listeners = new Set<(route: WorkspaceRoute) => void>();

  constructor(location: Location, history: History) {
    this.location = location;
    this.history = history;
  }

  get route(): WorkspaceRoute {
    return parseRoute(this.location.href);
  }

  navigate(route: WorkspaceRoute, options?: { replace?: boolean }): void {
    const url = serializeRoute(route);
    if (options?.replace) this.history.replaceState(null, "", url);
    else this.history.pushState(null, "", url);
    this.emit();
  }

  /** Patch parts of the current route, keeping the rest (and params). */
  patch(patch: Partial<Pick<WorkspaceRoute, "session" | "cwd" | "view">>, options?: { replace?: boolean }): void {
    this.navigate({ ...this.route, ...patch }, options);
  }

  onChange(listener: (route: WorkspaceRoute) => void): () => void {
    this.listeners.add(listener);
    listener(this.route);
    return () => this.listeners.delete(listener);
  }

  /** Wire popstate (back/forward); returns the disposer. */
  bind(): () => void {
    const onPopState = (): void => this.emit();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }

  private emit(): void {
    const route = this.route;
    for (const listener of [...this.listeners]) listener(route);
  }
}
