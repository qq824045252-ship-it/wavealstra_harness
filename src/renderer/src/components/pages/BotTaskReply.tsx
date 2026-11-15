import { createContext, useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BotMessageDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { BotTaskReplyGroup } from "@/lib/botWorkspacePresentation";
import { botTaskReplyFeedbackCurrent, botTaskReplyPresentation, type BotTaskReplyStageId } from "@/lib/botTaskReplyPresentation";
import "./BotTaskReply.css";

type ReplySelection = { selected: BotTaskReplyStageId; visited: Set<BotTaskReplyStageId> };
const ReplyContext = createContext<{ selections: Map<string, ReplySelection>; onInspect: () => void } | null>(null);

/** Selection belongs to a scoped Work, even when an older page reveals its original
 * reply. This is view state only; it never becomes a composer/execution target. */
export function BotTaskReplyScope({ scope, onInspect, children }: { scope: string; onInspect: () => void; children: ReactNode }): React.JSX.Element {
  const cache = useRef({ scope, selections: new Map<string, ReplySelection>() });
  if (cache.current.scope !== scope) cache.current = { scope, selections: new Map() };
  const value = useMemo(() => ({ selections: cache.current.selections, onInspect }), [scope, onInspect]);
  return <ReplyContext.Provider value={value}>{children}</ReplyContext.Provider>;
}

const emptyStage: Record<BotTaskReplyStageId, string> = {
  request: "任务已关联到这条回复，后续进展会在这里更新。",
  execution: "执行进展和已核实的阶段成果会保留在这里。",
  review: "执行结果返回后，在这里查看核对记录和需要补充的信息。",
  result: "最终结论和交付文件会保留在这里。",
};
const stateLabels = { pending: "尚未到达", current: "当前阶段", completed: "已完成", attention: "需要处理", paused: "已暂停", ended: "已结束" };

export function BotTaskReply({ task, work, renderMessage }: {
  task: BotTaskReplyGroup; work?: WorkProjectionDto; renderMessage: (message: BotMessageDto) => ReactNode;
}): React.JSX.Element {
  const presentation = useMemo(() => botTaskReplyPresentation(task.workId, work, task.messages), [task.workId, work, task.messages]);
  const context = useContext(ReplyContext);
  const [local, setLocal] = useState<{ key: string; value: ReplySelection }>(() => ({ key: task.key,
    value: context?.selections.get(task.key) ?? { selected: presentation.currentStageId, visited: new Set([presentation.currentStageId]) } }));
  const selection = local.key === task.key ? local.value : context?.selections.get(task.key)
    ?? { selected: presentation.currentStageId, visited: new Set([presentation.currentStageId]) };
  // Keep the original choice while streaming, finishing, retrying or replanning.
  // A newly available stage is visible in the header, never selected implicitly.
  if (context && !context.selections.has(task.key)) context.selections.set(task.key, selection);
  const select = (stage: BotTaskReplyStageId) => {
    context?.onInspect();
    const value = { selected: stage, visited: new Set([...selection.visited, stage]) };
    context?.selections.set(task.key, value);
    setLocal({ key: task.key, value });
  };
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, stage: BotTaskReplyStageId) => {
    const index = presentation.stages.findIndex(item => item.id === stage);
    const count = presentation.stages.length;
    const next = event.key === "ArrowRight" ? (index + 1) % count : event.key === "ArrowLeft" ? (index + count - 1) % count
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    select(presentation.stages[next].id);
    tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
  };
  const current = presentation.stages.find(stage => stage.id === presentation.currentStageId)!;
  const latest = task.messages.at(-1);
  const updatedAt = Math.max(work?.updatedAt ?? 0, latest?.updatedAt ?? latest?.createdAt ?? 0);
  const endedAt = work?.closedAt;
  return <section className="bot-task-reply" data-work-id={task.workId} aria-label={`任务进度：${presentation.title}`}>
    <header className="bot-task-reply-heading">
      <h3>{presentation.title}</h3>
      <span className="bot-task-reply-status" data-state={current.state}>{presentation.statusLabel}</span>
    </header>
    <div ref={tabs} className="bot-task-reply-tabs" role="tablist" aria-label={`${presentation.title}的阶段`}>
      {presentation.stages.map(stage => <button type="button" role="tab" key={stage.id}
        id={`${id}-tab-${stage.id}`} aria-controls={`${id}-panel-${stage.id}`} aria-selected={selection.selected === stage.id}
        aria-label={`${stage.label} · ${stateLabels[stage.state]}`} tabIndex={selection.selected === stage.id ? 0 : -1}
        data-stage-id={stage.id} data-state={stage.state} onClick={() => select(stage.id)} onKeyDown={event => keyboard(event, stage.id)}>
        <span className="bot-task-stage-marker" aria-hidden="true">{stage.state === "completed" ? "✓" : stage.state === "attention" ? "!" : ""}</span>
        {stage.label}{stage.messages.length > 0 && <span className="bot-task-stage-count" aria-hidden="true">{stage.messages.length}</span>}
      </button>)}
    </div>
    {presentation.stages.map(stage => <div key={stage.id} id={`${id}-panel-${stage.id}`} role="tabpanel"
      aria-labelledby={`${id}-tab-${stage.id}`} className="bot-task-reply-panel" data-stage-id={stage.id} hidden={selection.selected !== stage.id} tabIndex={0}>
      {selection.visited.has(stage.id) && <>
        {stage.id === "request" && work?.goalDescription && <p className="bot-task-reply-goal">{work.goalDescription}</p>}
        {stage.messages.length === 0 && !(stage.id === "request" && work?.goalDescription) && <p className="bot-task-reply-empty">{stage.description || emptyStage[stage.id]}</p>}
      </>}
      {stage.messages.map(message => <div key={message.messageId} className="bot-task-reply-update" data-message-id={message.messageId} data-feedback-message-id={message.messageId}>
        {selection.visited.has(stage.id) && <>
          {!botTaskReplyFeedbackCurrent(message.workFeedback!, work) && <p className="bot-task-reply-historical">历史阶段记录 · 保留原版本内容</p>}
          {renderMessage(message)}
        </>}
      </div>)}
    </div>)}
    <footer className="bot-task-reply-progress">
      <span>当前：{current.label} · {presentation.statusLabel}</span>
      {selection.selected !== current.id && <button type="button" onClick={() => select(current.id)}>查看当前阶段</button>}
      <div className="bot-task-reply-times">
        {endedAt !== undefined ? <span>结束 <time dateTime={new Date(endedAt).toISOString()}>{formatTime(endedAt)}</time></span>
          : updatedAt > 0 && <span>更新 <time dateTime={new Date(updatedAt).toISOString()}>{formatTime(updatedAt)}</time></span>}
      </div>
    </footer>
  </section>;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
