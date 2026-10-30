/**
 * Session event stream factory: the ONE place the UI creates the events
 * connection for an agent session. The Next app builds the SSE source
 * (GET /api/agent/[id]/events); the static-frontend build aliases this
 * module to the typed IPC Channel adapter (docs/migration/ipc-protocol.md
 * — no EventSource in production, no global patching: a factory the
 * consumers already inject).
 */

import type { AgentEventSourceLike } from "./agent-event-connection";

export function createSessionEventSource(sessionId: string): AgentEventSourceLike {
  return new EventSource(`/api/agent/${encodeURIComponent(sessionId)}/events`);
}
