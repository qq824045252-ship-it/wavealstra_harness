/** 任务持久化模型已被模型目录淘汰并自动替换：必须如实展示替换事实，不能静默换模型。 */
export default function TaskModelRecoveryNotice({ recovery }: { recovery?: { from: string; to: string } }): React.JSX.Element | null {
  if (!recovery) return null;
  return <section className="conversation-runtime-card interaction-card task-recovery-notice" aria-label="任务模型已替换" role="status">
    <h3>该任务原来的模型已下线，已改用 {recovery.to}</h3>
    <p>原模型 {recovery.from} 不在当前模型目录中。历史、工具与产物都保留；如需其它模型，可在输入框右侧重新选择。</p>
  </section>;
}
