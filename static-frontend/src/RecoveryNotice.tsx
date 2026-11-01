import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../hooks/useI18n";
import type { IpcClient } from "./ipc/client.ts";
import { readRecoveryStatus, type RecoveryStatus } from "./data/recovery-status.ts";

const messages = {
  en: { title: "Unresolved host operations", error: "Recovery status could not be checked.", detail: "Some operations may be blocked. Do not retry uncertain changes or remove recovery files. Recovery is not yet available.", trust: "Trust policy", sessions: "Session writer", deletion: "Session deletion", pending: "pending", uninspectable: "cannot inspect", refresh: "Check again" },
  "zh-CN": { title: "宿主存在未决操作", error: "无法检查恢复状态。", detail: "部分操作可能受阻。请勿重试结果不明的更改或删除恢复文件。目前尚不能执行恢复。", trust: "信任策略", sessions: "会话写入", deletion: "会话删除", pending: "未决", uninspectable: "无法检查", refresh: "重新检查" },
  "zh-TW": { title: "宿主存在未決操作", error: "無法檢查復原狀態。", detail: "部分操作可能受阻。請勿重試結果不明的變更或刪除復原檔案。目前尚不能執行復原。", trust: "信任策略", sessions: "工作階段寫入", deletion: "工作階段刪除", pending: "未決", uninspectable: "無法檢查", refresh: "重新檢查" },
};

/** Read-only: a status refresh never retries or clears a mutation. */
export function RecoveryNotice({ client }: { client: IpcClient }) {
  const { locale } = useI18n();
  const text = messages[locale];
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await readRecoveryStatus(client);
      if (generation.current === current) { setStatus(result); setError(false); }
    } catch {
      if (generation.current === current) setError(true);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { ++generation.current; clearInterval(timer); };
  }, [refresh]);
  const entries = status ? [
    [text.trust, status.trustPolicy], [text.sessions, status.sessionWriters], [text.deletion, status.deletionJournal],
  ] as const : [];
  const unresolved = entries.filter(([, value]) => value !== "clear");
  if (!error && unresolved.length === 0) return null;
  return <aside className="recovery-notice" role="alert">
    <strong>{text.title}</strong>
    {error && <p>{text.error}</p>}
    {unresolved.length > 0 && <ul>{unresolved.map(([label, value]) => <li key={label}>{label}: {value === "pending" ? text.pending : text.uninspectable}</li>)}</ul>}
    <p>{text.detail}</p>
    <button type="button" onClick={() => void refresh()}>{text.refresh}</button>
  </aside>;
}
