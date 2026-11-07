import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, RefreshCw, X } from 'lucide-react'
import type { RemoteClient } from '../api/RemoteClient'
import type { RemoteWorkSummary } from '@mybuddy/shared'
import { useRemoteWorkStore } from '../store/remoteWork'

/**
 * Mobile Work surface: the decision view plus addressable cards.
 *
 * Reads come from the host journal (never from an SSE payload), reads mark only the card,
 * and a resend is an explicit duplicate-risk action the user must confirm.
 */
export function WorkPanelLauncher({ client }: { client: RemoteClient }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="work-launcher" onClick={() => setOpen(true)} aria-label="Bot 事项">
        Bot
      </button>
      {open && <WorkPanel client={client} onClose={() => setOpen(false)} />}
    </>
  )
}

function WorkPanel({ client, onClose }: { client: RemoteClient; onClose: () => void }) {
  const { works, selectedWorkId, includeClosed, loading, error } = useRemoteWorkStore()
  const setSelectedWork = useRemoteWorkStore(state => state.setSelectedWork)
  const setIncludeClosed = useRemoteWorkStore(state => state.setIncludeClosed)
  const refresh = useRemoteWorkStore(state => state.refresh)
  const selected = useMemo(() => works.find(work => work.workId === selectedWorkId), [works, selectedWorkId])

  useEffect(() => { void refresh(client) }, [client, refresh, includeClosed])

  return (
    <div className="work-overlay" role="dialog" aria-modal="true">
      <header className="work-header">
        <button type="button" className="work-icon-button" onClick={() => selectedWorkId ? setSelectedWork(null) : onClose()}
          aria-label={selectedWorkId ? '返回' : '关闭'}>
          {selectedWorkId ? <ChevronRight size={18} style={{ transform: 'rotate(180deg)' }} /> : <X size={18} />}
        </button>
        <div className="work-title">{selected?.title ?? 'Bot 事项'}</div>
        <button type="button" className="work-icon-button" onClick={() => void refresh(client)} aria-label="刷新">
          <RefreshCw size={16} className={loading ? 'work-spin' : undefined} />
        </button>
      </header>

      {!selected && (
        <div className="work-body">
          <label className="work-toggle">
            <input type="checkbox" checked={includeClosed} onChange={event => setIncludeClosed(event.target.checked)} />
            显示已结束
          </label>
          {error && <div className="work-error">{error}</div>}
          {works.length === 0 && !loading && <div className="work-empty">暂无事项</div>}
          {works.map(work => (
            <button type="button" key={work.workId} className="work-row" onClick={() => setSelectedWork(work.workId)}>
              <div className="work-row-main">
                <span className="work-row-title">{work.title}</span>
                <span className="work-row-step">{work.nextSteps[0] ?? lifecycleLabel(work.lifecycle)}</span>
              </div>
              <div className="work-row-meta">
                <span className={`work-badge work-badge-${work.lifecycle}`}>{lifecycleLabel(work.lifecycle)}</span>
                <span className="work-row-cards">{work.cards.length} 张卡片</span>
                <ChevronRight size={16} />
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && <WorkDetail client={client} work={selected} />}
    </div>
  )
}

function WorkDetail({ client, work }: { client: RemoteClient; work: RemoteWorkSummary }) {
  const markCardRead = useRemoteWorkStore(state => state.markCardRead)
  const submitFeedback = useRemoteWorkStore(state => state.submitFeedback)
  const resendNotification = useRemoteWorkStore(state => state.resendNotification)
  const loadDiagnostics = useRemoteWorkStore(state => state.loadDiagnostics)
  const diagnostics = useRemoteWorkStore(state => state.diagnostics[work.workId]) as
    | { acceptance?: { items: unknown[]; truncated: boolean }; executions?: { items: unknown[]; truncated: boolean };
        delivery?: { items: unknown[]; truncated: boolean } } | undefined
  const [environment, setEnvironment] = useState('')
  const [sourceRef, setSourceRef] = useState('')
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const criterion = work.unverifiedScope.find(entry => entry.reason !== 'auto_verified')

  return (
    <div className="work-body">
      <section className="work-section">
        {work.goal && <p className="work-goal">{work.goal}</p>}
        <div className="work-meta">r{work.intentRevision} · 负责人代次 {work.ownerEpoch} · {lifecycleLabel(work.lifecycle)}</div>
        {work.currentConclusion && <div className="work-conclusion">{work.currentConclusion}</div>}
        {work.nextSteps.length > 0 && (
          <ul className="work-list">
            {work.nextSteps.map(step => <li key={step}>{step}</li>)}
          </ul>
        )}
        {work.pendingUserDecisions.length > 0 && (
          <div className="work-decisions">
            <strong>需要你决定</strong>
            <ul className="work-list">{work.pendingUserDecisions.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="work-section">
        <h3 className="work-section-title">未验证范围</h3>
        {work.unverifiedScope.length === 0 && <div className="work-empty">没有待验证项</div>}
        {work.unverifiedScope.map(entry => (
          <div key={entry.criterionId} className="work-criterion">
            <span>{entry.text}</span>
            <span className={`work-badge work-badge-${entry.reason}`}>{reasonLabel(entry.reason)}</span>
          </div>
        ))}
      </section>

      <section className="work-section">
        <h3 className="work-section-title">结果卡片</h3>
        {work.cards.map(card => (
          <div key={card.cardKey} className={`work-card ${card.currency !== 'current' ? 'work-card-historical' : ''}`}>
            <div className="work-card-head">
              <span className="work-card-title">{card.title}</span>
              {card.currency !== 'current' && <span className="work-badge work-badge-historical">{card.currency === 'superseded' ? '已失效' : '历史'}</span>}
            </div>
            <p className="work-card-body">{card.summary}</p>
            {card.unverifiedScope.length > 0 && (
              <div className="work-card-scope">未验证：{card.unverifiedScope.join('、')}</div>
            )}
            <div className="work-card-foot">
              <span>r{card.intentRevision} · {card.deliverables.length} 个成果</span>
              {card.readAt
                ? <span className="work-read-ok"><Check size={14} /> 已读</span>
                : <button type="button" className="work-link" onClick={() => void markCardRead(client, work.workId, card.semanticCardKey)}>标记已读</button>}
            </div>
          </div>
        ))}
        {work.cards.length === 0 && <div className="work-empty">还没有验收成果</div>}
      </section>

      {criterion && (
        <section className="work-section">
          <h3 className="work-section-title">提交实测反馈</h3>
          <div className="work-meta">绑定当前版本 r{work.intentRevision} · {work.inputSnapshotId}</div>
          <input className="work-input" placeholder="环境，例如 omarchy" value={environment}
            onChange={event => setEnvironment(event.target.value)} />
          <input className="work-input" placeholder="被测版本，例如 omarchy:d6151a8" value={sourceRef}
            onChange={event => setSourceRef(event.target.value)} />
          {feedbackError && <div className="work-error">{feedbackError}</div>}
          <div className="work-actions">
            <button type="button" className="work-button" disabled={busy || !environment.trim() || !sourceRef.trim()}
              onClick={async () => {
                setBusy(true); setFeedbackError(null)
                try {
                  const result = await submitFeedback(client, work.workId, {
                    operationId: `phone-feedback-${Date.now()}`, criterionIds: [criterion.criterionId],
                    environment: environment.trim(), sourceRef: sourceRef.trim(),
                    inputSnapshotId: work.inputSnapshotId, failed: false,
                  })
                  if (!result.ok) setFeedbackError(result.message ?? '反馈未被接受')
                  else await useRemoteWorkStore.getState().refresh(client)
                } finally { setBusy(false) }
              }}>
              实测通过
            </button>
            <button type="button" className="work-button work-button-danger" disabled={busy || !environment.trim() || !sourceRef.trim()}
              onClick={async () => {
                setBusy(true); setFeedbackError(null)
                try {
                  const result = await submitFeedback(client, work.workId, {
                    operationId: `phone-feedback-fail-${Date.now()}`, criterionIds: [criterion.criterionId],
                    environment: environment.trim(), sourceRef: sourceRef.trim(),
                    inputSnapshotId: work.inputSnapshotId, failed: true,
                  })
                  if (!result.ok) setFeedbackError(result.message ?? '反馈未被接受')
                  else await useRemoteWorkStore.getState().refresh(client)
                } finally { setBusy(false) }
              }}>
              实测失败
            </button>
          </div>
        </section>
      )}

      <section className="work-section">
        <h3 className="work-section-title">外部通知</h3>
        {work.delivery.length === 0 && <div className="work-empty">还没有通知意图</div>}
        {work.delivery.map(item => (
          <div key={item.notificationId} className="work-delivery">
            <span>{deliveryLabel(item.externalStatus)}</span>
            <span className="work-meta">{item.attemptCount} 次尝试</span>
            {item.state === 'unknown' && (
              <button type="button" className="work-link" onClick={async () => {
                if (!window.confirm('原投递可能已经送达，重发可能造成重复。确认重发？')) return
                await resendNotification(client, work.workId, item.notificationId, '手机端确认重发')
                await useRemoteWorkStore.getState().refresh(client)
              }}>重发</button>
            )}
          </div>
        ))}
      </section>

      <section className="work-section">
        <button type="button" className="work-link" onClick={() => void loadDiagnostics(client, work.workId)}>
          {diagnostics ? '刷新诊断' : '查看诊断'}
        </button>
        {diagnostics && (
          <div className="work-diagnostics">
            <div>验收 {diagnostics.acceptance?.items.length ?? 0} 条{diagnostics.acceptance?.truncated ? '（已截断）' : ''}</div>
            <div>执行 {diagnostics.executions?.items.length ?? 0} 条{diagnostics.executions?.truncated ? '（已截断）' : ''}</div>
            <div>投递 {diagnostics.delivery?.items.length ?? 0} 条{diagnostics.delivery?.truncated ? '（已截断）' : ''}</div>
          </div>
        )}
      </section>
    </div>
  )
}

function lifecycleLabel(lifecycle: RemoteWorkSummary['lifecycle']): string {
  return lifecycle === 'active' ? '进行中' : lifecycle === 'paused' ? '已暂停' : lifecycle === 'closing' ? '结束中' : '已结束'
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'auto_verified': return '自动已验证'
    case 'pending_real_environment': return '待实机'
    case 'historical_version_only': return '仅历史版本'
    case 'artifact_changed': return '产物已变'
    default: return '无证据'
  }
}

function deliveryLabel(status: RemoteWorkSummary['delivery'][number]['externalStatus']): string {
  switch (status) {
    case 'delivered': return '已送达'
    case 'waiting_receipt': return '等待回执核对'
    case 'unconfirmed_no_auto_retry': return '外部结果未确认（已停止自动重试）'
    case 'in_app_only': return '仅应用内'
    case 'failed': return '发送失败'
    default: return '未发送'
  }
}
