# Prompt completion correlation: missing upstream contract

The Rust host records each host-submitted prompt before sending it, its RPC
response, and uncorrelated `agent_start` / `agent_settled` observations. An
ordinary `started` or `queued` acknowledgement remains unresolved even after
an untagged terminal event: neither event identifies the submission, and a
previous run, a queued continuation, or an extension may produce it. The
in-memory receipt survives replacement of a session child within this host,
but not a host crash. A synchronous `handled` response establishes only that
the synchronous RPC handler returned; it does not prove arbitrary extension
background work stopped. Leader exit is a separate fact, not prompt success.

To correlate ordinary submissions without inventing an AgentSession, the
public upstream RPC/SDK contract would need, at minimum:

1. A caller-generated opaque submission ID accepted by prompt/steer/follow-up
   admission and echoed in the acknowledgement and any definitive refusal.
2. A documented association from that submission ID to the run(s) that
   actually consume it, including queued, steered and follow-up messages.
3. A terminal receipt naming the submission ID and its outcome, emitted only
   once the SDK has finished the corresponding logical work, including retry,
   compaction and queued continuations; a dropped connection or process exit
   must remain unknown rather than producing such a receipt.
4. Explicit attribution for extension-originated runs, or a separate marker
   that they are not associated with a host submission. Ordering or a marker
   command alone is not an attribution guarantee.
5. Clear persistence/replay semantics across transport loss, plus a boundary
   stating whether child process descendants and extension side effects are
   included. Neither should be presumed covered by a prompt receipt.

These are requirements for an upstream decision, not a claim that the current
SDK provides them. No installed SDK patch, token relabelling, or automatic
recovery is implemented here. Cross-restart recovery and durable unknown
prompt receipts remain separate work; no receipt grants maintenance or deletion
permission.
