import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@/components/common/icons";
import type { MemoryKind, MemoryRecordDto, MemoryStatus } from "@shared/memory-kernel";
import {
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_TITLE_MAX_CHARS,
} from "@shared/memory-kernel";
import "./WorkspaceMemorySection.css";

export const KIND_LABEL: Record<string, string> = {
  identity: "身份",
  preference: "偏好",
  fact: "事实",
  decision: "决策",
  constraint: "约束",
  risk: "风险",
  open_question: "待确认",
  progress: "进度",
  procedure: "流程",
};

export const STATUS_LABEL: Record<string, string> = {
  active: "有效",
  superseded: "已取代",
  resolved: "已解决",
  invalid: "无效",
};

export const IMPORTANCE_LABEL = ["普通", "重要", "高", "关键"] as const;

const SOURCE_LABEL: Record<string, string> = {
  user: "用户",
  agent: "Agent",
  tool: "工具",
  library: "资料",
  event: "事件",
  manual: "手动",
  import: "导入",
};

const EVIDENCE_KIND_LABEL: Record<string, string> = {
  conversation: "对话",
  message: "消息",
  task: "任务",
  artifact: "产物",
  library_item: "资料",
  library_chunk: "资料片段",
  project_event: "项目事件",
  agent_run: "Agent 运行",
  external: "外部",
};

export function formatMemoryTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(ts);
}

function formatAbsolute(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
}

export function otherWorkspaceScopes(memory: MemoryRecordDto, workspaceId: string): MemoryRecordDto["scopes"] {
  return memory.scopes.filter((scope) => scope.scopeType === "workspace" && scope.scopeId && scope.scopeId !== workspaceId);
}

export interface WorkspaceMemoryEditorProps {
  open: boolean;
  workspaceId: string;
  creating: boolean;
  memory: MemoryRecordDto | null;
  fallbackContent?: string;
  canManage: boolean;
  archived: boolean;
  sourceName?: string;
  onClose: () => void;
  onSaved: () => void;
  onRequestDelete?: () => void;
  onOpenSource?: () => void;
}

