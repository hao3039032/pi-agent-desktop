/**
 * The static app's desktop-connection probe (the vite alias for
 * `@/lib/desktop-connection`).
 *
 * The Next app's hook asked the packaged HTTP server (`/api/home`) whether
 * it was alive. The static app HAS no HTTP server — probing /api/home there
 * always failed and painted a permanent fake "offline" reconnect banner.
 * The static app's host IS the IPC bridge, so "is the server alive" is
 * answered by a real host round trip: `desktop.identity` (the op the host
 * answers before any pi child exists).
 *
 * offline therefore means exactly one thing here: the host bridge did not
 * answer the identity probe within the timeout (a wedged host, not a
 * missing HTTP listener). Retry reloads the page — the reconnect path that
 * re-establishes every IPC subscription, the equivalent of the Next app
 * recreating its HTTP/SSE connections. There is no local server to
 * relaunch: the host process owns the window's lifetime.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { IpcClient } from "../ipc/client.ts";
import { detectTransport } from "./transport.ts";

export type DesktopConnectionState = "online" | "offline" | "checking";

const PING_INTERVAL_MS = 8_000;
const OFFLINE_THRESHOLD = 2;
const PROBE_TIMEOUT_MS = 4_000;

// The bound client (app-main binds every domain to the ONE transport before
// the tree mounts; tests inject a MockTransport).
let boundClient: IpcClient | null = null;

export function bindDesktopConnection(client: IpcClient): void {
  boundClient = client;
}

function clientForProbe(): IpcClient {
  if (boundClient) return boundClient;
  return new IpcClient(detectTransport().transport);
}

/** The shared identity probe: one real host round trip, bounded. */
export async function probeHostIdentity(): Promise<boolean> {
  try {
    await clientForProbe().request("desktop.identity", undefined, { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export function useDesktopConnection(enabled = true): {
  state: DesktopConnectionState;
  retry: () => void;
} {
  const [state, setState] = useState<DesktopConnectionState>(enabled ? "checking" : "online");
  const failuresRef = useRef(0);
  const probeTokenRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const probe = useCallback(async (): Promise<boolean | null> => {
    if (!enabled || stoppedRef.current) return null;
    // Wake/online/timer events can arrive together after sleep. Only the
    // most recent probe may change state: each probe carries a token and
    // drops its result when a newer one started meanwhile (the Next hook's
    // stale-response guard, over a monotonic token instead of a promise
    // identity).
    const token = ++probeTokenRef.current;
    const reachable = await probeHostIdentity();
    if (stoppedRef.current || probeTokenRef.current !== token) return null;
    if (reachable) {
      failuresRef.current = 0;
      setState("online");
    } else {
      failuresRef.current += 1;
      if (failuresRef.current >= OFFLINE_THRESHOLD) {
        setState("offline");
      } else {
        setState((prev) => (prev === "offline" ? "offline" : "checking"));
      }
    }
    return reachable;
  }, [enabled]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!enabled || stoppedRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void probe().finally(() => schedule());
    }, PING_INTERVAL_MS);
  }, [enabled, probe]);

  const retry = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setState("checking");
    failuresRef.current = 0;
    void probe().then(async (reachable) => {
      if (stoppedRef.current || reachable === null) return;
      if (reachable) {
        // Re-establish every IPC subscription the same way the Next app
        // recreated its HTTP/SSE connections.
        window.location.reload();
        return;
      }
      // The host bridge is wedged. Nothing can be relaunched from here (the
      // host owns the window); stay honest and keep the banner.
      setState("offline");
      schedule();
    });
  }, [enabled, probe, schedule]);

  const checkNow = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    void probe().finally(() => schedule());
  }, [enabled, probe, schedule]);

  useEffect(() => {
    if (!enabled) {
      stoppedRef.current = true;
      return;
    }
    stoppedRef.current = false;
    checkNow();

    const onVisible = () => {
      if (document.visibilityState === "visible") checkNow();
    };
    const onOnline = () => checkNow();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      stoppedRef.current = true;
      probeTokenRef.current++; // any in-flight probe is now stale
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [checkNow, enabled]);

  return { state: enabled ? state : "online", retry };
}
