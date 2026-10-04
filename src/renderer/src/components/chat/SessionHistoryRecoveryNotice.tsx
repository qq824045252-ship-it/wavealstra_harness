import type { SessionHistoryRecoveryDto } from "@shared/agent-ipc";

export default function SessionHistoryRecoveryNotice({ recovery }: { recovery?: SessionHistoryRecoveryDto }): React.JSX.Element | null {
  if (!recovery) return null;
  return <section className="conversation-runtime-card interaction-card task-recovery-notice" aria-label="会话历史恢复" role="status">
    <h3>历史已恢复，但会话文件需要检查</h3>
    <p>{recovery.message}</p>
    <details>
      <summary>恢复详情</summary>
      <p>异常记录：{recovery.invalidRecords}{recovery.firstInvalidLine ? ` · 首条异常位于第 ${recovery.firstInvalidLine} 行` : ""}</p>
      <p>{recovery.tailOnly ? "异常仅位于文件尾部。" : "文件中间存在异常记录；可读历史已保留。"}</p>
    </details>
  </section>;
}