import type { IpcClient } from "../ipc/client.ts";

export type PendingState = "clear" | "pending" | "uninspectable";
export interface RecoveryStatus {
  trustPolicy: PendingState;
  sessionWriters: PendingState;
  deletionJournal: PendingState;
  managementOperations: PendingState;
}

export async function readRecoveryStatus(client: IpcClient): Promise<RecoveryStatus> {
  const value = await client.request<unknown>("desktop.recoveryStatus", undefined, { timeoutMs: 5_000 });
  if (value === null || typeof value !== "object") throw new Error("Invalid recovery status");
  const record = value as Record<string, unknown>;
  const valid = (item: unknown): item is PendingState => item === "clear" || item === "pending" || item === "uninspectable";
  if (!valid(record.trustPolicy) || !valid(record.sessionWriters) || !valid(record.deletionJournal) || !valid(record.managementOperations)) {
    throw new Error("Invalid recovery status");
  }
  return { trustPolicy: record.trustPolicy, sessionWriters: record.sessionWriters, deletionJournal: record.deletionJournal, managementOperations: record.managementOperations };
}