export default function WorkspaceMemoryEditor({
  open,
  workspaceId,
  creating,
  memory,
  fallbackContent,
  canManage,
  archived,
  sourceName,
  onClose,
  onSaved,
  onRequestDelete,
  onOpenSource,
}: WorkspaceMemoryEditorProps): React.JSX.Element | null {
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<MemoryStatus>("active");
  const [importance, setImportance] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editable = canManage && !archived && (creating || Boolean(memory));

  useEffect(() => {
    if (!open) return;
    setKind(memory?.kind ?? "fact");
    setTitle(memory?.title ?? "");
    setContent(memory?.content ?? fallbackContent ?? "");
    setStatus(memory?.status ?? "active");
    setImportance(memory?.importance ?? 0);
    setError(null);
    setBusy(false);
  }, [open, memory, fallbackContent, creating]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const heading = creating ? "新建记忆" : editable ? "编辑记忆" : "查看记忆";
  const extraScopes = memory ? otherWorkspaceScopes(memory, workspaceId) : [];

  const submit = async (): Promise<void> => {
    if (!editable || busy) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("标题不能为空");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        await window.api?.memory?.create({
          kind,
          title: nextTitle,
          content: content.trim(),
          status,
          importance,
          explicit: true,
          sourceType: "manual",
          scopeType: "workspace",
          scopeId: workspaceId,
        });
      } else if (memory) {
        await window.api?.memory?.update({
          id: memory.id,
          kind,
          title: nextTitle,
          content: content.trim(),
          status,
          importance,
          changedBy: "manual",
          changeReason: "workspace editor",
        });
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div
        className="new-project-modal workspace-memory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-memory-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="new-project-modal-head">
          <div id="workspace-memory-editor-title" className="new-project-modal-title">{heading}</div>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
        <div className={`new-project-modal-body${editable ? "" : " workspace-memory-modal-body-readonly"}`}>
          {editable ? (
            <>
              <div className="new-project-field">
                <span className="new-project-label">类型</span>
                <select className="new-project-input" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
                  {MEMORY_KINDS.map((item) => (
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
                  maxLength={MEMORY_TITLE_MAX_CHARS}
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="new-project-field">
                <span className="new-project-label">内容</span>
                <textarea
                  className="new-project-input workspace-memory-content-input"
                  rows={8}
                  value={content}
                  maxLength={MEMORY_CONTENT_MAX_CHARS}
                  placeholder="正文（可留空）"
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
              <div className="new-project-field">
                <span className="new-project-label">状态</span>
                <select className="new-project-input" value={status} onChange={(event) => setStatus(event.target.value as MemoryStatus)}>
                  {MEMORY_STATUSES.map((item) => (
                    <option key={item} value={item}>{STATUS_LABEL[item]}</option>
                  ))}
                </select>
              </div>
              <div className="new-project-field">
                <span className="new-project-label">重要度</span>
                <select className="new-project-input" value={importance} onChange={(event) => setImportance(Number(event.target.value))}>
                  {IMPORTANCE_LABEL.map((label, value) => (
                    <option key={label} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="workspace-memory-readonly-head">
                <h3>{memory?.title || "未命名记忆"}</h3>
                <div className="workspace-memory-readonly-chips">
                  {memory ? <span className="workspace-memory-kind">{KIND_LABEL[memory.kind] ?? memory.kind}</span> : null}
                  {memory ? <span className="workspace-memory-kind">{STATUS_LABEL[memory.status] ?? memory.status}</span> : null}
                  {memory ? <span className="workspace-memory-kind">重要度 {IMPORTANCE_LABEL[memory.importance] ?? memory.importance}</span> : null}
                </div>
              </div>
              <div className="workspace-memory-readonly-content">
                {memory?.content || fallbackContent || "（空内容）"}
              </div>
            </>
          )}

          {memory ? (
            <div className="workspace-memory-scope-note">
              来源：{SOURCE_LABEL[memory.sourceType] ?? memory.sourceType}
              {" · "}创建 {formatAbsolute(memory.createdAt)}
              {" · "}更新 {formatAbsolute(memory.updatedAt)}
              {sourceName ? ` · 归属 ${sourceName}` : ""}
              {extraScopes.length > 0 ? ` · 另绑定 ${extraScopes.length} 个工作空间` : ""}
            </div>
          ) : sourceName ? (
            <div className="workspace-memory-scope-note">归属 {sourceName}</div>
          ) : null}

          {memory && memory.evidence.length > 0 ? (
            <div className="workspace-memory-scope-note">
              证据：
              {memory.evidence.map((ev) => `${EVIDENCE_KIND_LABEL[ev.evidenceKind] ?? ev.evidenceKind}${ev.refTitle ? ` · ${ev.refTitle}` : ""}`).join("；")}
            </div>
          ) : null}

          {!editable && !creating ? (
            <div className="workspace-memory-scope-note">
              {archived
                ? "工作空间已归档，记忆只读。"
                : sourceName
                  ? `这条记忆继承自「${sourceName}」，请到来源工作空间编辑或删除。`
                  : "当前条目只读。"}
            </div>
          ) : null}

          {error ? <div className="project-memory-modal-error">{error}</div> : null}
        </div>
        <div className="new-project-modal-foot">
          {canManage && !creating && onRequestDelete ? (
            <button type="button" className="btn danger" disabled={busy || archived} onClick={onRequestDelete}>
              删除
            </button>
          ) : onOpenSource ? (
            <button type="button" className="btn" onClick={onOpenSource}>到来源空间</button>
          ) : (
            <span className="new-project-foot-hint">
              {creating ? "只写长期有效的事实、决策、约束和风险，不要存聊天摘要。" : ""}
            </span>
          )}
          <div className="new-project-foot-actions">
            <button type="button" className="btn" onClick={onClose}>关闭</button>
            {editable ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
                {creating ? "创建" : "保存"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
