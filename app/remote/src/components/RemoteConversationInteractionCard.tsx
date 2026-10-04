import { useEffect, useMemo, useState } from 'react'
import type {
  RemoteConversationInteraction,
  RemoteConversationInteractionAnswer,
} from '@mybuddy/shared'

interface Props {
  interaction: RemoteConversationInteraction
  onRespond: (answer: RemoteConversationInteractionAnswer) => Promise<void>
  onCancel: () => Promise<void>
}

function answerLabel(interaction: RemoteConversationInteraction): string {
  if (interaction.status === 'cancelled') return '已取消'
  if (interaction.status === 'expired') return '已过期，请重新发起'
  const answer = interaction.answer
  if (typeof answer === 'boolean') return answer ? '已确认' : '已拒绝'
  const label = (value: string) => interaction.options.find(option => option.id === value)?.label ?? value
  if (Array.isArray(answer)) return answer.length ? `已回答：${answer.map(label).join('、')}` : '已回答'
  if (typeof answer === 'string') return `已回答：${label(answer)}`
  return interaction.status === 'resolved' ? '已回答' : ''
}

export function RemoteConversationInteractionCard({ interaction, onRespond, onCancel }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelected([])
    setText('')
    setCustom('')
    setSubmitting(false)
    setError(null)
  }, [interaction.id, interaction.version, interaction.status])

  const resolved = useMemo(() => answerLabel(interaction), [interaction])
  const isPending = interaction.status === 'pending'

  const submit = async (answer: RemoteConversationInteractionAnswer) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onRespond(answer)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const cancel = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  if (!isPending) {
    return (
      <div className={`remote-interaction-history is-${interaction.status}`}>
        <div className="remote-interaction-history-main">
          <span className="remote-interaction-history-title">{interaction.title}</span>
          <span className="remote-interaction-history-answer">{resolved}</span>
        </div>
      </div>
    )
  }

  const yes = interaction.options.find(option => option.id === 'yes') ?? interaction.options[0]
  const no = interaction.options.find(option => option.id === 'no') ?? interaction.options[1]
  const customValue = custom.trim()
  const multiAnswers = [...selected, ...(customValue ? [customValue] : [])]
  const minSelections = interaction.minSelections ?? 0
  const maxSelections = interaction.maxSelections ?? Number.MAX_SAFE_INTEGER
  const multiValid = multiAnswers.length >= minSelections && multiAnswers.length <= maxSelections

  return (
    <section className="remote-interaction-card" aria-live="polite">
      <div className="remote-interaction-kicker">需要你的回答</div>
      <div className="remote-interaction-title">{interaction.title}</div>
      {interaction.description && <div className="remote-interaction-description">{interaction.description}</div>}

      {interaction.kind === 'confirm' && (
        <div className="remote-interaction-actions">
          <button type="button" className="remote-interaction-btn secondary" disabled={submitting || no?.disabled} onClick={() => void submit(false)}>
            {no?.label ?? '取消'}
          </button>
          <button type="button" className="remote-interaction-btn primary" disabled={submitting || yes?.disabled} onClick={() => void submit(true)}>
            {yes?.label ?? '确认'}
          </button>
        </div>
      )}

      {(interaction.kind === 'single_select' || interaction.kind === 'multi_select') && (
        <>
          <div
            className="remote-interaction-options"
            role={interaction.kind === 'single_select' ? 'radiogroup' : 'group'}
            aria-label={interaction.title}
          >
            {interaction.options.map(option => {
              const checked = selected.includes(option.id)
              const maxReached = interaction.kind === 'multi_select' && !checked && selected.length + (customValue ? 1 : 0) >= maxSelections
              const disabled = option.disabled || submitting || maxReached
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`remote-interaction-option${checked ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
                  role={interaction.kind === 'single_select' ? 'radio' : 'checkbox'}
                  aria-checked={checked}
                  disabled={disabled}
                  onClick={() => {
                    if (interaction.kind === 'single_select') setSelected([option.id])
                    else setSelected(current => current.includes(option.id)
                      ? current.filter(id => id !== option.id)
                      : [...current, option.id])
                  }}
                >
                  <span className="remote-interaction-option-mark" aria-hidden="true">{checked ? '✓' : ''}</span>
                  <span className="remote-interaction-option-copy">
                    <span className="remote-interaction-option-title">
                      {option.label}
                      {option.recommended && <span className="remote-interaction-recommended">推荐</span>}
                    </span>
                    {option.description && <span className="remote-interaction-option-description">{option.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>

          {interaction.allowCustom && (
            <input
              className="remote-interaction-input"
              value={custom}
              disabled={submitting}
              onChange={event => setCustom(event.target.value)}
              placeholder={interaction.customPlaceholder ?? '其他回答'}
            />
          )}

          {interaction.kind === 'multi_select' && (
            <div className="remote-interaction-selection-hint">
              已选 {multiAnswers.length}
              {Number.isFinite(maxSelections) ? ` / 最多 ${maxSelections}` : ''}
              {minSelections > 0 ? ` · 至少 ${minSelections}` : ''}
            </div>
          )}

          <div className="remote-interaction-actions">
            <button type="button" className="remote-interaction-btn secondary" disabled={submitting} onClick={() => void cancel()}>
              暂不回答
            </button>
            <button
              type="button"
              className="remote-interaction-btn primary"
              disabled={submitting || (interaction.kind === 'single_select'
                ? (!customValue && selected.length === 0)
                : !multiValid)}
              onClick={() => {
                if (interaction.kind === 'single_select') {
                  void submit(customValue || selected[0]!)
                } else {
                  void submit(multiAnswers)
                }
              }}
            >
              {submitting ? '提交中…' : '提交回答'}
            </button>
          </div>
        </>
      )}

      {(interaction.kind === 'short_text' || interaction.kind === 'long_text') && (
        <>
          {interaction.kind === 'long_text' ? (
            <textarea
              className="remote-interaction-input remote-interaction-textarea"
              rows={4}
              value={text}
              disabled={submitting}
              onChange={event => setText(event.target.value)}
              placeholder={interaction.customPlaceholder ?? '请输入回答'}
            />
          ) : (
            <input
              className="remote-interaction-input"
              value={text}
              disabled={submitting}
              onChange={event => setText(event.target.value)}
              placeholder={interaction.customPlaceholder ?? '请输入回答'}
            />
          )}
          <div className="remote-interaction-actions">
            <button type="button" className="remote-interaction-btn secondary" disabled={submitting} onClick={() => void cancel()}>
              暂不回答
            </button>
            <button
              type="button"
              className="remote-interaction-btn primary"
              disabled={submitting || !text.trim()}
              onClick={() => void submit(text.trim())}
            >
              {submitting ? '提交中…' : '提交回答'}
            </button>
          </div>
        </>
      )}

      {error && <div className="remote-interaction-error" role="alert">{error}</div>}
    </section>
  )
}
