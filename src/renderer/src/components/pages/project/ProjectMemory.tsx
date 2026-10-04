import { useEffect, useMemo, useState } from "react";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { IconSearch, IconTrash, IconX } from "@/components/common/icons";
import { formatRelativeTime } from "@/lib/projectWorkspace";
import type {
  ProjectMemoryItemDto,
  ProjectMemoryKind,
  ProjectMemoryStatus,
} from "@shared/project-domain";
import { PROJECT_MEMORY_KINDS, PROJECT_MEMORY_STATUSES, PROJECT_MEMORY_TITLE_MAX_CHARS } from "@shared/project-domain";

interface Props {
  projectId: string;
  archived: boolean;
}

const KIND_LABEL: Record<ProjectMemoryKind, string> = {
  fact: "事实",
  decision: "决策",
  constraint: "约束",
  risk: "风险",
  open_question: "待确认",
  progress: "进度",
};

const STATUS_LABEL: Record<ProjectMemoryStatus, string> = {
  active: "有效",
  superseded: "已取代",
  resolved: "已解决",
};

const IMPORTANCE_LABEL = ["普通", "重要", "高", "关键"] as const;

const EVIDENCE_KIND_LABEL: Record<string, string> = {
  library: "资料",
  artifact: "产物",
  task: "任务",
  event: "事件",
};

type KindFilter = "all" | ProjectMemoryKind;

