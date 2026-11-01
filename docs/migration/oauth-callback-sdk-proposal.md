# OAuth callback injection: SDK dependency proposal

This is a proposed upstream contract, not an implemented capability. The pinned
SDK has no callback injection in `AuthInteraction` or `LoginOptions`
(`@earendil-works/pi-ai/dist/auth/types.d.ts`). `Models.login` therefore cannot
make the built-in provider callbacks Rust-owned. Changing the installed SDK,
pre-occupying its ports, and claiming its manual fallback as host integration
are not acceptable substitutes. The first SDK release containing and exercising
this contract must be pinned and integrated before the provider migration gate
can close; no such version is known yet.

## Proposed upstream API

Add a per-login optional callback factory to `LoginOptions`, propagated through
`Models.login` to each built-in browser OAuth flow. Conceptually:

```ts
interface OAuthCallbackRequest<T> {
  providerName: string;
  host: string;
  redirectHost?: string;
  port: number;
  path: string;
  state?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  complete(code: string): Promise<T>;
}
interface OAuthCallbackHandle<T> {
  redirectUri: string;
  wait(): Promise<T | undefined>;
  cancel(): void;
  close(): void;
}
type OAuthCallbackFactory = <T>(request: OAuthCallbackRequest<T>) => Promise<OAuthCallbackHandle<T>>;
```

The SDK supplies its own path, port, optional state, completion function and
fallback decisions; the host binds and returns the actual URI before the SDK
publishes the authorization URL. The host must not generate a replacement PKCE
verifier or perform token exchange. `complete` preserves SDK-owned validation,
issuer/provider logic and token exchange, and the host must report completion
only after it resolves. Absence of `state` is meaningful: OpenRouter uses an
unguessable path instead. The implementation needs an asynchronous, task-bound
bridge to execute `complete` on the SDK side and report the result to the
waiting browser. Cancellation, deadline, child exit and manual input must
close the listener and revoke outstanding task/nonce associations. An injected
factory must never silently revert to the Node listener if binding fails.

Factory use should be explicit and per invocation, not a process-global monkey
patch. Existing non-injected SDK callers retain their current behavior. Native
listener host/path/port policy must be validated by Rust, and mismatches,
replays, expired task handles, and cross-flow messages rejected. The browser
response must not echo callback parameters or provider errors.

## Pinned provider contracts to retain

These are source observations, not authorization tests. Source paths are under
`node_modules/@earendil-works/pi-ai/dist/auth/oauth/`:

- `anthropic.js`: browser `localhost:53692/callback`, random-port fallback,
  verifier as state, manual redirect/code input; separate copy-code method.
- `openai-codex.js`: `localhost:1455/auth/callback`, generated state, manual
  redirect/code fallback; separate device-code method.
- `radius.js`: `127.0.0.1:1456/oauth/callback`, generated state, browser
  callback has no manual fallback; separate device-code method.
- `openrouter.js`: ephemeral port, `/oauth/callback/<UUID>`, no state,
  manual input; callback completion performs token exchange.
- `github-copilot.js`, `kimi-coding.js`, `meta.js`, `xai.js`, and
  `openai-chatgpt.js` must retain their own non-loopback/device or delegated
  login behavior; injection is not a reason to replace those flows.

`callback-server.js` currently owns Node HTTP and calls `complete` before
responding. A correct injected adapter preserves that ordering, all provider
login-method choices, manual input, errors, abort and auth-list refresh.

## Required contract fixtures before adoption

Use only isolated fake authorization servers and temporary credential stores:
fixed and ephemeral binding, occupied required/preferred port, exact path,
state and no-state randomized path, duplicate/replayed/late/cross-task callback,
provider denial, failed token exchange, manual-input race, cancellation,
timeout and child exit. Assert SDK PKCE, redirect URI and `complete` ordering,
as well as both provider-list refreshes. Verify no Node callback socket opens
when injection is present. Native default-browser handling needs separate
platform testing; fake fixtures do not establish it.

MCP has a separate SDK entry point: `pi-coding-agent/dist/extensions/mcp/oauth.js`
`signInMcpServer` currently creates its own listener. The public
`@earendil-works/pi-mcp/oauth` exports `McpOAuthProvider` and `authorizeMcp`, so
an approved repository adapter can reuse those protocol primitives while Rust
owns the listener. It must retain the SDK entry point's registration reuse,
CIMD issuer/mix-up defense, configured callback and port policy, refresh,
request timeout, scope, credential-store and cancellation behavior. No such
adapter is claimed by this document.
