/**
 * SubagentDrawer — Task-scoped Subagent 临时 Chat（生命周期收敛后）。
 *
 * 语义：Subagent Instance 是当前父 Task 内运行中的临时执行者。本抽屉
 * - 仅展示当前任务运行中实例的实时 transcript（IPC scope 校验）；
 * - 运行中可 steer / cancel；
 * - 实例 RESULT 返回或父 Task 结束后（ended:true）自动关闭并提示，不保留历史。
 * 不承载任何全局 history/列表。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SubagentTranscriptDto } from "../../../../shared/agent-ipc";
import { useAppStore } from "@/store/appStore";
import { modelBadgeTitle, subagentModelBadge } from "@/lib/modelBadge";
import { IconX, IconArrowUp } from "@/components/common/icons";

interface TranscriptView {
  key: string;
  kind: "assistant" | "steer" | "tool" | "meta" | "result";
  text: string;
  ts: number;
}

function buildViews(dto: SubagentTranscriptDto | null): TranscriptView[] {
  if (!dto) return [];
  const out: TranscriptView[] = [];
  for (const e of dto.entries) {
    if (e.type === "message_end") {
      const msg = (e as { message?: { role?: string; content?: Array<{ type?: string; text?: string }>; errorMessage?: string } }).message;
      if (!msg) continue;
      if (msg.role === "assistant") {
        const text = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        out.push({ key: `${e.ts}-${out.length}`, kind: "assistant", text: text || "(空回复)", ts: e.ts });
        if (msg.errorMessage) out.push({ key: `${e.ts}-e-${out.length}`, kind: "result", text: `错误: ${msg.errorMessage}`, ts: e.ts });
      } else if (msg.role === "toolResult") {
        const text = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        out.push({ key: `${e.ts}-r-${out.length}`, kind: "result", text: text.slice(0, 400), ts: e.ts });
      }
    } else if (e.type === "steer") {
      out.push({ key: `${e.ts}-s-${out.length}`, kind: "steer", text: String((e as { text?: unknown }).text ?? ""), ts: e.ts });
    } else if (e.type === "tool_end") {
      const t = e as { toolName?: string; isError?: boolean };
      out.push({ key: `${e.ts}-t-${out.length}`, kind: "tool", text: `${t.isError ? "✗" : "→"} ${t.toolName ?? ""}`, ts: e.ts });
    } else if (e.type === "meta" && (e as { kind?: string }).kind === "worker_start") {
      out.push({ key: `${e.ts}-m-${out.length}`, kind: "meta", text: "worker 启动", ts: e.ts });
    }
  }
  return out;
}

export default function SubagentDrawer(): React.JSX.Element | null {
  const drawer = useAppStore((s) => s.subagentDrawer);
  const closeDrawer = useAppStore((s) => s.closeSubagentDrawer);
  const [transcript, setTranscript] = useState<SubagentTranscriptDto | null>(null);
  const [ended, setEnded] = useState(false);
  const [draft, setDraft] = useState("");
  const [steering, setSteering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const instanceId = drawer?.instanceId ?? null;

  const refresh = useCallback(async () => {
    if (!instanceId) return;
    try {
      const dto = await window.api?.subagent?.transcript(instanceId);
      setTranscript(dto ?? null);
      if (dto?.ended) setEnded(true);
    } catch {
      /* 实例已销毁/跨任务 → ended */
      setEnded(true);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!instanceId) return;
    setEnded(false);
    setTranscript(null);
    refresh();
    // active 实例变化推送刷新；低频 fallback
    const unsub = window.api?.subagent?.onEvent?.(() => void refresh());
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      unsub?.();
      clearInterval(timer);
    };
  }, [instanceId, refresh]);

  // 已结束不再强行自动关闭，保留给用户查看任务详情与历史记录的机会
  // 用户可通过右上角 ✕ 随时手动关闭
  useEffect(() => {
    // 保持开放，不强行超时关闭
  }, [ended]);

  const views = useMemo(() => buildViews(transcript), [transcript]);
  const models = useAppStore((s) => s.models);
  // 抽屉里也标出该实例真实使用的模型（与侧边栏同一套事实来源）
  const modelBadge = useMemo(() => {
    const record = transcript?.record;
    if (!record) return undefined;
    const names: Record<string, string> = {};
    for (const model of models ?? []) {
      const id = (model?.id ?? "").trim();
      if (id) names[id] = model.name;
    }
    return subagentModelBadge(record, names);
  }, [transcript?.record, models]);

  if (!drawer) return null;

  const sendSteer = async (): Promise<void> => {
    if (!instanceId || !draft.trim()) return;
    setSteering(true);
    setNotice(null);
    try {
      const res = await window.api?.subagent?.steer(instanceId, draft.trim());
      setNotice(res?.ok ? `已送达（${res.delivered}）` : `失败: ${res?.message ?? ""}`);
      setDraft("");
      await refresh();
    } catch (e) {
      setNotice(`steer 失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSteering(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!instanceId) return;
    try {
      const res = await window.api?.subagent?.cancel(instanceId);
      setNotice(res?.ok ? "已发送中止" : `取消失败: ${res?.message ?? ""}`);
      await refresh();
    } catch (e) {
      setNotice(`取消失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="sa-drawer-backdrop" onClick={closeDrawer}>
      <div className="sa-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="sa-drawer-head">
          <div className="sa-drawer-title">
            <span className="sa-item-role">
              {transcript?.record?.displayName
                ? `${transcript.record.displayName} · ${transcript.record.role}`
                : transcript?.record?.role ?? "subagent"}
            </span>
            {modelBadge && (
              <span className="sa-model" title={modelBadgeTitle(modelBadge)}>
                {modelBadge.label}
              </span>
            )}
            <span className="sa-item-id">{instanceId}</span>
            {!ended && <span className="sa-status sa-status--running">Running</span>}
            {ended && <span className="sa-status sa-status--warn">已结束</span>}
          </div>
          <button className="icon-btn" title="关闭" onClick={closeDrawer}>
            <IconX size={14} />
          </button>
        </div>

        {ended ? (
          <div className="sa-empty">实例已结束（RESULT/FAILED/CANCELLED）或父 Task 已关闭——临时 Chat 不保留历史。</div>
        ) : (
          <>
            <div className="sa-drawer-body">
              {views.length === 0 && <div className="sa-empty">（运行中…）</div>}
              {views.map((v) => (
                <div key={v.key} className={`sa-tx sa-tx--${v.kind}`}>
                  {v.kind === "steer" && <span className="sa-tx-tag">引导</span>}
                  {v.kind === "tool" && <span className="sa-tx-tag">工具</span>}
                  {v.kind === "meta" && <span className="sa-tx-tag">状态</span>}
                  {v.kind === "result" && <span className="sa-tx-tag">结果</span>}
                  {v.text}
                </div>
              ))}
            </div>
            {notice && <div className="sa-notice">{notice}</div>}
            <div className="sa-steer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="给运行中的子代理发附加指令（steer）"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendSteer();
                  }
                }}
              />
              <div className="sa-drawer-actions">
                <button className="btn btn--small" onClick={() => void cancel()}>
                  中止
                </button>
                <button className="btn btn--small" onClick={() => void sendSteer()} disabled={steering || !draft.trim()}>
                  <IconArrowUp size={13} /> 发送
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
