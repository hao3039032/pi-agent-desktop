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
      if (disposed) return;
      // Ordering: per subscription the seq is monotonic. A frame from an
      // older epoch or a replayed seq is stale; a NEW epoch re-baselines.
      if (frame.epoch !== epoch) {
        epoch = frame.epoch;
        seenSeq = 0;
      }
      if (frame.seq <= seenSeq) return;
      seenSeq = frame.seq;

      if (frame.kind === "snapshot") {
        // The snapshot is NOT an event: it opens the stream with the
        // `connected` AgentEvent the connection layer's handshake waits for
        // (never surface the host's frame as an AgentEvent — the UI would
        // treat an unknown record as a protocol event and drop it noisily).
        const snapshot = (frame.payload ?? {}) as SnapshotPayload;
        const state = snapshot.state ?? {};
        readyState = OPEN;
        deliver({
          type: "connected",
          sessionId: typeof state.sessionId === "string" ? state.sessionId : sessionId,
          isStreaming: state.isStreaming === true,
        });
        return;
      }
      if (frame.kind === "reset") {
        // A reset means the consumer's incremental view is unreliable: the
        // connection layer models this as an error → close → reconnect with
        // a fresh subscription (whose snapshot re-synchronizes it).
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
