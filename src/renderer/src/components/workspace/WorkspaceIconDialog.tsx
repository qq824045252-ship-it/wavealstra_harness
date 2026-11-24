import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_WORKSPACE_ICON, WORKSPACE_ICON_COLORS, WORKSPACE_ICON_GROUPS, WORKSPACE_ICON_SHAPES,
  type WorkspaceIconAppearance,
} from "@shared/workspace-icon";
import { IconCheck, IconSearch, IconX } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import WorkspaceIcon, { workspaceIconColors } from "./WorkspaceIcon";
import "./WorkspaceIcon.css";

export default function WorkspaceIconDialog({ name, icon, folderOpen, onClose, onSave }: {
  name: string;
  icon?: WorkspaceIconAppearance;
  folderOpen: boolean;
  onClose: () => void;
  onSave: (icon: WorkspaceIconAppearance) => Promise<void>;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const shapeList = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const shapeCountId = useId();
  const initial = icon ?? DEFAULT_WORKSPACE_ICON;
  const [draft, setDraft] = useState(initial);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useBlockNativeSurfaces(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    searchInput.current?.focus();
    return () => element?.close();
  }, []);

  const changed = draft.shape !== initial.shape || draft.color !== initial.color;
  const isDefault = draft.shape === DEFAULT_WORKSPACE_ICON.shape && draft.color === DEFAULT_WORKSPACE_ICON.color;
  const term = search.trim().toLowerCase();
  const shapeTerm = term.replace(/\s+/g, "-");
  const shapeGroups = WORKSPACE_ICON_GROUPS.map((group) => ({
    label: group.label,
    options: group.shapes.filter(([id, label]) =>
      group.label.toLowerCase().includes(term) || label.toLowerCase().includes(term) || id.includes(shapeTerm),
    ),
  })).filter((group) => group.options.length > 0);
  const shapeCount = shapeGroups.reduce((total, group) => total + group.options.length, 0);
  const shapeLabel = WORKSPACE_ICON_SHAPES.find(([id]) => id === draft.shape)?.[1];

  const updateSearch = (value: string): void => {
    setSearch(value);
    if (shapeList.current) shapeList.current.scrollTop = 0;
  };

  const close = (): void => {
    dialog.current?.close();
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!changed || saving) return;
    setSaving(true);
    setError(false);
    try {
      await onSave(draft);
      close();
    } catch {
      setError(true);
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="workspace-icon-dialog" aria-labelledby={headingId}
      onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <header className="workspace-icon-dialog-header">
          <h2 id={headingId}>工作空间图标</h2>
          <button type="button" className="icon-btn" aria-label="关闭" disabled={saving} onClick={close}>
            <IconX size={17} />
          </button>
        </header>
        <div className="workspace-icon-dialog-body">
          <fieldset className="workspace-icon-library" disabled={saving}>
            <legend>图标库</legend>
            <div className="workspace-icon-searchbar">
              <IconSearch size={16} aria-hidden />
              <input ref={searchInput} type="search" className="workspace-icon-search"
                aria-label="搜索工作空间图标" aria-describedby={shapeCountId}
                placeholder="搜索图标名称或分类" value={search}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
                }} onChange={(event) => updateSearch(event.currentTarget.value)} />
              {search && (
                <button type="button" className="icon-btn" aria-label="清除搜索"
                  onClick={() => { updateSearch(""); searchInput.current?.focus(); }}>
                  <IconX size={14} />
                </button>
              )}
            </div>
            <p className="workspace-icon-search-count" id={shapeCountId} role="status">{shapeCount} 个图标</p>
            <div className="workspace-icon-shape-list" ref={shapeList}>
              {shapeGroups.map((group) => (
                <div key={group.label} className="workspace-icon-shape-group">
                  <h3>{group.label}</h3>
                  <div className="workspace-icon-shapes">
                    {group.options.map(([shape, label]) => (
                      <label className="workspace-icon-option" key={shape} title={label}>
                        <input type="radio" name="shape" aria-label={label} value={shape} checked={draft.shape === shape}
                          onChange={() => setDraft((current) => ({ ...current, shape }))} />
                        <span className="workspace-icon-choice" aria-hidden="true">
                          <WorkspaceIcon icon={{ shape, color: "default" }} size={20} />
                          <span className="workspace-icon-option-label">{label}</span>
                          {draft.shape === shape && <IconCheck className="workspace-icon-option-mark" size={12} />}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {shapeCount === 0 && <p className="workspace-icon-empty">没有找到匹配的图标</p>}
            </div>
          </fieldset>
          <div className="workspace-icon-customization">
            <div className="workspace-icon-preview">
              <h3>预览</h3>
              <span className="workspace-icon-preview-glyph">
                <WorkspaceIcon icon={draft} open={folderOpen} size={32} />
              </span>
              <strong title={name}>{name}</strong>
              <small>{shapeLabel} · {workspaceIconColors[draft.color].label}</small>
            </div>
            <fieldset className="workspace-icon-palette" disabled={saving}>
              <legend>颜色</legend>
              <div className="workspace-icon-colors">
                {WORKSPACE_ICON_COLORS.map((color) => {
                  const { label, value } = workspaceIconColors[color];
                  return (
                    <label className="workspace-icon-option" key={color}>
                      <input type="radio" name="color" aria-label={label} value={color} checked={draft.color === color}
                        onChange={() => setDraft((current) => ({ ...current, color }))} />
                      <span className="workspace-icon-choice" aria-hidden="true">
                        <span className="workspace-icon-swatch" style={{ backgroundColor: value }} />
                        <span className="workspace-icon-option-label">{label}</span>
                        {draft.color === color && <IconCheck className="workspace-icon-color-mark" size={13} />}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </div>
        <footer className="workspace-icon-dialog-footer">
          {error && <p className="workspace-icon-error" role="alert">图标保存失败，请重试。</p>}
          <div className="workspace-icon-dialog-actions">
            <button type="button" className="btn btn--ghost" disabled={saving || isDefault}
              onClick={() => setDraft(DEFAULT_WORKSPACE_ICON)}>恢复默认</button>
            <button type="button" className="btn" disabled={saving} onClick={close}>取消</button>
            <button type="submit" className="btn primary" disabled={saving || !changed}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
