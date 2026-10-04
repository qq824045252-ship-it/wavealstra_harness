import { useEffect, useId, useState } from "react";
import { IconX } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import { defaultModePresetId, WELCOME_MODE_LABELS, WELCOME_MODES, type WelcomeMode } from "@shared/mode-profile";
import { applyModeProfileResponse, emptyModeTagOptionLabel } from "@/lib/projectWorkspace";
import { listProjectTemplates } from "@shared/project-template";
import { resolveProjectTaskDefaults, resolveProjectTemplateTaskSuggestion } from "@shared/project-task-defaults";
import type { ModePresetDto } from "@shared/agent-ipc";
import type { ProjectDetailsDto } from "@shared/project-domain";

interface Props {
  open: boolean;
  project: ProjectDetailsDto;
  onClose: () => void;
}

export default function NewProjectTaskModal({
  open,
  project,
  onClose,
}: Props): React.JSX.Element | null {
  const titleId = useId();
  const spaces = useAppStore((state) => state.spaces);
  const tasks = useAppStore((state) => state.tasks);
  const startProjectTask = useAppStore((state) => state.startProjectTask);
  const [title, setTitle] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [welcomeMode, setWelcomeMode] = useState<WelcomeMode>("coding");
  const [modePresetId, setModePresetId] = useState(defaultModePresetId("coding"));
  const [presets, setPresets] = useState<ModePresetDto[]>([]);

  useEffect(() => {
    if (!open) return;
    // 默认值优先级（实施文档 §9/§15）：最近 Project Task > 模板推荐 > 系统默认
    const templateSuggestion = resolveProjectTemplateTaskSuggestion(project, listProjectTemplates());
    const next = resolveProjectTaskDefaults({
      tasks,
      projectId: project.id,
      defaultSpaceId: project.defaultSpaceId,
      templateSuggestion,
    });
    setTitle("");
    setSpaceId(next.spaceId ?? "");
    setWelcomeMode(next.welcomeMode);
    setModePresetId(next.modePresetId ?? defaultModePresetId(next.welcomeMode));
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const requestedMode = welcomeMode;
    let cancelled = false;
    void window.api?.agent?.getModeProfile?.(requestedMode).then((profile) => {
      if (cancelled) return;
      const nextPresets = profile?.policy?.presets ?? [];
      setPresets(nextPresets);
      setModePresetId((current) => {
        const resolved = applyModeProfileResponse({
          requestedMode,
          currentMode: requestedMode,
          presets: nextPresets,
          currentPresetId: current,
          fallbackPresetId: defaultModePresetId(requestedMode),
        });
        return resolved.ignore ? current : resolved.modePresetId;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, welcomeMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const folderUnavailable = !!spaceId && !spaces.some((space) => space.id === spaceId && !space.archived && !space.effectiveArchived && !space.pathMissing);

  const submit = (): void => {
    if (folderUnavailable) return;
    startProjectTask({
      projectId: project.id,
      spaceId: spaceId || undefined,
      title,
      welcomeMode,
      modePresetId,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="new-project-modal project-task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="new-project-modal-head">
          <div id={titleId} className="new-project-modal-title">新建任务</div>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
        <div className="new-project-modal-body">
          <label className="new-project-field">
            <span className="new-project-label">任务名称</span>
            <input
              className="new-project-input"
              value={title}
              placeholder="给任务起个名字"
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="new-project-field">
            <span className="new-project-label">项目</span>
            <div className="project-locked-context">{project.name}</div>
          </div>
          <label className="new-project-field">
            <span className="new-project-label">任务工作目录</span>
            <select className="new-project-input" value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
              <option value="">使用独立目录</option>
              {folderUnavailable && <option value={spaceId}>原工作目录不可用，请重新选择</option>}
              {spaces.filter((space) => !space.archived && !space.effectiveArchived && !space.pathMissing).map((space) => (
                <option key={space.id} value={space.id}>{space.name}</option>
              ))}
            </select>
          </label>
          <label className="new-project-field">
            <span className="new-project-label">场景</span>
            <select
              className="new-project-input"
              value={welcomeMode}
              onChange={(event) => setWelcomeMode(event.target.value as WelcomeMode)}
            >
              {WELCOME_MODES.map((mode) => (
                <option key={mode} value={mode}>{WELCOME_MODE_LABELS[mode]}</option>
              ))}
            </select>
          </label>
          <label className="new-project-field">
            <span className="new-project-label">标签</span>
            <select className="new-project-input" value={modePresetId} onChange={(event) => setModePresetId(event.target.value)}>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
              {presets.length === 0 && <option value={modePresetId || ""}>{emptyModeTagOptionLabel()}</option>}
            </select>
          </label>
        </div>
        <div className="new-project-modal-foot">
          <span className="new-project-foot-hint">默认使用项目工作目录，也可以让这个任务使用独立目录或其他目录。</span>
          <div className="new-project-foot-actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="button" className="btn primary" disabled={folderUnavailable} onClick={submit}>创建任务</button>
          </div>
        </div>
      </div>
    </div>
  );
}
