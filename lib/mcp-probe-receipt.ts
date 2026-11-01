import type { McpSignInWriteGuard } from "./mcp-sign-out";

/** Private host receipt: none of these fields proves other processes or the remote server are idle. */
export interface McpProbeReceipt {
  schema: 1;
  localWritesClosed: boolean;
  pastLocal: "settled" | "unknown";
  remoteToken: "none-observed" | "unknown";
}

/** One probe's credential-store fence, independent of canonical sign-out generation. */
export class McpProbeCredentialFence {
  private closed = false;
  private pastUnknown = false;
  private unsupportedAsync = false;
  private tokenObserved = false;

  guard(canonical?: McpSignInWriteGuard): McpSignInWriteGuard {
    return () => {
      if (this.closed) throw new Error("MCP probe credential access is closed");
      canonical?.();
    };
  }

  /** Called only after guard passed, immediately around an SDK store operation. */
  storeCall<T>(call: () => T): T {
    try {
      const value = call();
      if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
        // A deferred write can escape a synchronous guard; it is not proof.
        this.unsupportedAsync = true;
        this.pastUnknown = true;
      }
      return value;
    } catch (error) {
      this.pastUnknown = true;
      throw error;
    }
  }

  refresh(active: boolean): void {
    if (active) this.tokenObserved = true;
  }

  close(): McpProbeReceipt {
    this.closed = true;
    return { schema: 1, localWritesClosed: !this.unsupportedAsync, pastLocal: this.pastUnknown ? "unknown" : "settled", remoteToken: this.tokenObserved ? "unknown" : "none-observed" };
  }
}
