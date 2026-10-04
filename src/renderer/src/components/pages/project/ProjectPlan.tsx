import { useEffect, useMemo, useState } from "react";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import {
  IconCalendar,
  IconCircle,
  IconCircleCheck,
  IconCirclePause,
  IconClock,
  IconColumns,
  IconGantt,
  IconList,
  IconPlus,
  IconSearch,
  IconTable,
  IconTrash,
} from "@/components/common/icons";
import { dateInputToMs, msToDateInput } from "@/lib/projectPlanSchedule";
import { useAppStore } from "@/store/appStore";
import {
  formatRelativeTime,
  groupProjectTodos,
  PROJECT_PLAN_COLUMNS,
  PROJECT_PLAN_VIEWS,
  type ProjectPlanColumnId,
  type ProjectPlanView,
} from "@/lib/projectWorkspace";
import type { ProjectTodoDto, ProjectTodoUpdateRequest } from "@shared/project-domain";
import NewProjectTodoModal from "./NewProjectTodoModal";
import ProjectPlanCalendar from "./ProjectPlanCalendar";
import ProjectPlanGantt from "./ProjectPlanGantt";

interface Props {
  projectId: string;
  archived: boolean;
}

const VIEW_ICONS: Record<ProjectPlanView, React.ReactNode> = {
  table: <IconTable size={14} />,
  board: <IconColumns size={14} />,
  list: <IconList size={14} />,
  gantt: <IconGantt size={14} />,
  calendar: <IconCalendar size={14} />,
};

function ColumnMark({ column }: { column: ProjectPlanColumnId }): React.JSX.Element {
  if (column === "doing") return <IconClock size={14} />;
  if (column === "paused") return <IconCirclePause size={14} />;
  if (column === "done") return <IconCircleCheck size={14} />;
  return <IconCircle size={14} />;
}

const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

