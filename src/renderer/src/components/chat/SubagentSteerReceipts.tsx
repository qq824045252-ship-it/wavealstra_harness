import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SubagentSteerReceipt } from "../../../../shared/agent-ipc";

export function useSubagentSteer(taskId: string | null, childId: string | null, running: boolean) {
  const scope = JSON.stringify([taskId, childId]);
  const [state, setState] = useState<{ scope: string; receipts: SubagentSteerReceipt[] }>();
  const [readError, setReadError] = useState<{ scope: string; message: string }>();
  const retry = useRef<{ scope: string; instruction: string; requestId: string } | undefined>(undefined);
  const inFlight = useRef(new Set<string>());
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const readGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (!taskId || !childId || currentScope.current !== scope) return;
    const generation = ++readGeneration.current;
    const isCurrent = () => currentScope.current === scope && generation === readGeneration.current;
    try {
      const receipts = await window.api?.subagent?.steerReceipts?.(taskId, childId);
      if (!receipts) throw new Error("引导回执服务不可用");
      if (isCurrent()) {
        setState({ scope, receipts });
        setReadError(undefined);
      }
    } catch (error) {
      if (isCurrent()) setReadError({ scope, message: error instanceof Error ? error.message : String(error) });
    }
  }, [taskId, childId, scope]);

  const receipts = state?.scope === scope ? state.receipts : [];
  const pending = receipts.some(receipt => receipt.status === "queued" || receipt.status === "processed");
  useEffect(() => {
    void refresh();
    const timer = running || pending ? setInterval(() => void refresh(), 1500) : undefined;
    return () => {
      ++readGeneration.current;
      if (timer) clearInterval(timer);
    };
  }, [refresh, running, pending]);

  const send = async (instruction: string) => {
    if (!taskId || !childId || inFlight.current.has(scope)) return;
    inFlight.current.add(scope);
    const previous = retry.current;
    const request = previous?.scope === scope && previous.instruction === instruction
      ? previous
      : { scope, instruction, requestId: crypto.randomUUID() };
    retry.current = request;
    try {
      const result = await window.api?.subagent?.steer(childId, instruction, taskId, request.requestId);
      if (retry.current === request && result && (result.ok || result.reason !== "receipt_unknown")) retry.current = undefined;
      if (result?.ok && currentScope.current === scope) {
        ++readGeneration.current;
        setState(current => ({ scope, receipts: [
          ...(current?.scope === scope ? current.receipts.filter(row => row.requestId !== request.requestId) : []),
          result.receipt,
        ].sort((a, b) => a.submissionId - b.submissionId) }));
      }
      void refresh();
      return result;
    } finally {
      inFlight.current.delete(scope);
    }
  };
  return { receipts, send, refresh, loaded: state?.scope === scope, error: readError?.scope === scope ? readError.message : undefined };
}

const label: Record<SubagentSteerReceipt["status"], string> = {
  queued: "已接收 · 排队中",
  processed: "已进入当前对话 · 等待答复",
  settled: "已答复",
  cancelled: "已取消",
  unprocessed: "未处理",
  unanswered: "已进入当前对话 · 未获答复",
};

const reasonLabel: Record<string, string> = {
  aborted: "已中止",
  run_failed: "子代理本轮执行失败",
  child_finished_before_processing: "子代理结束时仍在排队",
  faulted: "执行异常",
  nothing_to_answer: "本轮未生成答复",
};

export function SubagentSteerReceipts({ receipts, error, refresh }: {
  receipts: SubagentSteerReceipt[]; error?: string; refresh: () => Promise<void>;
}) {
  if (!receipts.length && !error) return null;
  return (
    <details className="sa-steer-receipts" open>
      <summary>引导回执{receipts.length > 0 && <span className="sa-steer-receipt-count">{receipts.length} 条</span>}</summary>
      {error && <p className="sa-steer-receipt-error" role="status">
        读取回执失败。{error} <button className="btn btn--small" type="button" onClick={() => void refresh()}>重试</button>
      </p>}
      {receipts.length > 0 && (
        <ul className="sa-steer-receipt-list" aria-label="引导回执" tabIndex={0}>
          {receipts.map(receipt => (
            <li key={receipt.submissionId} title={receipt.requestId}>
              <span className="sa-steer-receipt-instruction">{receipt.instruction}</span>
              <span className="sa-steer-receipt-state">
                {label[receipt.status]}（#{receipt.submissionId}）
                {receipt.status === "cancelled" && receipt.entryId !== undefined && " · 已进入对话"}
                {receipt.reason && ` · ${reasonLabel[receipt.reason] ?? receipt.reason}`}
                {receipt.detail && receipt.detail !== receipt.reason && ` · ${receipt.detail}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
