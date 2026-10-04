import { useEffect, useMemo, useState } from "react";
import type { GadgetListItem, GadgetScope } from "@shared/gadget-types";

interface Props {
  scope: GadgetScope;
  onClose: () => void;
  onCreated: (item: GadgetListItem) => void;
}

function scopeDescription(scope: GadgetScope): string {
  if (scope.type === "global") return "创建到“我的小工具”，以后可在 MyBuddy 各处重复使用。";
  if (scope.type === "workspace") return "创建到当前工作空间；子工作空间可以继承使用。";
  return "创建到当前任务，仅在这个任务里使用。";
}

export default function GadgetCreateDialog({ scope, onClose, onCreated }: Props): React.JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const canCreate = Boolean(trimmedName) && !busy;
  const scopeHint = useMemo(() => scopeDescription(scope), [scope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const create = async (): Promise<void> => {
    if (!trimmedName) return;
    const api = window.api?.gadget;
    if (!api) {
      setError("Gadget 能力尚未加载，请重启 MyBuddy");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const source = html.trim();
      const descriptor = await api.create({
        name: trimmedName,
        description: description.trim() || undefined,
        scope,
        ...(source
          ? {
              entry: "index.html",
              files: [{ path: "index.html", content: source, encoding: "utf8" as const }],
            }
          : {}),
      });
      const runtime = await api.start(descriptor.id);
      onCreated({ ...descriptor, runtime });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="gadget-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="gadget-dialog gadget-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-gadget-title">
        <header>
          <div>
            <h2 id="create-gadget-title">新建 Gadget</h2>
            <p>{scopeHint}</p>
          </div>
          <button type="button" className="icon-btn" disabled={busy} onClick={onClose} aria-label="关闭">×</button>
        </header>

        <div className="gadget-create-form">
          <label className="gadget-create-field">
            <span>名称</span>
            <input
              autoFocus
              value={name}
              maxLength={120}
              placeholder="例如：标定参数对比"
              onChange={(event) => { setName(event.target.value); setError(null); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  void create();
                }
              }}
            />
          </label>

          <label className="gadget-create-field">
            <span>描述 <small>可选</small></span>
            <input
              value={description}
              maxLength={2000}
              placeholder="这个工具解决什么问题"
              onChange={(event) => { setDescription(event.target.value); setError(null); }}
            />
          </label>

          <label className="gadget-create-field gadget-create-field--html">
            <span>HTML <small>可选</small></span>
            <textarea
              value={html}
              spellCheck={false}
              placeholder="可直接粘贴完整 HTML。留空时会创建一个可运行的基础 Gadget。"
              onChange={(event) => { setHtml(event.target.value); setError(null); }}
            />
          </label>

          <div className="gadget-create-hint">
            创建后会立即启动并打开。已有 HTML 产物也可以从产物预览中使用“Convert to Gadget”。
          </div>
        </div>

        {error && <div className="gadget-error" role="alert">{error}</div>}

        <footer>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? "创建中…" : "创建并打开"}
          </button>
        </footer>
      </section>
    </div>
  );
}
