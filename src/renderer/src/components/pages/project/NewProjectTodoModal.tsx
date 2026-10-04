import { useEffect, useId, useState } from "react";
import { IconX } from "@/components/common/icons";
import { dateInputToMs, msToDateInput, startOfLocalDay } from "@/lib/projectPlanSchedule";
import { PROJECT_PLAN_COLUMNS, type ProjectPlanColumnId } from "@/lib/projectWorkspace";
import type { ProjectTodoDto, ProjectTodoPriority } from "@shared/project-domain";

interface Props {
  open: boolean;
  projectId: string;
  archived: boolean;
  editing?: ProjectTodoDto | null;
  defaultStatus?: ProjectPlanColumnId;
  defaultDay?: number;
  onClose: () => void;
  onSaved: (todo: ProjectTodoDto) => void;
  onDelete?: () => void;
  onStartTask?: (todo: ProjectTodoDto) => void;
}

const PRIORITIES: Array<{ id: ProjectTodoPriority | ""; label: string }> = [
  { id: "", label: "优先级" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
];

export default function NewProjectTodoModal({
  open,
  projectId,
  archived,
  editing,
  defaultStatus,
  defaultDay,
  onClose,
  onSaved,
  onDelete,
  onStartTask,
}: Props): React.JSX.Element | null {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectPlanColumnId>("todo");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<ProjectTodoPriority | "">("");
  const [tag, setTag] = useState("");
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setDescription(editing.description ?? "");
      setStatus(editing.status);
      setAssignee(editing.assignee ?? "");
      setPriority(editing.priority ?? "");
      setTag(editing.tags[0] ?? "");
      setStartAt(msToDateInput(editing.startAt));
      setDueAt(msToDateInput(editing.dueAt));
    } else {
      const day = defaultDay ?? startOfLocalDay();
      setTitle("");
      setDescription("");
      setStatus(defaultStatus ?? "todo");
      setAssignee("");
      setPriority("");
      setTag("");
      setStartAt(msToDateInput(day));
      setDueAt(msToDateInput(day));
    }
    setError(null);
  }, [open, editing, defaultStatus, defaultDay]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (options?: { startTask?: boolean }): Promise<void> => {
    if (archived || busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const api = window.api?.db;
      if (!api?.createProjectTodo || !api.updateProjectTodo) {
        throw new Error("待办接口还没加载，请完全退出 MyBuddy 后再打开");
      }
      const payload = {
        title: title.trim(),
        description: description.trim() || undefined,
        status: options?.startTask ? "doing" as const : status,
        assignee: assignee.trim() || undefined,
        priority: priority || undefined,
        tags: tag.trim() ? [tag.trim()] : [],
        startAt: dateInputToMs(startAt),
        dueAt: dateInputToMs(dueAt),
      };
      const saved = editing
        ? await api.updateProjectTodo({ id: editing.id, ...payload })
        : await api.createProjectTodo({ projectId, ...payload });
      if (!saved?.id) throw new Error("没有写进待办，请重试");
      onSaved(saved);
      onClose();
      if (options?.startTask) onStartTask?.(saved);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message.replace(/^Error:\s*/i, "") || "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="project-todo-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-todo-modal-head">
          <div id={titleId} className="project-todo-modal-title">{editing ? "编辑待办" : "新建待办"}</div>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
        <div className="project-todo-modal-body">
          <input
            className="project-todo-title"
            value={title}
            placeholder="请输入标题"
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className="project-todo-desc"
            value={description}
            placeholder="添加描述（可选）"
            onChange={(event) => setDescription(event.target.value)}
          />
          {error && <div className="project-form-error">{error}</div>}
        </div>
        <div className="project-todo-chips">
          <select className="project-todo-chip" value={status} onChange={(event) => setStatus(event.target.value as ProjectPlanColumnId)}>
            {PROJECT_PLAN_COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>{column.label}</option>
            ))}
          </select>
          <input
            className="project-todo-chip project-todo-chip-input"
            value={assignee}
            placeholder="处理人"
            onChange={(event) => setAssignee(event.target.value)}
          />
          <select className="project-todo-chip" value={priority} onChange={(event) => setPriority(event.target.value as ProjectTodoPriority | "")}>
            {PRIORITIES.map((item) => (
              <option key={item.id || "none"} value={item.id}>{item.label}</option>
            ))}
          </select>
          <input
            className="project-todo-chip project-todo-chip-input"
            value={tag}
            placeholder="标签"
            onChange={(event) => setTag(event.target.value)}
          />
          <label className="project-todo-chip">
            开始
            <input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
          </label>
          <label className="project-todo-chip">
            截止
            <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </label>
        </div>
        <div className="project-todo-modal-foot">
          {editing && !archived ? (
            <div className="project-todo-modal-foot-actions">
              {onDelete && (
                <button type="button" className="btn danger" onClick={onDelete} disabled={busy}>
                  删除
                </button>
              )}
              {onStartTask && (
                <button type="button" className="btn" onClick={() => void submit({ startTask: true })} disabled={busy || !title.trim()}>
                  开始任务
                </button>
              )}
            </div>
          ) : (
            <span />
          )}
          <div className="project-todo-modal-foot-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={archived || busy || !title.trim()}>
              {editing ? "保存" : "创建"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
