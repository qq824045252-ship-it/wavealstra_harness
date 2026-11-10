/**
 * SubagentChatView — 子代理的独立对话页（与主聊天共用同一套聊天界面）。
 *
 * 为什么与主聊天共用：用户要求「共用通用聊天界面」。这里复用的不是「看起来像」，
 * 而是同一批组件与同一套映射：MessageItem（工具卡/思考/耗时/用量）、
 * historyMessageToChatMessage（主聊天的 DTO → ChatMessage）、ChatComposer（输入外壳）。
 *
 * 数据源：
 * - 运行中：subagent:transcript 的 message_end（活实例，可按事件 + 低频轮询刷新）；
 * - 已完成：父任务里该派发 details.results[].messages（派发结束后唯一残留）。
 * 两条来源都映射成 ChatMessage，所以历史/进行中的呈现完全一致。
 *
 * 导航：顶部 ← 与父任务标题都可点，返回父任务对话（closeSubagentView）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { useSubagentRuns } from "@/hooks/useSubagentRuns";
import MessageItem from "./MessageItem";
import ChatComposer from "./ChatComposer";
import SubagentChatHeader from "./SubagentChatHeader";
import { childDurationLabel } from "@/lib/subagentDetails";
import {
  childMessagesToChatMessages,
  findSubagentResultRun,
  subagentTaskText,
  transcriptEntriesToChildMessages,
} from "@/lib/subagentChat";
import type { ChildMessage } from "@/lib/subagentDetails";
import { formatElapsed } from "@/components/artifact/overview/overviewRuntime";
import { IconArrowUp, IconStop } from "@/components/common/icons";

export default function SubagentChatView({
  taskId,
  subagentId,
}: {
  taskId: string;
  subagentId: string;
}): React.JSX.Element {
  const closeSubagentView = useAppStore((s) => s.closeSubagentView);
  const task = useAppStore((s) => s.tasks.find((item) => item.id === taskId) ?? null);
  const runs = useSubagentRuns(taskId);
  const entry = runs.find(subagentId);
  const running = entry?.kind === "running";

  const [transcript, setTranscript] = useState<ChildMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [followBottom, setFollowBottom] = useState(true);

  // 运行中：实时 transcript（事件推送 + 低频兜底轮询）；结束后走结构化结果
  const refreshTranscript = useCallback(async () => {
    if (!running) return;
    try {
      const dto = await window.api?.subagent?.transcript(subagentId);
      setTranscript(transcriptEntriesToChildMessages(dto?.entries as { type?: string; message?: unknown }[] | undefined));
    } catch {
      /* 实例已销毁：保留最后一帧，等结构化结果接管 */
    }
  }, [running, subagentId]);

  useEffect(() => {
    if (!running) return;
    void refreshTranscript();
    const unsub = window.api?.subagent?.onEvent?.(() => void refreshTranscript());
    const timer = setInterval(() => void refreshTranscript(), 1500);
    return () => {
      unsub?.();
      clearInterval(timer);
    };
  }, [running, refreshTranscript]);

  const resultRun = useMemo(
    () => (running ? null : findSubagentResultRun(task?.messages ?? [], subagentId)),
    [running, task?.messages, subagentId],
  );

  const childMessages = running ? (transcript ?? []) : (resultRun?.messages ?? []);
  const taskText = subagentTaskText(resultRun, entry?.kind === "running" ? entry.row.work : undefined);
  const durationLabel = running ? undefined : childDurationLabel(resultRun?.durationMs);

  const rows = useMemo(
    () =>
      childMessagesToChatMessages(childMessages, {
        prefix: `sa-${subagentId}`,
        task: taskText,
        durationLabel,
      }),
    [childMessages, subagentId, taskText, durationLabel],
  );

  // 新内容到达时只在接近底部时跟随，用户上滚阅读不被打断
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !followBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length, rows[rows.length - 1]?.blocks.length, followBottom]);

  const name = entry?.row.name ?? subagentId;
  const stateLabel = entry === null || entry === undefined
    ? "状态未知"
    : entry.kind === "running"
      ? "运行中"
      : entry.kind === "queued"
        ? "排队中"
        : entry.row.state === "completed"
          ? "已完成"
          : entry.row.state === "failed"
            ? "失败"
            : entry.row.state === "unknown"
              ? "已结束"
              : "已取消";
  const model = entry?.kind === "running" || entry?.kind === "done" ? entry.row.model : undefined;
  const usage = entry?.kind === "running" ? entry.row.usage : resultRun?.usage ?? (entry?.kind === "done" ? entry.row.usage : undefined);
  const cwd = entry?.kind === "running" || entry?.kind === "done" || entry?.kind === "queued" ? entry.row.cwd : undefined;
  const elapsed = entry?.kind === "running" ? formatElapsed(entry.row.elapsedMs) : childDurationLabel(resultRun?.durationMs ?? (entry?.kind === "done" ? entry.row.durationMs : undefined));

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !running) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await window.api?.subagent?.steer(subagentId, text);
      setNotice(res?.ok ? `已送达（${res.delivered}）` : `发送失败：${res?.message ?? ""}`);
      if (res?.ok) setDraft("");
      await refreshTranscript();
    } catch (error) {
      setNotice(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      const res = await window.api?.subagent?.cancel(subagentId);
      setNotice(res?.ok ? "已发送中止" : `中止失败：${res?.message ?? ""}`);
    } catch (error) {
      setNotice(`中止失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="chat-column subagent-chat-column" data-mode="subagent">
      <SubagentChatHeader
        taskTitle={task?.title || "任务"}
        name={name}
        subagentId={subagentId}
        stateLabel={stateLabel}
        stateTone={entry?.kind === "running" ? "running" : entry?.kind === "queued" ? "queued" : entry?.kind === "done" && entry.row.state === "completed" ? "completed" : entry?.kind === "done" && entry.row.state === "failed" ? "failed" : "cancelled"}
        model={model}
        usage={usage}
        elapsed={elapsed}
        elapsedTitle={running ? "本子代理本轮从派发至今的时间，包含工具执行与等待" : resultRun?.durationMs !== undefined ? "本子代理首末消息的时间跨度，非纯模型生成耗时" : "最后观测到的运行时长；没有记录时显示 —，不继续计时"}
        onBack={closeSubagentView}
      />

      {cwd && <div className="subagent-chat-sub" title={cwd}>工作目录: {cwd}</div>}

      <div className="chat-viewport subagent-chat-viewport">
        <div
          className="message-scroll subagent-chat-scroll"
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current;
            if (!el) return;
            setFollowBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
          }}
        >
          {rows.length === 0 ? (
            <div className="sa-empty">
              {entry?.kind === "queued"
                ? "排队中：子会话还没开始，轮到并发名额后这里会显示它的对话。"
                : running
                  ? "（等待子代理产生第一条消息…）"
                  : "没有可显示的子会话消息。"}
            </div>
          ) : (
            <div className="message-list">
              {rows.map((row) => (
                <div key={row.id} id={`msg-${row.id}`}>
                  <MessageItem message={row} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {notice && <div className="sa-notice">{notice}</div>}

      <div className="input-area subagent-chat-input">
        <div className={`input-box${running ? "" : " is-readonly"}`}>
          <ChatComposer
            value={draft}
            disabled={!running}
            placeholder={running ? "给子代理发附加指令（不打断当前回合，按顺序送达）" : "子代理已结束，对话为只读"}
            aria-label="给子代理发消息"
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            toolbar={
              <>
                <span className="subagent-chat-hint">
                  {running ? "steer：附加指令排入该子代理当前任务" : "只读 · 已结束的子代理不能再接收指令"}
                </span>
                <div className="input-spacer" />
                {running && (
                  <button type="button" className="btn btn--small" onClick={() => void cancel()}>
                    <IconStop size={12} /> 中止
                  </button>
                )}
                <button
                  type="button"
                  className="send-btn"
                  title={running ? "发送（Enter）" : "已结束"}
                  disabled={!running || sending || !draft.trim()}
                  onClick={() => void send()}
                >
                  <IconArrowUp size={16} />
                </button>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
