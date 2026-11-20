import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_WORKSPACE_ICON, WORKSPACE_ICON_COLORS, WORKSPACE_ICON_GROUPS, WORKSPACE_ICON_SHAPES,
  type WorkspaceIconAppearance,
} from "@shared/workspace-icon";
import { IconCheck, IconX } from "@/components/common/icons";
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
  const shapeList = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [draft, setDraft] = useState(icon ?? DEFAULT_WORKSPACE_ICON);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useBlockNativeSurfaces(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const initial = icon ?? DEFAULT_WORKSPACE_ICON;
  const changed = draft.shape !== initial.shape || draft.color !== initial.color;
  const isDefault = draft.shape === DEFAULT_WORKSPACE_ICON.shape && draft.color === DEFAULT_WORKSPACE_ICON.color;
  const term = search.trim().toLowerCase();
  const shapeTerm = term.replace(/\s+/g, "-");
  const shapeGroups = WORKSPACE_ICON_GROUPS.map((group) => ({
    label: group.label,
    options: group.shapes.filter(([id, label]) =>
      group.label.includes(term) || label.includes(term) || id.includes(shapeTerm),
    ),
  })).filter((group) => group.options.length > 0);
  const shapeLabel = WORKSPACE_ICON_SHAPES.find(([id]) => id === draft.shape)?.[1];

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
        <div className="workspace-icon-preview">
          <span className="workspace-detail-icon"><WorkspaceIcon icon={draft} open={folderOpen} size={24} /></span>
          <div>
            <strong title={name}>{name}</strong>
            <small>{shapeLabel} · {workspaceIconColors[draft.color].label}</small>
          </div>
        </div>
        <fieldset disabled={saving}>
          <legend>形状</legend>
          <input type="search" className="workspace-icon-search" aria-label="搜索工作空间图标"
            placeholder={`搜索 ${WORKSPACE_ICON_SHAPES.length} 个图标`} value={search}
            onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            onChange={(event) => {
              setSearch(event.target.value);
              if (shapeList.current) shapeList.current.scrollTop = 0;
            }} />
          <div className="workspace-icon-shape-list" ref={shapeList}>
            {shapeGroups.map((group) => (
              <div key={group.label} className="workspace-icon-shape-group">
                <div className="workspace-icon-group-label">{group.label}</div>
                <div className="workspace-icon-shapes">
                  {group.options.map(([shape, label]) => (
                    <label className="workspace-icon-option" key={shape} title={label}>
                      <input type="radio" name="shape" aria-label={label} value={shape} checked={draft.shape === shape}
                        onChange={() => setDraft((current) => ({ ...current, shape }))} />
                      <span className="workspace-icon-choice">
                        <WorkspaceIcon icon={{ shape, color: "default" }} size={19} />
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {shapeGroups.length === 0 && <p className="workspace-icon-group-label" role="status">没有匹配的图标</p>}
          </div>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>颜色</legend>
          <div className="workspace-icon-colors">
            {WORKSPACE_ICON_COLORS.map((color) => {
              const { label, value } = workspaceIconColors[color];
              return (
                <label className="workspace-icon-option" key={color} title={label}>
                  <input type="radio" name="color" aria-label={label} value={color} checked={draft.color === color}
                    onChange={() => setDraft((current) => ({ ...current, color }))} />
                  <span className="workspace-icon-choice">
                    <span className="workspace-icon-swatch" style={{ backgroundColor: value }}>
                      {draft.color === color && <IconCheck size={13} />}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {error && <p className="workspace-icon-error" role="alert">图标保存失败，请重试。</p>}
        <footer className="workspace-icon-dialog-actions">
          <button type="button" className="btn btn--ghost" disabled={saving || isDefault}
            onClick={() => setDraft(DEFAULT_WORKSPACE_ICON)}>恢复默认</button>
          <button type="button" className="btn" disabled={saving} onClick={close}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={saving || !changed}>
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
