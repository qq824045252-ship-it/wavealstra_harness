import { useEffect, useRef, useState } from "react";
import Markdown from "@/components/common/Markdown";
import { IconMore, IconPiLogo, IconTrash } from "@/components/common/icons";
import {
  deriveProjectActivity,
  formatRelativeTime,
  projectBuddyName,
  type ProjectActivityItem,
} from "@/lib/projectWorkspace";
import { useAppStore } from "@/store/appStore";
import type { ProjectDetailsDto, ProjectEventDto, ProjectEventPromotionTargetKind, ProjectPostDto } from "@shared/project-domain";
import type { Task } from "@/types";

interface Props {
  project: ProjectDetailsDto;
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
}

const POST_CLAMP = 280;

const EVENT_SOURCE_LABEL: Record<string, string> = {
  gateway: "消息网关",
  cron: "定时任务",
  manual: "手动",
  document: "纪要/文档",
  mcp: "MCP",
};

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "我";
}

export default function ProjectActivity({ project, tasks, onOpenTask }: Props): React.JSX.Element {
  const soul = useAppStore((state) => state.soul);
  const userName = soul.alias.trim() || "我";
  const buddyName = projectBuddyName();
  const [posts, setPosts] = useState<ProjectPostDto[]>([]);
  const [events, setEvents] = useState<ProjectEventDto[]>([]);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<"related" | "all">("related");
  const [eventTriage, setEventTriage] = useState<"open" | "handled" | "all">("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menuId, setMenuId] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 事件提升（Event Triage）：promoting = 正在填写的目标；同一事件同类型只能提升一次（幂等由主进程保证） */
  const [promoting, setPromoting] = useState<{ eventId: string; targetKind: ProjectEventPromotionTargetKind } | null>(null);
  const [promoteFields, setPromoteFields] = useState({ title: "", content: "", kind: "fact", dueAt: "" });
  const [promotingBusy, setPromotingBusy] = useState(false);
  /** 文档/纪要导入（source=document 审计层；同文重复导入幂等由主进程内容哈希保证） */
  const [docComposing, setDocComposing] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docBody, setDocBody] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docDragOver, setDocDragOver] = useState(false);

  const reload = async (): Promise<void> => {
    setPosts((await window.api?.db?.listProjectPosts?.(project.id)) ?? []);
    setEvents((await window.api?.db?.listProjectEvents?.(project.id)) ?? []);
  };

  useEffect(() => {
    void reload();
    const unsubscribe = window.api?.db?.onProjectEventsChanged?.((change) => {
      if (change.projectId === project.id) void reload();
    });
    return unsubscribe;
  }, [project.id]);

  useEffect(() => {
    if (!composing) return;
    draftRef.current?.focus();
  }, [composing]);

  useEffect(() => {
    if (!menuId) return;
    const onDoc = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuId(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuId]);

  const publish = async (): Promise<void> => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api?.db?.createProjectPost?.({ projectId: project.id, body: draft.trim() });
      setDraft("");
      setComposing(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removePost = async (itemId: string): Promise<void> => {
    const postId = itemId.replace(/^post-/, "");
    setMenuId(null);
    setBusy(true);
    try {
      await window.api?.db?.deleteProjectPost?.(postId);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const eventIdFromItem = (itemId: string): string => itemId.replace(/^event-/, "");
  const eventById = (id: string): ProjectEventDto | undefined => events.find((event) => event.id === id);
  /** 有效状态：dismissed 或存在 promotion 链接 = 已处理（triage 元数据，不参与任何派生） */
  const eventHandled = (event: ProjectEventDto): boolean =>
    event.triageStatus === "dismissed" || (event.promotions?.length ?? 0) > 0;
  const openEventCount = events.filter((event) => !eventHandled(event)).length;

  const toggleEventTriage = async (eventId: string, status: "open" | "dismissed"): Promise<void> => {
    try {
      if (status === "dismissed") {
        await window.api?.db?.dismissProjectEvent?.(project.id, eventId);
      } else {
        await window.api?.db?.reopenProjectEvent?.(project.id, eventId);
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const promoteLabel = (targetKind: ProjectEventPromotionTargetKind): string =>
    targetKind === "memory" ? "记忆" : targetKind === "todo" ? "计划" : "资料";

  const startPromote = (eventId: string, targetKind: ProjectEventPromotionTargetKind): void => {
    setError(null);
    setPromoteFields({ title: "", content: "", kind: "fact", dueAt: "" });
    setPromoting({ eventId, targetKind });
  };

  /** YYYY-MM-DD（可选）→ epoch ms（本地午夜）；非法/空 → undefined */
  const parseDueDate = (raw: string): number | undefined => {
    const value = raw.trim();
    if (!value) return undefined;
    const at = new Date(`${value}T00:00:00`).getTime();
    return Number.isNaN(at) ? undefined : at;
  };

  const submitPromote = async (eventId: string): Promise<void> => {
    if (!promoting || promotingBusy) return;
    setPromotingBusy(true);
    setError(null);
    try {
      const base = { eventId, targetKind: promoting.targetKind };
      const request =
        promoting.targetKind === "memory"
          ? {
              ...base,
              memoryKind: promoteFields.kind as "fact" | "decision" | "constraint" | "risk" | "open_question",
              memoryTitle: promoteFields.title,
              memoryContent: promoteFields.content || undefined,
            }
          : promoting.targetKind === "todo"
            ? { ...base, todoTitle: promoteFields.title, todoDueAt: parseDueDate(promoteFields.dueAt) }
            : { ...base, libraryTitle: promoteFields.title, libraryContent: promoteFields.content };
      await window.api?.db?.promoteProjectEvent?.(request);
      setPromoting(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPromotingBusy(false);
    }
  };

  const submitDoc = async (): Promise<void> => {
    if (docBusy) return;
    setDocBusy(true);
    setDocError(null);
    try {
      await window.api?.db?.ingestProjectDocument?.(project.id, { title: docTitle.trim(), body: docBody.trim() });
      setDocComposing(false);
      setDocTitle("");
      setDocBody("");
      await reload();
    } catch (cause) {
      setDocError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDocBusy(false);
    }
  };

  /** 文件级导入（Library-first：主进程落资料库真源 + document 事件；同文件幂等） */
  const importByPath = async (filePath: string): Promise<boolean> => {
    try {
      await window.api?.db?.importProjectFile?.(project.id, filePath);
      return true;
    } catch (cause) {
      setDocError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const importDocFiles = async (files: FileList | File[]): Promise<void> => {
    if (docBusy) return;
    setDocBusy(true);
    setDocError(null);
    try {
      let imported = 0;
      for (const file of Array.from(files)) {
        const filePath = window.api?.getPathForFile?.(file);
        if (!filePath) {
          setDocError("无法获取文件路径，请改用「选择文件」按钮。");
          break;
        }
        if (await importByPath(filePath)) imported += 1;
      }
      if (imported > 0) {
        setDocComposing(false);
        setDocTitle("");
        setDocBody("");
        await reload();
      }
    } finally {
      setDocBusy(false);
    }
  };

  const pickAndImportDoc = async (): Promise<void> => {
    if (docBusy) return;
    setDocBusy(true);
    setDocError(null);
    try {
      const filePath = await window.api?.db?.pickImportFile?.();
      if (filePath && (await importByPath(filePath))) {
        setDocComposing(false);
        await reload();
      }
    } finally {
      setDocBusy(false);
    }
  };

  const items = deriveProjectActivity({
    project,
    tasks: tasks.filter((task) => task.projectId === project.id),
    posts,
    events,
  });
  const visibleItems = (
    feed === "related"
      ? items.filter((item) => item.kind === "post" || item.kind === "welcome" || item.kind === "event")
      : items
  ).filter((item) => {
    // 事件按 triage 有效状态过滤（posts/tasks 不受影响）
    if (item.kind !== "event" || eventTriage === "all") return true;
    const event = eventById(eventIdFromItem(item.id));
    if (!event) return true;
    return eventHandled(event) ? eventTriage === "handled" : eventTriage === "open";
  });

  const actorName = (item: ProjectActivityItem): string => {
    if (item.actor === "user") return userName;
    if (item.actor === "buddy") return buddyName;
    return "系统";
  };

  return (
    <div className="project-desk-pane project-activity" aria-label="项目动态">
      <div className="project-activity-toolbar">
        <div className="project-activity-cluster">
          <button
            type="button"
            className="btn primary project-activity-compose-btn"
            disabled={busy}
            onClick={() => setComposing(true)}
          >
            + 发布留言
          </button>
          <button
            type="button"
            className="btn project-activity-compose-btn"
            disabled={docBusy}
            onClick={() => {
              setDocComposing((value) => !value);
              setDocError(null);
            }}
          >
            导入纪要/文档
          </button>
        </div>
        <div className="project-activity-cluster">
          <div className="project-seg project-activity-seg">
            <button
              type="button"
              className={feed === "related" ? "active" : ""}
              onClick={() => setFeed("related")}
            >
              与我相关
            </button>
            <button
              type="button"
              className={feed === "all" ? "active" : ""}
              onClick={() => setFeed("all")}
            >
              成员动态
            </button>
          </div>
        </div>
        <div className="project-activity-cluster">
          <span className="project-activity-filter-label">事件</span>
          <div className="project-seg project-activity-seg">
            <button
              type="button"
              className={eventTriage === "open" ? "active" : ""}
              onClick={() => setEventTriage("open")}
            >
              待处理{openEventCount > 0 ? ` ${openEventCount}` : ""}
            </button>
            <button
              type="button"
              className={eventTriage === "handled" ? "active" : ""}
              onClick={() => setEventTriage("handled")}
            >
              已处理
            </button>
            <button
              type="button"
              className={eventTriage === "all" ? "active" : ""}
              onClick={() => setEventTriage("all")}
            >
              全部
            </button>
          </div>
        </div>
      </div>

      {composing && (
        <div className="project-post-box">
          <textarea
            ref={draftRef}
            id="project-post-draft"
            value={draft}
            placeholder="写一条项目留言…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setComposing(false);
                return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void publish();
              }
            }}
          />
          {error && <div className="project-form-error">{error}</div>}
          <div className="project-post-box-foot">
            <span className="project-post-box-hint">Ctrl+Enter 发布</span>
            <button type="button" className="btn" disabled={busy} onClick={() => setComposing(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary project-post-submit"
              disabled={busy || !draft.trim()}
              onClick={() => void publish()}
            >
              发布
            </button>
          </div>
        </div>
      )}

      {docComposing && (
        <div className="project-doc-box">
          <div
            className={`project-doc-dropzone${docDragOver ? " active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDocDragOver(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDocDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDocDragOver(false);
              void importDocFiles(event.dataTransfer.files);
            }}
          >
            拖入文件导入（md/txt/docx/pptx/xlsx/pdf…），或点击下方「选择文件」
          </div>
          <input
            className="project-doc-title"
            value={docTitle}
            placeholder="标题（必填，≤200 字符）"
            maxLength={200}
            onChange={(event) => setDocTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDocComposing(false);
                setDocError(null);
              }
            }}
          />
          <textarea
            value={docBody}
            placeholder="或粘贴会议纪要/文档正文…（≤4000 字符；同内容重复导入不会重复记录）"
            maxLength={4000}
            onChange={(event) => setDocBody(event.target.value)}
          />
          {docError && <div className="project-form-error">{docError}</div>}
          <div className="project-doc-box-foot">
            <span className="project-doc-count">{docBody.length}/4000</span>
            <button type="button" className="btn" disabled={docBusy} onClick={() => void pickAndImportDoc()}>
              选择文件…
            </button>
            <button type="button" className="btn" disabled={docBusy} onClick={() => setDocComposing(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={docBusy || !docTitle.trim() || !docBody.trim()}
              onClick={() => void submitDoc()}
            >
              记录
            </button>
          </div>
        </div>
      )}

      <div className="project-activity-feed">
        {visibleItems.length === 0 ? (
          <div className="project-empty-state project-activity-empty">
            <strong>这里还没有动态</strong>
            <span>
              {feed === "related" && eventTriage === "all"
                ? "还没有和你相关的留言。任务更新、外部事件和项目留言会出现在这里。"
                : "当前筛选下没有条目，可以调整上方筛选查看全部动态。"}
            </span>
          </div>
        ) : (
          visibleItems.map((item) => {
            const taskId = item.kind === "task" ? item.id.replace(/^task-/, "") : null;
            const long = item.kind === "post" && item.title.length > POST_CLAMP;
            const open = Boolean(expanded[item.id]);
            const body = long && !open ? `${item.title.slice(0, POST_CLAMP).trimEnd()}…` : item.title;
            const name = actorName(item);
            return (
              <article key={item.id} className={`project-feed-item actor-${item.actor} kind-${item.kind}`}>
                {item.actor === "user" ? (
                  <span className="project-feed-avatar user">{initialOf(name)}</span>
                ) : item.actor === "buddy" ? (
                  <span className="project-feed-avatar buddy" title={name}>
                    <IconPiLogo size={15} />
                  </span>
                ) : (
                  <span className="project-feed-avatar system" title={name}>
                    <IconPiLogo size={12} />
                  </span>
                )}
                <div className="project-feed-body">
                  <div className="project-feed-head">
                    <div className="project-feed-meta">
                      <strong className="project-feed-name">{name}</strong>
                      <span className="project-feed-dot">·</span>
                      <span>{formatRelativeTime(item.at)}</span>
                    </div>
                    {item.kind === "post" && (
                      <div className="project-feed-more-wrap" ref={menuId === item.id ? menuRef : undefined}>
                        <button
                          type="button"
                          className="project-feed-more-btn"
                          aria-label="更多"
                          onClick={() => setMenuId(menuId === item.id ? null : item.id)}
                        >
                          <IconMore size={16} />
                        </button>
                        {menuId === item.id && (
                          <div className="project-feed-menu">
                            <button type="button" className="danger" onClick={() => void removePost(item.id)}>
                              <IconTrash size={13} /> 删除
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {taskId ? (
                    <button type="button" className="project-feed-title" onClick={() => onOpenTask(taskId)}>
                      {item.title}
                    </button>
                  ) : item.kind === "welcome" ? (
                    <div className="project-feed-md">
                      <Markdown>{item.title}</Markdown>
                    </div>
                  ) : (
                    <p className="project-feed-copy">{body}</p>
                  )}
                  {item.detail ? <div className="project-feed-detail">{item.detail}</div> : null}
                  {item.kind === "event" &&
                    (() => {
                      const event = eventById(eventIdFromItem(item.id));
                      if (!event) return null;
                      const promotions = event.promotions ?? [];
                      const done = new Set(promotions.map((p) => p.targetKind));
                      const open = promoting?.eventId === event.id;
                      /** 文件导入事件已关联资料库真源：不再提供「存为资料」入口 */
                      const libraryBacked = typeof event.payload?.libraryItemId === "string";
                      return (
                        <>
                          <div className="project-event-source">
                            <span className="project-event-chip">{EVENT_SOURCE_LABEL[event.source] ?? event.source}</span>
                            {event.triageStatus === "dismissed" && <span className="project-event-chip handled">已处理</span>}
                          </div>
                          <div className="project-event-promo">
                          {promotions.length > 0 && (
                            <div className="project-event-promo-chips">
                              {promotions.map((promotion) => (
                                <span key={promotion.id} className="project-event-promo-chip">
                                  已提升→{promoteLabel(promotion.targetKind)}「{promotion.targetTitle ?? promotion.targetId}」
                                </span>
                              ))}
                            </div>
                          )}
                          {!open && (
                            <div className="project-event-promo-actions">
                              {event.triageStatus === "dismissed" ? (
                                <button
                                  type="button"
                                  className="project-event-promo-btn"
                                  onClick={() => void toggleEventTriage(event.id, "open")}
                                >
                                  恢复
                                </button>
                              ) : done.size === 0 ? (
                                <button
                                  type="button"
                                  className="project-event-promo-btn"
                                  onClick={() => void toggleEventTriage(event.id, "dismissed")}
                                >
                                  已处理
                                </button>
                              ) : null}
                              {libraryBacked && !done.has("library") && (
                                <span className="project-event-promo-chip">已入资料库</span>
                              )}
                              {( ["memory", "todo", "library"] as const ).map((kind) =>
                                done.has(kind) || (libraryBacked && kind === "library") ? null : (
                                  <button
                                    key={kind}
                                    type="button"
                                    className="project-event-promo-btn"
                                    onClick={() => startPromote(event.id, kind)}
                                  >
                                    存为{promoteLabel(kind)}
                                  </button>
                                ),
                              )}
                            </div>
                          )}
                          {open && (
                            <div className="project-event-promo-form">
                              {promoting!.targetKind === "memory" && (
                                <>
                                  <select
                                    value={promoteFields.kind}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, kind: e.target.value }))}
                                  >
                                    <option value="fact">事实 fact</option>
                                    <option value="decision">决策 decision</option>
                                    <option value="constraint">约束 constraint</option>
                                    <option value="risk">风险 risk</option>
                                    <option value="open_question">待确认 open_question</option>
                                  </select>
                                  <input
                                    placeholder="标题（必填）"
                                    value={promoteFields.title}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, title: e.target.value }))}
                                  />
                                  <textarea
                                    placeholder="内容（可选）"
                                    value={promoteFields.content}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, content: e.target.value }))}
                                  />
                                </>
                              )}
                              {promoting!.targetKind === "todo" && (
                                <>
                                  <input
                                    placeholder="标题（必填）"
                                    value={promoteFields.title}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, title: e.target.value }))}
                                  />
                                  <input
                                    type="date"
                                    value={promoteFields.dueAt}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, dueAt: e.target.value }))}
                                  />
                                </>
                              )}
                              {promoting!.targetKind === "library" && (
                                <>
                                  <input
                                    placeholder="标题（必填）"
                                    value={promoteFields.title}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, title: e.target.value }))}
                                  />
                                  <textarea
                                    placeholder="正文（必填）"
                                    value={promoteFields.content}
                                    onChange={(e) => setPromoteFields((prev) => ({ ...prev, content: e.target.value }))}
                                  />
                                </>
                              )}
                              <div className="project-event-promo-form-foot">
                                <button type="button" className="btn" disabled={promotingBusy} onClick={() => setPromoting(null)}>
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="btn primary"
                                  disabled={promotingBusy || !promoteFields.title.trim()}
                                  onClick={() => void submitPromote(event.id)}
                                >
                                  提升
                                </button>
                              </div>
                            </div>
                          )}
                          </div>
                        </>
                      );
                    })()}
                  {long ? (
                    <button
                      type="button"
                      className="project-feed-more"
                      onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !open }))}
                    >
                      {open ? "收起" : "展开"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
