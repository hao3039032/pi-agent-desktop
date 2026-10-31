export interface PendingComposerMessage {
  id: string;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /**
   * This item's last delivery ended UNKNOWN (a timeout, a lost transport or
   * a child exit after the prompt may have reached it). It is never
   * re-delivered automatically — a resend needs the user's explicit
   * confirmation after checking the session.
   */
  unknown?: boolean;
}

export interface ComposerQueueSnapshot {
  pending?: PendingComposerMessage[];
  pendingVersion?: number;
  /** The front item is parked as outcome-unknown (see PendingComposerMessage.unknown). */
  frontDeliveryUnknown?: boolean;
}

export interface ComposerQueueActionResult extends ComposerQueueSnapshot {
  item: PendingComposerMessage | null;
}

/** A delayed HTTP snapshot must not resurrect entries already removed by SSE. */
export function mergeComposerQueueSnapshot(previous: ComposerQueueSnapshot, next: ComposerQueueSnapshot): ComposerQueueSnapshot {
  if (next.pendingVersion !== undefined && previous.pendingVersion !== undefined && next.pendingVersion < previous.pendingVersion) {
    return { pending: previous.pending, pendingVersion: previous.pendingVersion, frontDeliveryUnknown: previous.frontDeliveryUnknown };
  }
  return {
    pending: next.pending ?? [],
    pendingVersion: next.pendingVersion,
    frontDeliveryUnknown: next.frontDeliveryUnknown === true,
  };
}
