/**
 * The static build's session event source (aliases lib/session-event-source):
 * the typed IPC Channel stream (agent.subscribeEvents over
 * pi_ipc_subscribe_events) adapted to the AgentEventSourceLike interface the
 * connection layer already consumes — frames arrive as
 * {subscriptionId, epoch, seq, kind, payload}; each event payload is one
 * agent event record (the SSE `data:` body).
 */

import type { AgentEventSourceLike } from "../../../lib/agent-event-connection";
import { IpcClient } from "../ipc/client.ts";
import type { IpcStreamMessage } from "../ipc/protocol.ts";
import { detectTransport } from "./transport.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

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
      detach?.();
      detach = null;
    },
  };

  detach = client.subscribe<unknown>(
    "agent.subscribeEvents",
    { session: sessionId },
    (frame: IpcStreamMessage) => {
      if (disposed) return;
      // Reset semantics: the consumer re-snapshots through its own state
      // fetch; a reset frame surfaces as an error → reconnect cycle, which
      // the connection layer already models.
      if (frame.kind === "reset") {
        source.onerror?.(new Event("error"));
        return;
      }
      // Ordering: per subscription the seq is monotonic; the snapshot frame
      // (seq 1) opens the stream.
      if (frame.seq <= seenSeq && frame.epoch === epoch) return;
      seenSeq = frame.seq;
      epoch = frame.epoch;
      readyState = OPEN;
      const record = frame.payload;
      const text = typeof record === "string" ? record : JSON.stringify(record);
      source.onmessage?.(
        new MessageEvent("message", { data: text }) as MessageEvent<string>,
      );
    },
    () => {
      if (disposed) return;
      source.onerror?.(new Event("error"));
    },
  );

  return source;
}
