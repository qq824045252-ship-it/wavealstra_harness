import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WelcomeMode } from "@shared/agent-ipc";
import PopupContextMenu from "@/components/common/PopupContextMenu";
import {
  IconChevronRight,
  IconMore,
  IconPencil,
  IconPlus,
  IconRotate,
  IconTrash,
} from "@/components/common/icons";
import {
  HERO_SUGGEST_MAX,
  addHeroSuggestion,
  browserHeroSuggestStorage,
  editHeroSuggestion,
  loadHeroSuggestStore,
  removeHeroSuggestion,
  resolveHeroSuggestions,
  sceneHasCustomHeroSuggestions,
  writeHeroSuggestions,
  type HeroSuggestStore,
} from "./heroSuggest";
import { heroSuggestions } from "./heroCopy";

type EditorState = { mode: "add" } | { mode: "edit"; original: string };

type MenuState =
  | { kind: "chip"; x: number; y: number; prompt: string }
  | { kind: "add"; x: number; y: number };

interface Props {
  welcomeMode: WelcomeMode;
  presetId: string | null | undefined;
  onSelect: (prompt: string) => void;
  onPromptRenamed?: (from: string, to: string) => void;
  onPromptRemoved?: (prompt: string) => void;
}

export default function HeroSuggestChips({
  welcomeMode,
  presetId,
  onSelect,
  onPromptRenamed,
  onPromptRemoved,
}: Props): React.JSX.Element {
  const storage = browserHeroSuggestStorage();
  const [store, setStore] = useState<HeroSuggestStore>(() => loadHeroSuggestStore(storage));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const suggestions = useMemo(
    () => resolveHeroSuggestions(welcomeMode, presetId, store),
    [welcomeMode, presetId, store],
  );
  const customized = sceneHasCustomHeroSuggestions(welcomeMode, presetId, store);
  const atLimit = suggestions.length >= HERO_SUGGEST_MAX;

  const persist = (list: readonly string[]): void => {
    setStore((prev) => writeHeroSuggestions(storage, prev, welcomeMode, presetId, list));
  };

  const openAdd = (): void => {
    if (atLimit) return;
    setMenu(null);
    setEditor({ mode: "add" });
  };

  const openEdit = (prompt: string): void => {
    setMenu(null);
    setEditor({ mode: "edit", original: prompt });
  };

  const removePrompt = (prompt: string): void => {
    setMenu(null);
    persist(removeHeroSuggestion(suggestions, prompt));
    onPromptRemoved?.(prompt);
  };

  const restoreDefaults = (): void => {
    setMenu(null);
    persist(heroSuggestions(welcomeMode, presetId));
  };

  const saveEditor = (text: string): string | null => {
    if (!editor) return null;
    if (editor.mode === "add") {
      const result = addHeroSuggestion(suggestions, text);
      if (!result.ok) return result.error;
      persist(result.list);
      setEditor(null);
      return null;
    }
    const result = editHeroSuggestion(suggestions, editor.original, text);
    if (!result.ok) return result.error;
    const index = suggestions.indexOf(editor.original);
    persist(result.list);
    const nextValue = result.list[index];
    if (nextValue && nextValue !== editor.original) {
      onPromptRenamed?.(editor.original, nextValue);
    }
    setEditor(null);
    return null;
  };

  return (
    <div className="hero-suggest">
      {suggestions.map((prompt) => (
        <div key={prompt} className="hero-suggest-item">
          <button
            type="button"
            className="hero-suggest-chip"
            onClick={() => onSelect(prompt)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ kind: "chip", x: event.clientX, y: event.clientY, prompt });
            }}
          >
            <span className="hero-suggest-text">{prompt}</span>
            <IconChevronRight size={14} className="hero-suggest-arrow" />
          </button>
          <button
            type="button"
            className="hero-suggest-more"
            aria-label={`管理「${prompt}」`}
            title="修改或删除"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ kind: "chip", x: rect.left, y: rect.bottom + 4, prompt });
            }}
          >
            <IconMore size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="hero-suggest-chip hero-suggest-add"
        aria-label="添加常用词"
        title={atLimit ? `最多 ${HERO_SUGGEST_MAX} 条` : "添加常用词"}
        disabled={atLimit}
        onClick={openAdd}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ kind: "add", x: event.clientX, y: event.clientY });
        }}
      >
        <IconPlus size={15} strokeWidth={2.2} />
      </button>

      {menu?.kind === "chip" && (
        <PopupContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" className="task-context-item" onClick={() => openEdit(menu.prompt)}>
            <IconPencil size={14} /> 修改
          </button>
          <button
            type="button"
            className="task-context-item danger"
            onClick={() => removePrompt(menu.prompt)}
          >
            <IconTrash size={14} /> 删除
          </button>
        </PopupContextMenu>
      )}
      {menu?.kind === "add" && (
        <PopupContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" className="task-context-item" disabled={atLimit} onClick={openAdd}>
            <IconPlus size={14} /> 添加常用词
          </button>
          <button
            type="button"
            className="task-context-item"
            disabled={!customized}
            onClick={restoreDefaults}
          >
            <IconRotate size={14} /> 恢复默认
          </button>
        </PopupContextMenu>
      )}

      {editor && (
        <HeroSuggestEditor
          title={editor.mode === "add" ? "添加常用词" : "修改常用词"}
          initialValue={editor.mode === "edit" ? editor.original : ""}
          confirmLabel={editor.mode === "add" ? "添加" : "保存"}
          showRestore={editor.mode === "add" && customized}
          onRestore={restoreDefaults}
          onCancel={() => setEditor(null)}
          onConfirm={saveEditor}
        />
      )}
    </div>
  );
}

function HeroSuggestEditor({
  title,
  initialValue,
  confirmLabel,
  showRestore,
  onRestore,
  onCancel,
  onConfirm,
}: {
  title: string;
  initialValue: string;
  confirmLabel: string;
  showRestore: boolean;
  onRestore: () => void;
  onCancel: () => void;
  onConfirm: (text: string) => string | null;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const submit = (): void => {
    const message = onConfirm(value);
    if (message) setError(message);
  };

  return createPortal(
    <div
      className="modal-overlay full-access-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hero-suggest-editor-title"
      onClick={onCancel}
    >
      <div className="full-access-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="full-access-dialog-head">
          <h2 id="hero-suggest-editor-title" className="full-access-dialog-title">
            {title}
          </h2>
        </div>
        <div className="full-access-dialog-body">
          <p className="hero-suggest-editor-hint">点芯片会填进输入框；改动只作用于当前场景。</p>
          <input
            ref={inputRef}
            className="mcp-auth-input hero-suggest-editor-input"
            value={value}
            maxLength={80}
            placeholder="例如：帮我写周报"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          {error && <div className="hero-suggest-editor-error">{error}</div>}
        </div>
        <div className="full-access-dialog-actions">
          {showRestore && (
            <button
              type="button"
              className="btn hero-suggest-restore"
              onClick={() => {
                onRestore();
                onCancel();
              }}
            >
              恢复默认
            </button>
          )}
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
