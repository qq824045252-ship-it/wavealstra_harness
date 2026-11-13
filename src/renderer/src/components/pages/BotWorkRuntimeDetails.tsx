import type { WorkProjectionDto } from "@shared/bot-work";

export function BotWorkRuntimeDetails({ work }: { work: WorkProjectionDto }): React.JSX.Element {
  return <>
    <details><summary>输入与产物版本</summary><p>输入 {work.inputSnapshotId}</p><p>产物 {work.phase3?.artifactSnapshotId ?? "无文件产物"}</p></details>
    {work.phase4 && <section aria-label="关注与离线">
        <h3>关注与运行</h3>
        <p>{work.phase4.host.online ? "运行服务在线" : "运行服务离线，持续关注当前不可用"}
          {work.phase4.host.lastScanAt ? ` · 最近调度扫描 ${new Date(work.phase4.host.lastScanAt).toLocaleString()}` : " · 尚无调度扫描记录"}
          {work.phase4.host.suspendEvidence ? ` · 休眠证据 ${work.phase4.host.suspendEvidence}` : ""}</p>
        <p>承诺期限 {work.phase4.deadlineAt ? new Date(work.phase4.deadlineAt).toLocaleString() : "未设置"}（第 {work.phase4.deadlineRevision} 版）</p>
        {work.phase4.subscriptions.map(subscription => <article key={subscription.subscriptionId}>
          <strong>{subscription.source} · {subscription.targetKey ?? "默认目标"} · {{ online: "在线", paused: "暂停积压", offline: "宿主离线", stopped: "已停止", closing: "结算中" }[subscription.status]}</strong>
          <p>策略 {{ latest: "合并为最新一次", each: "逐条处理", skip: "跳过积压" }[subscription.catchUpPolicy]} · 时区 {subscription.timezone ?? "默认"} · 规则 r{subscription.scheduleRevision} · 配置 r{subscription.configRevision}</p>
          <p>下一唤醒 {subscription.nextWakeAt ? new Date(subscription.nextWakeAt).toLocaleString() : "无"} · 最近检查 {subscription.lastCheckedAt ? new Date(subscription.lastCheckedAt).toLocaleString() : "无"}</p>
          <p>队列待处理 {subscription.queue.ready} · 已冻结 {subscription.queue.frozen} · 受阻 {subscription.queue.blocked} / 上限 {subscription.queue.maxEvents} 条 · {subscription.queue.bytes}/{subscription.queue.maxBytes} 字节
            {subscription.queue.mergeDeadlineAt ? ` · 固定合并截止 ${new Date(subscription.queue.mergeDeadlineAt).toLocaleString()}` : ""}
            {subscription.queue.waitReason ? ` · ${subscription.queue.waitReason}` : ""}</p>
          {subscription.cursors.map(cursor => <p key={`${cursor.source}:${cursor.targetKey}`}>目标 {cursor.targetKey} · 已接纳 {cursor.highestAcceptedVersion ?? "无"} · 已消费 {cursor.highestConsumedVersion ?? "无"} · 已冻结 {cursor.highestFrozenVersion ?? "无"}</p>)}
        </article>)}
        <h3>离线补处理</h3>
        {work.phase4.offlineGaps.length === 0 ? <p>没有记录的离线缺口。</p> : work.phase4.offlineGaps.map(gap => <article key={gap.gapId}>
          <p>{new Date(gap.offlineGapFrom).toLocaleString()} ~ {new Date(gap.offlineGapTo).toLocaleString()} · 依据 {gap.detectedBy} / {gap.confidence === "evidence" ? "有证据" : "推断"}
            · 策略 {{ latest: "合并为最新一次", each: "逐条处理", skip: "跳过积压" }[gap.policy]} · {{ open: "待恢复", recovering: "恢复中", recovered: "已恢复", unqueryable: "不可回查" }[gap.state]}</p>
          <p>已补 {gap.recoveredCount} · 已合并 {gap.mergedCount} · 已跳过 {gap.skippedCount} · 未知 {gap.unknownCount ?? "未统计"}{gap.gapReason ? ` · ${gap.gapReason}` : ""}</p>
        </article>)}

        <h3>因果准入</h3>
        {work.phase4.causal.length === 0 ? <p>尚无因果准入记录。</p> : <details><summary>最近 {work.phase4.causal.length} 次准入</summary>
          {work.phase4.causal.map(item => <p key={item.chainId}>{item.decision === "admitted" ? "已准入" : "已拦截"} · 深度 {item.depth} · 互调 {item.hops} 跳 · 派发 {item.dispatchCount} · {item.reasonCode ?? item.rootEventId}</p>)}
        </details>}
    </section>}
  </>;
}
