import { useEffect, useMemo, useState } from "react";
import { LIBRARY_TITLE_MAX_CHARS, type LibraryContentDto, type LibraryItemDto } from "../../../../../shared/library-ipc";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import Markdown from "@/components/common/Markdown";
import { IconChevronLeft, IconFolderOpen, IconTrash } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";

interface Props {
  itemId: string;
  onBack: () => void;
  onRenamed: (item: LibraryItemDto) => void;
  onDeleted: () => void;
  onToast: (text: string) => void;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (/[",\n]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`;
          return cell;
        })
        .join(","),
    )
    .join("\n");
}

const KIND_LABEL: Record<string, string> = {
  markdown: "文档",
  html: "页面",
  csv: "表格",
  url: "链接",
};

const DEFAULT_TITLES = new Set(["未命名文档", "未命名页面", "未命名表格"]);

function isSeedMarkdown(draft: string, title: string): boolean {
  const trimmed = draft.trim();
  return trimmed.length === 0 || trimmed === `# ${title}` || trimmed === `# ${title.trim()}`;
}

export default function LibraryDocumentView({ itemId, onBack, onRenamed, onDeleted, onToast }: Props): React.JSX.Element {
  const [payload, setPayload] = useState<LibraryContentDto | null>(null);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachedTaskId, setAttachedTaskId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [pendingLeave, setPendingLeave] = useState(false);
  const [busy, setBusy] = useState(false);

  const activeTaskId = useAppStore.getState().activeTaskId;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.api?.library.readContent(itemId);
        if (cancelled) return;
        if (!res?.ok) {
          setError(res && "error" in res ? res.error : "无法读取文档");
          return;
        }
        setPayload(res.value);
        setTitle(res.value.item.title);
        setDraft(res.value.content);
        setDirty(false);
        const kind = res.value.item.kind;
        const seed =
          kind === "markdown" && isSeedMarkdown(res.value.content, res.value.item.title);
        setMode(kind === "csv" || seed || DEFAULT_TITLES.has(res.value.item.title) ? "edit" : kind === "html" || kind === "markdown" ? "preview" : "edit");
        void window.api?.library.markVisited(itemId);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取文档");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    let cancelled = false;
    if (!activeTaskId) return;
    void window.api?.library.listTaskReferences(activeTaskId).then((res) => {
      if (cancelled || !res?.ok) return;
      setAttachedTaskId(
        res.value.items.some((row) => row.id === itemId) ? activeTaskId : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, activeTaskId]);

  const csvRows = useMemo(() => (payload?.item.kind === "csv" ? parseCsv(draft) : []), [payload?.item.kind, draft]);

  const requestBack = (): void => {
    if (dirty) setPendingLeave(true);
    else onBack();
  };

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.api?.library.deleteItem(itemId);
      if (res?.ok) onDeleted();
      else if (res && "error" in res) onToast(res.error);
    } finally {
      setBusy(false);
      setPendingDelete(false);
    }
  };

  const save = async (nextTitle = title, nextDraft = draft): Promise<void> => {
    if (!payload) return;
    setSaving(true);
    try {
      if (nextTitle.trim() && nextTitle.trim() !== payload.item.title) {
        const renamed = await window.api?.library.updateItem({ id: itemId, title: nextTitle.trim() });
        if (renamed?.ok) {
          setPayload((prev) => (prev ? { ...prev, item: renamed.value } : prev));
          onRenamed(renamed.value);
        }
      }
      if (!payload.requiresFileAccess) {
        const written = await window.api?.library.writeContent({ id: itemId, content: nextDraft });
        if (written?.ok) {
          setPayload((prev) => (prev ? { ...prev, item: written.value, content: nextDraft } : prev));
          setDirty(false);
          onToast("已保存");
        } else if (written && "error" in written) {
          onToast(written.error);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const setCell = (r: number, c: number, value: string): void => {
    const next = csvRows.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? value : cell)));
    setDraft(serializeCsv(next));
    setDirty(true);
  };

  if (error) {
    return (
      <div className="library-doc">
        <button type="button" className="library-back" onClick={onBack} title="返回">
          <IconChevronLeft size={16} />
        </button>
        <div className="library-empty">{error}</div>
      </div>
    );
  }
  if (!payload) {
    return <div className="library-empty">正在打开…</div>;
  }

  const kind = payload.item.kind;
  const previewUrl = payload.previewUrl;
  const kindLabel = KIND_LABEL[kind] ?? kind;
  const seedPreview = kind === "markdown" && mode === "preview" && isSeedMarkdown(draft, title);

  return (
    <div className="library-doc">
      <header className="library-doc-bar">
        <div className="library-doc-bar-left">
          <button type="button" className="library-back" onClick={requestBack} title="返回">
            <IconChevronLeft size={16} />
          </button>
          <div className="library-doc-identity">
            <input
              className="library-doc-title"
              maxLength={LIBRARY_TITLE_MAX_CHARS}
              value={title}
              placeholder="文档标题"
              aria-label="文档标题"
              onFocus={(event) => {
                if (DEFAULT_TITLES.has(title)) event.currentTarget.select();
              }}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
              onBlur={() => {
                if (dirty) void save();
              }}
            />
            <div className="library-doc-meta">
              <span>{kindLabel}</span>
              <span className="library-doc-dot" aria-hidden />
              <span className={dirty ? "is-dirty" : ""}>
                {saving ? "保存中…" : dirty ? "未保存" : "已保存"}
              </span>
            </div>
          </div>
        </div>
        <div className="library-doc-bar-right">
          {(kind === "markdown" || kind === "html") && (
            <div className="library-seg" role="tablist" aria-label="预览或编辑">
              <button
                type="button"
                className={mode === "preview" ? "active" : ""}
                onClick={() => setMode("preview")}
              >
                预览
              </button>
              <button
                type="button"
                className={mode === "edit" ? "active" : ""}
                onClick={() => setMode("edit")}
              >
                编辑
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "保存中" : "保存"}
          </button>
          <button
            type="button"
            className="btn"
            title="在资源管理器中显示"
            onClick={() => void window.api?.library.showInFolder(itemId)}
          >
            <IconFolderOpen size={14} />
            打开位置
          </button>
          {attachedTaskId ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.api?.library.detachFromTask({ itemId, taskId: attachedTaskId }).then((res) => {
                  if (res?.ok) {
                    setAttachedTaskId(null);
                    onToast("已从任务移除");
                  } else if (res && "error" in res) onToast(res.error);
                });
              }}
            >
              解除附加
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!activeTaskId}
              title={activeTaskId ? "附加到当前任务" : "请先打开一个任务"}
              onClick={() => {
                if (!activeTaskId) {
                  onToast("请先打开一个任务，再附加资料");
                  return;
                }
                void window.api?.library.attachToTask({ itemId, taskId: activeTaskId }).then((res) => {
                  if (res?.ok) {
                    setAttachedTaskId(activeTaskId);
                    onToast("已附加到当前任务");
                  } else if (res && "error" in res) onToast(res.error);
                });
              }}
            >
              附加到任务
            </button>
          )}
          <button
            type="button"
            className="icon-btn library-doc-delete"
            title="删除资料"
            aria-label="删除资料"
            onClick={() => setPendingDelete(true)}
          >
            <IconTrash size={15} />
          </button>
        </div>
      </header>

      <div className={`library-doc-body${mode === "edit" && (kind === "markdown" || kind === "html") ? " is-editing" : ""}`}>
        {payload.requiresFileAccess ? (
          <div className="library-empty">
            <strong>二进制文件</strong>
            <p className="library-url-line">{payload.managedPath ?? "（无受管路径）"}</p>
            <p className="library-save-hint">
              {kindLabel} · {payload.item.sizeBytes} 字节
              {payload.item.sourceType ? ` · 来源 ${payload.item.sourceType}` : ""}
              。资料库不提供内联编辑，请用「打开位置」或预览工具处理。
            </p>
          </div>
        ) : kind === "url" && payload.item.url ? (
          <div className="library-empty">
            <strong>链接资料</strong>
            <p className="library-url-line">{payload.item.url}</p>
            <div className="library-url-actions">
              <button
                type="button"
                className="btn"
                onClick={() => window.api?.browser.openExternal(payload.item!.url)}
              >
                在浏览器打开
              </button>
            </div>
          </div>
        ) : kind === "markdown" && mode === "preview" ? (
          seedPreview ? (
            <div className="library-empty">
              <strong>还没有正文</strong>
              点「编辑」开始写，或直接改标题。
            </div>
          ) : (
            <div className="library-md-preview">
              <Markdown variant="document">{draft}</Markdown>
            </div>
          )
        ) : kind === "html" && mode === "preview" && previewUrl ? (
          <iframe className="library-html-frame" title={payload.item.title} src={previewUrl} />
        ) : kind === "csv" ? (
          <div className="library-csv">
            <table>
              <tbody>
                {csvRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className={ri === 0 ? "is-head" : undefined}>
                        <input value={cell} onChange={(e) => setCell(ri, ci, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="library-csv-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const width = Math.max(...csvRows.map((r) => r.length), 1);
                  setDraft(serializeCsv([...csvRows, Array.from({ length: width }, () => "")]));
                  setDirty(true);
                }}
              >
                添加行
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const next = csvRows.map((row) => [...row, ""]);
                  setDraft(serializeCsv(next.length ? next : [["", ""]]));
                  setDirty(true);
                }}
              >
                添加列
              </button>
            </div>
          </div>
        ) : kind === "markdown" || kind === "html" ? (
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            placeholder={kind === "markdown" ? "用 Markdown 写正文…" : "写入 HTML…"}
          />
        ) : (
          <div className="library-empty">
            <strong>此类型暂不在资料库内编辑</strong>
            可在资源管理器中打开，或让 Agent 读取该文件。
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="删除这份资料？"
        body="删除后无法恢复，绑定本项目的任务也将无法再引用它。"
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(false)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={pendingLeave}
        title="放弃未保存的修改？"
        body="离开后，尚未保存的标题和正文会丢失。"
        confirmLabel="离开"
        danger
        onCancel={() => setPendingLeave(false)}
        onConfirm={() => {
          setPendingLeave(false);
          onBack();
        }}
      />
    </div>
  );
}

