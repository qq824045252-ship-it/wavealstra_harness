import { useEffect, useId, useState } from "react";
import type { AnswerRuleUse } from "@shared/answer-routing";
import type { GenerationStats } from "@shared/generation-stats";
import AnswerRoutingGraph, { routingRunStatus } from "./AnswerRoutingGraph";

interface Props {
  taskId: string;
  inputId: string;
  replyId: string;
  question: string;
  replyStatus?: GenerationStats["outcome"];
}

type Lookup = { inputId: string; resolve: (use: AnswerRuleUse | undefined) => void; reject: (error: unknown) => void };
const historyLookups = new Map<string, Lookup[]>();
const HISTORY_BATCH_SIZE = 200;

async function flushHistoryLookups(taskId: string): Promise<void> {
  const lookups = historyLookups.get(taskId) ?? [];
  historyLookups.delete(taskId);
  const inputIds = [...new Set(lookups.map(lookup => lookup.inputId))];
  for (let offset = 0; offset < inputIds.length; offset += HISTORY_BATCH_SIZE) {
    const ids = inputIds.slice(offset, offset + HISTORY_BATCH_SIZE);
    const keys = new Set(ids);
    const batch = lookups.filter(lookup => keys.has(lookup.inputId));
    try {
      const rows = await window.api?.answerRouting?.history({ taskId, inputIds: ids });
      const byInput = new Map(rows?.filter(row => row.taskId === taskId).map(row => [row.inputId, row]));
      batch.forEach(lookup => lookup.resolve(byInput.get(lookup.inputId)));
    } catch (error) {
      batch.forEach(lookup => lookup.reject(error));
    }
  }
}

function lookupHistoryUse(taskId: string, inputId: string): Promise<AnswerRuleUse | undefined> {
  return new Promise((resolve, reject) => {
    const lookups = historyLookups.get(taskId);
    if (lookups) lookups.push({ inputId, resolve, reject });
    else {
      historyLookups.set(taskId, [{ inputId, resolve, reject }]);
      queueMicrotask(() => void flushHistoryLookups(taskId));
    }
  });
}

export default function AnswerRoutingReceipt({ taskId, inputId, replyId, question, replyStatus }: Props): React.JSX.Element | null {
  const [record, setRecord] = useState<{ replyId: string; use: AnswerRuleUse }>();
  const [expanded, setExpanded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const graphId = useId();

  useEffect(() => {
    let stale = false;
    void lookupHistoryUse(taskId, inputId).then(use => {
      if (stale) return;
      setLoadFailed(false);
      setRecord(use ? { replyId, use } : undefined);
    }).catch(() => {
      if (!stale) { setRecord(undefined); setLoadFailed(true); }
    });
    return () => { stale = true; };
  }, [taskId, inputId, replyId, replyStatus, attempt]);

  const use = record?.replyId === replyId && record.use.taskId === taskId && record.use.inputId === inputId
    ? record.use : undefined;
  if (!use && loadFailed) return <button type="button" className="routing-receipt__toggle"
    onClick={() => { setLoadFailed(false); setAttempt(n => n + 1); }}>调度记录加载失败 · 重试</button>;
  if (!use) return null;
  const evidenceName = use.evidence?.label || (use.evidence?.kind === "task-file" ? use.evidence.reference : "");
  const summary = [routingRunStatus(use), evidenceName].filter(Boolean).join(" ");
  return <div className="routing-receipt">
    <button type="button" className="routing-receipt__toggle" data-routing-receipt={inputId}
      aria-label={`本轮调度记录 · ${use.title} · ${summary}`} aria-controls={expanded ? graphId : undefined}
      aria-expanded={expanded} onClick={() => setExpanded(open => !open)}>
      <span className="routing-receipt__caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      <span><strong>{use.title}</strong> · {summary}</span>
    </button>
    {expanded && <div id={graphId}><AnswerRoutingGraph run={use} question={question} replyStatus={replyStatus} /></div>}
  </div>;
}