export default function ProjectPlan({ projectId, archived }: Props): React.JSX.Element {
  const startProjectTask = useAppStore((state) => state.startProjectTask);
  const [view, setView] = useState<ProjectPlanView>("table");
  const [query, setQuery] = useState("");
  const [todos, setTodos] = useState<ProjectTodoDto[]>([]);
  const [draft, setDraft] = useState<{ column: ProjectPlanColumnId; title: string } | null>(null);
  const [modal, setModal] = useState<{
    editing: ProjectTodoDto | null;
    status: ProjectPlanColumnId;
    day?: number;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectTodoDto | null>(null);

  const reload = async (): Promise<void> => {
    setTodos((await window.api?.db?.listProjectTodos?.(projectId)) ?? []);
  };

  useEffect(() => {
    void reload();
  }, [projectId]);

  const grouped = useMemo(() => groupProjectTodos(todos, query), [todos, query]);
  const total = PROJECT_PLAN_COLUMNS.reduce((sum, column) => sum + grouped[column.id].length, 0);
  const visible = useMemo(
    () => PROJECT_PLAN_COLUMNS.flatMap((column) => grouped[column.id]),
    [grouped],
  );

  const saveInline = async (column: ProjectPlanColumnId): Promise<void> => {
    if (archived || !draft || draft.column !== column || !draft.title.trim()) {
      setDraft(null);
      return;
    }
    await window.api?.db?.createProjectTodo?.({
      projectId,
      title: draft.title,
      status: column,
    });
    setDraft(null);
    await reload();
  };

  const patchTodo = async (patch: ProjectTodoUpdateRequest): Promise<void> => {
    await window.api?.db?.updateProjectTodo?.(patch);
    await reload();
  };

  const requestDelete = (todo: ProjectTodoDto, event?: React.MouseEvent): void => {
    event?.preventDefault();
    event?.stopPropagation();
    if (archived) return;
    setPendingDelete(todo);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || archived) {
      setPendingDelete(null);
      return;
    }
    const id = pendingDelete.id;
    setPendingDelete(null);
    if (modal?.editing?.id === id) setModal(null);
    try {
      await window.api?.db?.deleteProjectTodo?.(id);
    } finally {
      await reload();
    }
  };

  const renderDeleteButton = (todo: ProjectTodoDto): React.JSX.Element | null => {
    if (archived) return null;
    return (
      <button
        type="button"
        className="project-plan-delete"
        title="删除计划"
        aria-label={`删除「${todo.title}」`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => requestDelete(todo, event)}
      >
        <IconTrash size={14} />
      </button>
    );
  };

  const renderComposer = (column: ProjectPlanColumnId): React.JSX.Element | null => {
    if (archived) return null;
    if (draft?.column !== column) {
      return (
        <button type="button" className="project-plan-add-line" onClick={() => setDraft({ column, title: "" })}>
          <IconPlus size={13} /> 添加
        </button>
      );
    }
    return (
      <form
        className="project-plan-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void saveInline(column);
        }}
      >
        <input
          autoFocus
          className="project-plan-composer-input"
          placeholder="输入待办标题"
          value={draft.title}
          onChange={(event) => setDraft({ column, title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
          }}
          onBlur={() => void saveInline(column)}
        />
      </form>
    );
  };

  const renderCard = (todo: ProjectTodoDto): React.JSX.Element => (
    <article
      key={todo.id}
      className="project-plan-card"
      draggable={!archived}
      onDragStart={(event) => event.dataTransfer.setData("text/project-todo", todo.id)}
      onClick={() => setModal({ editing: todo, status: todo.status })}
    >
      <div className="project-plan-card-head">
        <strong>{todo.title}</strong>
        {renderDeleteButton(todo)}
      </div>
      <div className="project-plan-card-meta">
        <span>{todo.assignee || "未指定"}</span>
        <span>{formatRelativeTime(todo.updatedAt)}</span>
      </div>
      {todo.tags[0] ? <span className="project-plan-tag">{todo.tags[0]}</span> : null}
    </article>
  );

  return (
    <div className="project-desk-pane project-plan">
      <div className="project-plan-toolbar">
        <div className="project-plan-views" role="tablist" aria-label="计划视图">
          {PROJECT_PLAN_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              className={`project-plan-view ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
            >
              {VIEW_ICONS[item.id]}
              {item.label}
            </button>
          ))}
        </div>
        <label className="project-plan-search">
          <IconSearch size={14} />
          <input
            value={query}
            placeholder="搜索待办"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="input-spacer" />
        <button
          type="button"
          className="btn primary project-plan-add"
          disabled={archived}
          onClick={() => setModal({ editing: null, status: "todo" })}
        >
          添加
        </button>
      </div>

      {view === "table" && (
        <div className="project-plan-table">
          <div className="project-plan-table-head">
            <span>标题</span>
            <span>状态</span>
            <span>处理人</span>
            <span>优先级</span>
            <span>开始</span>
            <span>截止</span>
            <span>标签</span>
            <span>操作</span>
          </div>
          {total === 0 && !draft ? (
            <div className="project-plan-empty">还没有待办。用「添加」或在表格里直接写一条。</div>
          ) : (
            visible.map((todo) => {
              const column = PROJECT_PLAN_COLUMNS.find((item) => item.id === todo.status) ?? PROJECT_PLAN_COLUMNS[0]!;
              return (
                <div
                  className="project-plan-table-row"
                  key={todo.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setModal({ editing: todo, status: todo.status })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setModal({ editing: todo, status: todo.status });
                    }
                  }}
                >
                  <span className="project-plan-table-title">{todo.title}</span>
                  <span className={`project-plan-status tone-${column.tone}`}>{column.label}</span>
                  <span>{todo.assignee || "—"}</span>
                  <span>{todo.priority ? PRIORITY_LABEL[todo.priority] : "—"}</span>
                  <span>
                    <input
                      type="date"
                      className="project-plan-date"
                      value={msToDateInput(todo.startAt)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const next = dateInputToMs(event.target.value);
                        void patchTodo({ id: todo.id, startAt: next ?? null });
                      }}
                      disabled={archived}
                    />
                  </span>
                  <span>
                    <input
                      type="date"
                      className="project-plan-date"
                      value={msToDateInput(todo.dueAt)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const next = dateInputToMs(event.target.value);
                        void patchTodo({ id: todo.id, dueAt: next ?? null });
                      }}
                      disabled={archived}
                    />
                  </span>
                  <span>{todo.tags[0] || "—"}</span>
                  <span className="project-plan-table-actions">{renderDeleteButton(todo)}</span>
                </div>
              );
            })
          )}
          <div className="project-plan-table-foot">{renderComposer("todo")}</div>
        </div>
      )}

      {view === "board" && (
        <div className="project-plan-board">
          {PROJECT_PLAN_COLUMNS.map((column) => (
            <section
              key={column.id}
              className={`project-plan-column tone-${column.tone}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const id = event.dataTransfer.getData("text/project-todo");
                if (!id || archived) return;
                void patchTodo({ id, status: column.id });
              }}
            >
              <div className="project-plan-column-head">
                <span className="project-plan-column-title">
                  <ColumnMark column={column.id} />
                  {column.label}
                  <em>{grouped[column.id].length}</em>
                </span>
                {!archived && (
                  <button
                    type="button"
                    className="project-plan-column-plus"
                    title={`在${column.label}添加`}
                    onClick={() => setDraft({ column: column.id, title: "" })}
                  >
                    <IconPlus size={14} />
                  </button>
                )}
              </div>
              {grouped[column.id].length === 0 && draft?.column !== column.id ? (
                <div className="project-plan-column-empty">暂无事项</div>
              ) : (
                grouped[column.id].map((todo) => renderCard(todo))
              )}
              {renderComposer(column.id)}
            </section>
          ))}
        </div>
      )}

      {view === "gantt" && (
        <ProjectPlanGantt
          items={visible}
          archived={archived}
          onOpenItem={(id) => {
            const todo = todos.find((item) => item.id === id);
            if (todo) setModal({ editing: todo, status: todo.status });
          }}
          onSchedule={(id, span) => {
            void patchTodo({ id, startAt: span.startAt, dueAt: span.dueAt });
          }}
        />
      )}

      {view === "calendar" && (
        <ProjectPlanCalendar
          items={visible}
          archived={archived}
          onOpenItem={(id) => {
            const todo = todos.find((item) => item.id === id);
            if (todo) setModal({ editing: todo, status: todo.status });
          }}
          onCreate={(day) => setModal({ editing: null, status: "todo", day })}
        />
      )}

      {view === "list" && (
        <div className="project-plan-list">
          {PROJECT_PLAN_COLUMNS.map((column) => (
            <section key={column.id} className={`project-plan-list-group tone-${column.tone}`}>
              <div className="project-plan-list-head">
                <ColumnMark column={column.id} />
                <strong>{column.label}</strong>
                <em>{grouped[column.id].length}</em>
              </div>
              {grouped[column.id].map((todo) => (
                <div
                  key={todo.id}
                  className="project-plan-list-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setModal({ editing: todo, status: todo.status })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setModal({ editing: todo, status: todo.status });
                    }
                  }}
                >
                  <span className="project-plan-list-title">{todo.title}</span>
                  <span className="project-plan-list-owner">{todo.assignee || "未指定"}</span>
                  <span className="input-spacer" />
                  <span className="project-plan-list-time">{formatRelativeTime(todo.updatedAt)}</span>
                  {renderDeleteButton(todo)}
                </div>
              ))}
              {renderComposer(column.id)}
            </section>
          ))}
        </div>
      )}

      <NewProjectTodoModal
        open={modal != null}
        projectId={projectId}
        archived={archived}
        editing={modal?.editing}
        defaultStatus={modal?.status}
        defaultDay={modal?.day}
        onClose={() => setModal(null)}
        onSaved={() => void reload()}
        onDelete={modal?.editing ? () => requestDelete(modal.editing!) : undefined}
        onStartTask={modal?.editing ? (todo) => {
          const state = useAppStore.getState();
          startProjectTask({
            projectId,
            planId: todo.id,
            title: todo.title,
            welcomeMode: state.welcomeMode,
            modePresetId: state.modePresetId,
          });
        } : undefined}
      />
      <ConfirmDialog
        open={pendingDelete != null}
        title="删除计划项"
        body={pendingDelete ? `确定删除「${pendingDelete.title}」？删除后不可恢复。` : null}
        confirmLabel="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

export function isProjectPlanColumn(value: string): value is ProjectPlanColumnId {
  return PROJECT_PLAN_COLUMNS.some((column) => column.id === value);
}
