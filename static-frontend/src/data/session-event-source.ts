/**
 * The static build's session event source (aliases lib/session-event-source):
 * the typed IPC Channel stream (agent.subscribeEvents over
 * pi_ipc_subscribe_events) adapted to the AgentEventSourceLike interface the
 * connection layer already consumes.
 *
 * Frame protocol (docs/migration/ipc-protocol.md §3): the FIRST frame is the
 * host's snapshot (kind "snapshot", payload {epoch, settledEpoch, state}) —
 * it is NOT an AgentEvent. It is consumed here to synthesize the `connected`
 * AgentEvent the SSE stream's first data event carried
 * (lib/agent-event-stream.ts): {type:"connected", sessionId, isStreaming,
 * pendingExtensionUiIds}. Child records follow in arrival order as
 * kind "event" frames whose payload IS one AgentEvent record.
 */

import type { AgentEventSourceLike } from "../../../lib/agent-event-connection";
import { IpcClient } from "../ipc/client.ts";
import type { IpcStreamMessage } from "../ipc/protocol.ts";
import { detectTransport } from "./transport.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

interface SnapshotPayload {
  epoch?: number;
  settledEpoch?: number;
  /** Outstanding child UI requests at subscription time (the SSE `connected`
   * contract: the client drops dialogs the session no longer holds). */
  pendingExtensionUiIds?: unknown[];
  state?: {
    sessionId?: string;
    isStreaming?: boolean;
  };
}

export function createSessionEventSource(sessionId: string): AgentEventSourceLike {
  // One client per source: the subscription is the source's whole life.
  const client = new IpcClient(detectTransport().transport);
  let readyState = CONNECTING;
  let disposed = false;
  let detach: (() => void) | null = null;
  let seenSeq = 0;
  let epoch = 0;
  let invalidated = false;

  const source: AgentEventSourceLike = {
    get readyState() {
      return readyState;
    },
    set readyState(value: number) {
      readyState = value;
    },
    onmessage: null,
    onerror: null,
    close() {
      if (disposed) return;
      disposed = true;
      readyState = CLOSED;
      // The transport's disposer ALSO unsubscribes host-side (the relay
      // thread and the session subscriber are reaped, not leaked).
      detach?.();
      detach = null;
    },
  };

  const deliver = (event: Record<string, unknown>) => {
    source.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }) as MessageEvent<string>,
    );
  };

  detach = client.subscribe<IpcStreamMessage>(
    "agent.subscribeEvents",
    { session: sessionId },
    (frame: IpcStreamMessage) => {
      if (disposed || invalidated) return;
      // The frame epoch is the STREAM GENERATION (protocol doc: 宿主纪元
      // ——宿主重启/重置后递增). Within one subscription the host never
      // changes it; a frame that does is a RESET signal, never a reason to
      // quietly re-base the sequence numbers (an epoch bump means the
      // stream identity changed — the consumer's incremental view is
      // unreliable and must re-snapshot, which the connection layer's
      // reconnect models). A frame from an OLDER epoch is stale: drop it.
      if (frame.epoch !== epoch) {
        if (epoch === 0) {
          // The first frame establishes the generation.
          epoch = frame.epoch;
        } else if (frame.epoch < epoch) {
          return; // stale frame from a previous generation
        } else {
          // A NEW generation mid-stream: the stream identity changed, the
          // incremental view is unreliable — surface as an error → close →
          // reconnect (the new subscription's snapshot re-synchronizes).
          invalidated = true;
          source.onerror?.(new Event("error"));
          return;
        }
      }
      // Replays are harmless; a missing frame is not. Refuse the remainder
      // until reconnect obtains a new snapshot instead of silently skipping it.
      if (frame.seq <= seenSeq) return;
      if (frame.seq !== seenSeq + 1 || (seenSeq === 0 && frame.kind !== "snapshot")) {
        invalidated = true;
        source.onerror?.(new Event("error"));
        return;
      }
      seenSeq = frame.seq;

      if (frame.kind === "snapshot") {
        // The snapshot is NOT an event: it opens the stream with the
        // `connected` AgentEvent the connection layer's handshake waits for
        // (lib/agent-event-stream.ts's first data event carried exactly
        // this shape — the UI's dialog reconciliation reads
        // pendingExtensionUiIds and the streaming flag here).
        const snapshot = (frame.payload ?? {}) as SnapshotPayload;
        const state = snapshot.state ?? {};
        readyState = OPEN;
        deliver({
          type: "connected",
          sessionId: typeof state.sessionId === "string" ? state.sessionId : sessionId,
          isStreaming: state.isStreaming === true,
          ...(Array.isArray(snapshot.pendingExtensionUiIds)
            ? { pendingExtensionUiIds: snapshot.pendingExtensionUiIds }
            : {}),
        });
        return;
      }
      if (frame.kind === "reset") {
        // A reset means the consumer's incremental view is unreliable: the
        // connection layer models this as an error → close → reconnect with
        // a fresh subscription (whose snapshot re-synchronizes it).
        invalidated = true;
        source.onerror?.(new Event("error"));
        return;
      }
      readyState = OPEN;
      const record = frame.payload;
      if (typeof record !== "object" || record === null) return;
      deliver(record as Record<string, unknown>);
    },
    () => {
      if (disposed) return;
      source.onerror?.(new Event("error"));
    },
  );

  return source;
}
