# Proposed session-action SDK contract (not implemented)

The static host still rejects branch summaries and their Stop. These notes and
`lib/pi-rpc/session-action-contract.test.mjs` describe an isolated contract
fixture, **not** production support, an SDK patch, or provider/UI acceptance.
The Next host remains unchanged. SDK distribution and this proposal require
approval; do not modify the shared installed SDK.

## Verified boundary

In the installed SDK, `core/extensions/types.d.ts` exposes
`ExtensionCommandContext.navigateTree(targetId, { summarize,
customInstructions, replaceInstructions, label })`, returning only
`{ cancelled }`. `ExtensionContext.abort()` is a general agent abort; neither
context exposes `AgentSession.abortBranchSummary()`. The latter is public on
`AgentSession` (`core/agent-session.d.ts`). `modes/rpc/rpc-mode.js` binds
`navigateTree` to that session but discards every result field except
`cancelled`. Its JSONL reader dispatches input concurrently. RPC `abort` calls
`session.abort()`, which also aborts retry, compaction and the agent. A late
unscoped abort can therefore affect another operation; it is not a safe
implementation of Stop for one identified summary.

RPC binds command-context `newSession`, `fork`, and `switchSession` directly to
`AgentSessionRuntime`, which replaces the child runtime in place
(`core/agent-session-runtime.js`). The static host registry associates a child
with its original id; silently replacing that child breaks its identity. The
Next host's `createExtensionCommandContextActions` instead keeps the source and
creates/resolves a separate target, emitting `session_replaced` on success.
Callbacks such as `setup` and `withSession` contain executable extension code:
they cannot simply be serialized into an RPC request or approximated by a
confirmation dialog.

## Minimal patch boundary for approval

1. In SDK RPC mode, add a session-owned, atomically registered navigation
   operation identified by a host-generated unique request id. It must forward
   all navigation options to the same `AgentSession.navigateTree`, retain its
   actual cancellation/abort outcome, and remove registration on every exit.
   Register before work can race a Stop. The current `navigateTree` creates its
   controller internally after initial checks; RPC registration alone cannot
   abort a Stop arriving before controller creation. Extend that API to accept
   an operation-owned signal (or equivalent atomic registration), and check it
   before committing the leaf, including extension-provided summaries and empty
   branches. Reject concurrent navigation and reused ids; never infer successful
   cancellation from a timeout or transport loss.
2. Add `abort_branch_summary` with that request id. The SDK checks the current
   registration and calls `AgentSession.abortBranchSummary()` only while it still
   identifies that exact operation. Return `matched: false` for completed,
   unknown or old ids. `matched: true` means the abort was requested, not that
   the provider has settled; the navigation's eventual response must report
   actual `cancelled` and `aborted`. Completion and cancellation are linearized
   in the child. A late Stop must never affect another summary or agent run.
   Preserve real `branch_summary` creation, active leaf, custom instructions,
   provider failures and queued messages through the SDK's own navigation.
3. Add an explicit host-delegation hook for command-context session actions,
   preserving cancellation hooks, target initialization (`setup`), and target
   `withSession` callbacks. This needs a concrete SDK-owned mechanism for
   executing callbacks against the *target* session, not JSON serialization of
   functions. Host acceptance must enforce the existing source/target writer
   gates, emit `session_replaced` only after successful target setup, and retain
   the source until the requesting command finishes. Failure or lost transport
   is not success and must not trigger an automatic mutation retry. The exact
   callback transport/lifetime is unresolved and requires an SDK design, not a
   claim that a result event alone implements delegation.

The likely SDK source touchpoints are `modes/rpc/rpc-mode.ts` and RPC command /
response types, plus extension runtime binding for the delegation hook. The
host touchpoints are `src-tauri/src/session_actions.rs`, `pi_ipc.rs`, the
session-host child protocol and `lib/pi-rpc/assets/pi-web-bridge.mjs`; precise
wiring depends on the approved distribution/API. Public declarations and tests
must ship with the same reproducibly sourced, versioned and hash-verified SDK
build used by packaging. No alternate SDK tree is provided by this proposal.

Acceptance requires delayed fake-provider integration against the patched actual
SDK, asserting persisted summary and instructions, leaf and queue preservation,
stop-before-completion, completion-before-stop, stale-id isolation, failures,
and host delegation including `setup`/`withSession` and before-event vetoes.
The small model fixture covers only ordering expectations, not those integrations.
