/**
 * The static-UI acceptance harness polyfill (test-only).
 *
 * Injected via playwright's addInitScript BEFORE the static bundle runs, it
 * implements the ONLY three entry points `@tauri-apps/api/core` touches
 * (verified against @tauri-apps/api 2.12.1's core.js):
 *
 * - `invoke(cmd, args, options)` — POST /__harness__/invoke. Arguments are
 *   JSON-serialized, which turns `Channel` instances into their official
 *   `__CHANNEL__:<id>` serialization; the Rust side rebuilds a real
 *   `Channel` around that callback id.
 * - `transformCallback(cb, once)` / `unregisterCallback(id)` — the callback
 *   registry the host addresses channel frames at. Channel frames arrive
 *   over the SSE stream below and are delivered as `{message, index}`
 *   envelopes, exactly what the Channel class in core.js expects.
 *
 * It is never part of the shipped bundle: the acceptance driver injects it
 * into the browser page, so the production build stays free of any
 * EventSource/polyfill code.
 */
(() => {
  if (window.__TAURI_INTERNALS__) return;
  // The bridge token the driver generated for THIS run: the harness refuses
  // invoke/events/shutdown without it (a cross-site page must not be able
  // to drive the real pi host). Missing token = fail loudly, not silently.
  const TOKEN = window.__STATIC_UI_HARNESS_TOKEN__;
  if (!TOKEN || typeof TOKEN !== "string") {
    throw new Error("static-ui-harness-polyfill: __STATIC_UI_HARNESS_TOKEN__ is missing");
  }
  let nextCallbackId = 1;

  // Channel frames (and nothing else) flow over one SSE stream per page.
  // EventSource cannot attach headers, so the token rides the query string.
  const events = new EventSource(`/__harness__/events?token=${encodeURIComponent(TOKEN)}`);

  // @tauri-apps/api 2.12.1's event API calls this on every unlisten (the
  // real Tauri injects it before the page runs); without it every teardown
  // throws. A no-op is faithful here: the harness drops the listener when
  // `plugin:event|unlisten` arrives.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  events.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame && frame.harness === "callback" && typeof frame.cb === "number") {
      const handler = window[`_${frame.cb}`];
      if (typeof handler === "function") handler(frame.payload);
    }
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback(callback, once = false) {
      const id = nextCallbackId++;
      const name = `_${id}`;
      window[name] = (payload) => {
        callback(payload);
        if (once) delete window[name];
      };
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    invoke(cmd, args, _options) {
      // JSON round-trip applies each Channel's toJSON (`__CHANNEL__:<id>`).
      const payload = JSON.parse(JSON.stringify(args ?? {}));
      const record = { cmd, at: Date.now() };
      (window.__harnessInvokes ??= []).push(record);
      return fetch("/__harness__/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-token": TOKEN },
        body: JSON.stringify({ cmd, args: payload }),
      }).then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || (body && body.harnessError)) {
          record.error = (body && body.harnessError) || `HTTP ${response.status}`;
          throw new Error(record.error);
        }
        record.done = Date.now();
        return body;
      });
    },
    convertFileSrc(filePath, protocol = "asset") {
      if (protocol === "pi-resource") return `/__harness__/resource/${filePath}`;
      return `${protocol}://localhost/${filePath}`;
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    plugins: {},
  };
})();