export default function ProjectMemory({ projectId, archived }: Props): React.JSX.Element {
  const [items, setItems] = useState<ProjectMemoryItemDto[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<{
    editing: ProjectMemoryItemDto | null;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectMemoryItemDto | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => {
    setItems((await window.api?.db?.listProjectMemory?.(projectId)) ?? []);
  };

  useEffect(() => {
    void reload();
  }, [projectId]);

  const visible = useMemo(() => {
    let list = items;
    if (kindFilter !== "all") list = list.filter((item) => item.kind === kindFilter);
    if (activeOnly) list = list.filter((item) => item.status === "active");
    const normalized = query.trim().toLowerCase();
    if (normalized) {
      list = list.filter(
        (item) =>
          item.title.toLowerCase().includes(normalized) ||
          item.content.toLowerCase().includes(normalized) ||
          item.tags.some((tag) => tag.toLowerCase().includes(normalized)),
      );
    }
    return list;
  }, [items, kindFilter, activeOnly, query]);

  const counts = useMemo(() => {
    const byKind: Record<ProjectMemoryKind, number> = { fact: 0, decision: 0, constraint: 0, risk: 0, open_question: 0, progress: 0 };
    for (const item of items) byKind[item.kind] += 1;
    return byKind;
  }, [items]);

  const remove = async (item: ProjectMemoryItemDto): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api?.db?.deleteProjectMemory?.({ projectId, id: item.id });
      if (modal?.editing?.id === item.id) setModal(null);
      setPendingDelete(null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-desk-pane">
      <div className="project-desk-toolbar project-memory-toolbar">
        <div className="project-seg">
          <button
            type="button"
            className={kindFilter === "all" ? "active" : ""}
            onClick={() => setKindFilter("all")}
          >
            全部{items.length > 0 ? ` ${items.length}` : ""}
          </button>
          {PROJECT_MEMORY_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={kindFilter === kind ? "active" : ""}
              onClick={() => setKindFilter(kind)}
            >
              {KIND_LABEL[kind]}{counts[kind] > 0 ? ` ${counts[kind]}` : ""}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`project-memory-filter-toggle${activeOnly ? " active" : ""}`}
          aria-pressed={activeOnly}
          onClick={() => setActiveOnly((value) => !value)}
        >
          只看有效
        </button>
        <div className="project-memory-toolbar-end">
          <label className="project-plan-search project-memory-search">
            <IconSearch size={14} />
            <input
              value={query}
              placeholder="搜索标题、内容或标签"
              aria-label="搜索记忆"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={archived}
            onClick={() => setModal({ editing: null })}
          >
            添加
          </button>
        </div>
      </div>

      <div className="project-memory-rows">
        {visible.length === 0 ? (
          <div className="project-empty-state">
            {items.length === 0 ? <>
              <strong>还没有项目记忆</strong>
              <span>在项目任务里确认的事实、决策、约束、风险和待确认问题会自动沉淀到这里，本项目所有任务都会读取；也可以点「添加」手动记录。</span>
            </> : "没有匹配的记忆"}
          </div>
        ) : (
          visible.map((item) => (
            <article
              key={item.id}
              className={`project-memory-card status-${item.status}`}
            >
              <button
                type="button"
                className="project-memory-card-main"
                onClick={() => setModal({ editing: item })}
              >
                <div className="project-memory-card-head">
                  <span className={`project-memory-kind-badge kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className={`project-memory-status-badge status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  {item.importance > 0 ? (
                    <span className={`project-memory-importance importance-${item.importance}`}>
                      {IMPORTANCE_LABEL[item.importance] ?? "重要"}
                    </span>
                  ) : null}
                  <span className="input-spacer" />
                  <span className="project-memory-meta">
                    {item.sourceType === "agent" ? "Agent 沉淀" : "手动添加"}
                    {" · "}
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                </div>
                <div className="project-memory-title">{item.title}</div>
                {item.content ? <div className="project-memory-content">{item.content}</div> : null}
                {item.tags.length > 0 || item.evidence.length > 0 ? (
                  <div className="project-memory-card-foot">
                    {item.tags.map((tag) => (
                      <span key={tag} className="project-memory-tag">#{tag}</span>
                    ))}
                    {item.evidence.map((ev) => (
                      <span
                        key={ev.id}
                        className="project-memory-evidence-chip"
                        title={`${EVIDENCE_KIND_LABEL[ev.evidenceKind] ?? ev.evidenceKind}：${ev.refTitle ?? ev.refId}`}
                      >
                        {EVIDENCE_KIND_LABEL[ev.evidenceKind] ?? ev.evidenceKind}
                        {ev.refTitle ? ` · ${ev.refTitle}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
              {!archived && (
                <button
                  type="button"
                  className="icon-btn project-memory-delete"
                  title="删除记忆"
                  aria-label={`删除记忆：${item.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingDelete(item);
                  }}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </article>
          ))
        )}
      </div>

      <ProjectMemoryModal
        open={modal != null}
        projectId={projectId}
        archived={archived}
        editing={modal?.editing ?? null}
        onClose={() => setModal(null)}
        onSaved={() => void reload()}
        onDelete={modal?.editing ? () => setPendingDelete(modal.editing) : undefined}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条记忆？"
        body="删除后，绑定本项目的任务将不再看到这条认知，此操作无法撤销。过时信息也可以先标为「已取代」或「已解决」。"
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
      />
    </div>
  );
}

interface ModalProps {
  open: boolean;
  projectId: string;
  archived: boolean;
  editing: ProjectMemoryItemDto | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}

function ProjectMemoryModal({ open, projectId, archived, editing, onClose, onSaved, onDelete }: ModalProps): React.JSX.Element | null {
  const [kind, setKind] = useState<ProjectMemoryKind>("fact");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<ProjectMemoryStatus>("active");
  const [importance, setImportance] = useState(0);
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(editing?.kind ?? "fact");
    setTitle(editing?.title ?? "");
    setContent(editing?.content ?? "");
    setStatus(editing?.status ?? "active");
    setImportance(editing?.importance ?? 0);
    setTags((editing?.tags ?? []).join(", "));
    setError(null);
    setBusy(false);
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const parsedTags = tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (editing) {
      const patch: import("@shared/project-domain").ProjectMemoryUpdateRequest = {
        projectId,
        id: editing.id,
        kind,
        title,
        status,
        importance,
      };
      if (content.trim()) patch.content = content.trim();
      else patch.content = "";
      patch.tags = parsedTags;
      setBusy(true);
      try {
        await window.api?.db?.updateProjectMemory?.(patch);
        onSaved();
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await window.api?.db?.createProjectMemory?.({
        projectId,
        kind,
        title: title.trim(),
        content: content.trim() || undefined,
        status,
        importance,
        tags: parsedTags,
      });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="new-project-modal project-memory-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="new-project-modal-head">
          <div className="new-project-modal-title">{editing ? "编辑记忆" : "新建记忆"}</div>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
        <div className="new-project-modal-body">
          <div className="new-project-field">
            <span className="new-project-label">类型</span>
            <select className="new-project-input" value={kind} onChange={(event) => setKind(event.target.value as ProjectMemoryKind)}>
              {PROJECT_MEMORY_KINDS.map((item) => (
                <option key={item} value={item}>{KIND_LABEL[item]}</option>
              ))}
            </select>
          </div>
          <label className="new-project-field">
            <span className="new-project-label">标题</span>
            <input
              className="new-project-input"
              value={title}
              placeholder="一句话主题（用于稳定识别）"
              maxLength={PROJECT_MEMORY_TITLE_MAX_CHARS}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="new-project-field">
            <span className="new-project-label">内容</span>
            <textarea
              className="new-project-input project-memory-content-input"
              rows={4}
              value={content}
              placeholder="正文（可留空）"
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <div className="new-project-field">
            <span className="new-project-label">状态</span>
            <select className="new-project-input" value={status} onChange={(event) => setStatus(event.target.value as ProjectMemoryStatus)}>
              {PROJECT_MEMORY_STATUSES.map((item) => (
                <option key={item} value={item}>{STATUS_LABEL[item]}</option>
              ))}
            </select>
          </div>
          <div className="new-project-field">
            <span className="new-project-label">重要度</span>
            <select className="new-project-input" value={importance} onChange={(event) => setImportance(Number(event.target.value))}>
              <option value={0}>普通</option>
              <option value={1}>重要</option>
              <option value={2}>高</option>
              <option value={3}>关键</option>
            </select>
          </div>
          <label className="new-project-field">
            <span className="new-project-label">标签</span>
            <input
              className="new-project-input"
              value={tags}
              placeholder="逗号分隔"
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          {error ? <div className="project-memory-modal-error">{error}</div> : null}
          {editing && editing.evidence.length > 0 ? (
            <div className="project-memory-evidence-hint">
              证据（Agent 沉淀时自动附加，不可在此编辑）：
              {editing.evidence.map((ev) => `${ev.evidenceKind}:${ev.refTitle ?? ev.refId}`).join(" · ")}
            </div>
          ) : null}
        </div>
        <div className="new-project-modal-foot">
          {editing && !archived && onDelete ? (
            <button type="button" className="btn danger" disabled={busy} onClick={onDelete}>
              删除
            </button>
          ) : (
            <span className="new-project-foot-hint">
              {archived
                ? "项目已归档，只读。"
                : "只写长期有效的事实、决策、约束和风险，不要存聊天摘要或临时进度。"}
            </span>
          )}
          <div className="new-project-foot-actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="button" className="btn primary" disabled={archived || busy} onClick={() => void submit()}>
              {editing ? "保存" : "创建"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

