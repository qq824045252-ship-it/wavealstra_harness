import { useEffect, useMemo, useState } from "react";
import type { ConversationInteractionAnswer, ConversationInteractionDto } from "@shared/conversation-interaction";

export function ConversationInteractionCard({ interaction, onRespond, onDismiss, answerDisplayText }: { interaction: ConversationInteractionDto;
  onRespond?: (answer: ConversationInteractionAnswer, source: "option" | "custom") => Promise<{ok:boolean;message?:string}>;
  onDismiss?: () => void; answerDisplayText?: string;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (interaction.status !== "pending") setSubmitting(false);
  }, [interaction.status]);

  const resolvedLabel = useMemo(() => {
    if (interaction.status === "pending") return null;
    if (interaction.status === "cancelled") return "已取消";
    if (interaction.status === "expired") return "已过期，请重新发起";
    if (answerDisplayText !== undefined) return `已回答：${answerDisplayText}`;
    if (interaction.answer === undefined) return "已回答";
    if (typeof interaction.answer === "boolean") return interaction.answer ? "已确认" : "已拒绝";
    if (Array.isArray(interaction.answer)) {
      return `已回答：${interaction.answer.map((id) => interaction.options.find((option) => option.id === id)?.label ?? id).join("、")}`;
    }
    return `已回答：${interaction.options.find((option) => option.id === interaction.answer)?.label ?? interaction.answer ?? ""}`;
  }, [interaction, answerDisplayText]);

  const submit = async (answer: ConversationInteractionAnswer, source: "option" | "custom" = "custom"): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = onRespond ? await onRespond(answer, source) : await window.api?.conversationRuntime?.respondInteraction({ interactionId: interaction.id, answer });
      if (!result?.ok) {
        setError(result?.message ?? "提交失败，请重试");
        setSubmitting(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  const isPending = interaction.status === "pending";
  if (!isPending) {
    return (
      <details className={`conversation-interaction-history is-${interaction.status}`}>
        <summary>
          <svg className="conversation-interaction-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="conversation-interaction-history-title">{interaction.title}</span>
          <span className="conversation-interaction-history-status">{interaction.status === "resolved" ? "已回答" : interaction.status === "cancelled" ? "已取消" : "已过期"}</span>
        </summary>
        <div className="conversation-interaction-history-body">
          <strong>{interaction.title}</strong>
          {interaction.description && <p>{interaction.description}</p>}
          <div className="conversation-interaction-result">{resolvedLabel}</div>
        </div>
      </details>
    );
  }
  return (
    <section className={`conversation-runtime-card interaction-card is-${interaction.status}`} aria-live="polite">
      <div className="conversation-runtime-kicker">需要你的回答</div>
      <h3>{interaction.title}</h3>
      {interaction.description && <p>{interaction.description}</p>}
      {isPending && interaction.kind === "confirm" && (
        <div className="conversation-interaction-actions">
          <button type="button" className="secondary" disabled={submitting} onClick={() => void submit(false)}>取消</button>
          <button type="button" className="primary" disabled={submitting} onClick={() => void submit(true)}>确认</button>
        </div>
      )}
      {isPending && (interaction.kind === "single_select" || interaction.kind === "multi_select") && (
        <>
          <div className="conversation-options" role={interaction.kind === "single_select" ? "radiogroup" : "group"}>
            {interaction.options.map((option) => {
              const checked = selected.includes(option.id);
              return (
                <label key={option.id} className={`conversation-option${checked ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}>
                  <input
                    type={interaction.kind === "single_select" ? "radio" : "checkbox"}
                    name={`interaction-${interaction.id}`}
                    checked={checked}
                    disabled={option.disabled || submitting}
                    onChange={() => {
                      if (interaction.kind === "single_select") setSelected([option.id]);
                      else setSelected((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id]);
                    }}
                  />
                  <span><strong>{option.label}</strong>{option.recommended && <em>推荐</em>}{option.description && <small>{option.description}</small>}</span>
                </label>
              );
            })}
          </div>
          {interaction.allowCustom && (
            <input className="conversation-interaction-input" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder={interaction.customPlaceholder ?? "其他回答"} />
          )}
          <div className="conversation-interaction-actions">
            <button type="button" className="secondary" disabled={submitting} onClick={() => onDismiss ? onDismiss() : void window.api?.conversationRuntime?.cancelInteraction({ interactionId: interaction.id })}>暂不回答</button>
            <button type="button" className="primary" disabled={submitting || (selected.length === 0 && !custom.trim())} onClick={() => {
              const answer = custom.trim() || undefined;
              void submit(interaction.kind === "single_select" ? (answer ?? selected[0]!) : [...selected, ...(answer ? [answer] : [])], answer ? "custom" : "option");
            }}>提交回答</button>
          </div>
        </>
      )}
      {isPending && (interaction.kind === "short_text" || interaction.kind === "long_text") && (
        <>
          {interaction.kind === "long_text"
            ? <textarea className="conversation-interaction-input" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder={interaction.customPlaceholder ?? "请输入回答"} />
            : <input className="conversation-interaction-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={interaction.customPlaceholder ?? "请输入回答"} />}
          <div className="conversation-interaction-actions">
            <button type="button" className="secondary" disabled={submitting} onClick={() => onDismiss ? onDismiss() : void window.api?.conversationRuntime?.cancelInteraction({ interactionId: interaction.id })}>暂不回答</button>
            <button type="button" className="primary" disabled={submitting || !text.trim()} onClick={() => void submit(text.trim())}>提交回答</button>
          </div>
        </>
      )}
      {resolvedLabel && <div className="conversation-interaction-result">{resolvedLabel}</div>}
      {error && <div className="conversation-interaction-error" role="alert">{error}</div>}
    </section>
  );
}
