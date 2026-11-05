import { useEffect, useId, useMemo, useState } from "react";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconX,
} from "@/components/common/icons";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import {
  applyTemplateToDraft,
  createDraftFromTemplate,
  getProjectTemplate,
  isBlankTemplate,
  isDraftDirty,
  listProjectTemplates,
  resolveProjectTemplate,
  type ProjectCreationDraft,
  type ProjectTemplateDefinition,
  type TemplateCapabilityRegistries,
} from "@shared/project-template";
import type { ProjectDetailsDto } from "@shared/project-domain";
import type { McpServerDto } from "@shared/agent-ipc";
import { mergeProjectCapabilityOptions } from "@shared/project-policy-editor";
import {
  buildCapabilityRegistries,
  buildTemplateSummary,
  formatTemplateSummaryLine,
  validateAndBuildCreationPlan,
} from "@/lib/projectCreate";
import "@/styles/project-create.css";

const NAME_MAX = 40;

type CapabilityKind = "experts" | "skills" | "connectors" | "mcps";

const CAPABILITY_KIND_LABELS: Record<CapabilityKind, string> = {
  experts: "专家",
  skills: "技能",
  connectors: "连接器",
  mcps: "MCP",
};

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (project: ProjectDetailsDto, notice?: string) => void;
  /** 打开时预选模板（Wave 1C：首页按模板新建入口）；缺省为空白项目 */
  initialTemplateId?: string;
}

export default function NewProjectModal({
  open,
  onClose,
  onSaved,
  initialTemplateId,
}: NewProjectModalProps): React.JSX.Element | null {
  const titleId = useId();
  const [draft, setDraft] = useState<ProjectCreationDraft | null>(null);
  const [registries, setRegistries] = useState<TemplateCapabilityRegistries | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [showDescription, setShowDescription] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [switchKeep, setSwitchKeep] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFolder, setProjectFolder] = useState<{ path: string; name: string } | null>(null);

  /** 打开时初始化草稿 + 准备能力注册表（尽量传真实 registries 以展示 missing warning） */
  useEffect(() => {
    if (!open) return;
    const initialId = initialTemplateId && getProjectTemplate(initialTemplateId) ? initialTemplateId : "blank";
    setDraft(createDraftFromTemplate(initialId));
    setRegistries(null);
    setMcpServers([]);
    setShowDescription(false);
    setShowCustomize(false);
    setTemplateMenuOpen(false);
    setPendingTemplateId(null);
    setSwitchKeep(true);
    setConfirmClose(false);
    setSaving(false);
    setError(null);
    setProjectFolder(null);

    const store = useAppStore.getState();
    void Promise.all([
      window.api?.mcp?.listServers?.() ?? Promise.resolve([]),
      store.refreshExperts?.() ?? Promise.resolve(),
      store.refreshSkills?.() ?? Promise.resolve(),
      store.refreshConnectors?.() ?? Promise.resolve(),
    ]).then(([servers]) => {
      const latest = useAppStore.getState();
      setMcpServers(servers ?? []);
      setRegistries(
        buildCapabilityRegistries({
          experts: latest.experts,
          skills: latest.skills,
          connectors: latest.connectors,
          mcps: (servers ?? []).map((server) => ({ id: server.name, installed: server.installed, disabled: server.disabled })),
        }),
      );
    });
  }, [open, initialTemplateId]);

  /** Escape：优先收起模板下拉，再走关闭 dirty guard */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || saving) return;
      if (templateMenuOpen) {
        setTemplateMenuOpen(false);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, saving, templateMenuOpen, draft, onClose]);

  const store = useAppStore.getState();
  const expertOptions = useMemo(
    () =>
      draft
        ? mergeProjectCapabilityOptions(
            store.experts
              .filter((expert) => expert.installed)
              .map((expert) => ({ id: expert.id, name: expert.name, description: expert.description })),
            draft.experts,
          )
        : [],
    [store.experts, draft],
  );
  const skillOptions = useMemo(
    () =>
      draft
        ? mergeProjectCapabilityOptions(
            store.skills
              .filter((skill) => skill.installed)
              .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
            draft.skills,
          )
        : [],
    [store.skills, draft],
  );
  const connectorOptions = useMemo(
    () =>
      draft
        ? mergeProjectCapabilityOptions(
            store.connectors
              .filter((connector) => connector.installed)
              .map((connector) => ({ id: connector.id, name: connector.name, description: connector.description })),
            draft.connectors,
          )
        : [],
    [store.connectors, draft],
  );
  const mcpOptions = useMemo(
    () =>
      draft
        ? mergeProjectCapabilityOptions(
            mcpServers.map((server) => ({ id: server.name, name: server.name, description: server.endpoint })),
            draft.mcps,
          )
        : [],
    [mcpServers, draft],
  );

  const warnings = useMemo(() => {
    if (!draft) return [];
    try {
      return resolveProjectTemplate(draft.templateId, registries ?? undefined).warnings;
    } catch {
      return [];
    }
  }, [draft, registries]);

  if (!open || !draft) return null;

  const patchDraft = (patch: Partial<ProjectCreationDraft>, dirtyKey: keyof ProjectCreationDraft["dirty"]): void => {
    setDraft((current) =>
      current ? { ...current, ...patch, dirty: { ...current.dirty, [dirtyKey]: true } } : current,
    );
  };

  const requestClose = (): void => {
    if (saving) return;
    if (isDraftDirty(draft) || projectFolder) setConfirmClose(true);
    else onClose();
  };

  /** 切换模板：无 dirty 直接应用；有 dirty 弹确认框（保留调整 / 重新配置） */
  const switchTemplate = (templateId: string): void => {
    setTemplateMenuOpen(false);
    if (templateId === draft.templateId) return;
    if (!isDraftDirty(draft)) {
      setDraft(applyTemplateToDraft(draft, templateId));
      return;
    }
    setPendingTemplateId(templateId);
    setSwitchKeep(true);
  };

  const applyTemplateSwitch = (): void => {
    if (!draft || !pendingTemplateId) return;
    if (switchKeep) {
      setDraft(applyTemplateToDraft(draft, pendingTemplateId));
    } else {
      // 「使用新模板重新配置」：全新模板默认值，仅保留 name/description 与其 dirty 状态
      const fresh = createDraftFromTemplate(pendingTemplateId);
      fresh.name = draft.name;
      fresh.description = draft.description;
      fresh.dirty.name = draft.dirty.name;
      fresh.dirty.description = draft.dirty.description;
      setDraft(fresh);
    }
    setPendingTemplateId(null);
  };

  const addCapability = (kind: CapabilityKind, id: string): void => {
    if (!id) return;
    setDraft((current) => {
      if (!current || current[kind].includes(id)) return current;
      return { ...current, [kind]: [...current[kind], id], dirty: { ...current.dirty, [kind]: true } };
    });
  };

  const removeCapability = (kind: CapabilityKind, id: string): void => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [kind]: current[kind].filter((value) => value !== id),
        dirty: { ...current.dirty, [kind]: true },
      };
    });
  };

  const capabilityName = (kind: CapabilityKind, id: string): string => {
    if (kind === "experts") return useAppStore.getState().experts.find((item) => item.id === id)?.name ?? id;
    if (kind === "skills") return useAppStore.getState().skills.find((item) => item.id === id)?.name ?? id;
    if (kind === "connectors") return useAppStore.getState().connectors.find((item) => item.id === id)?.name ?? id;
    return mcpServers.find((server) => server.name === id)?.name ?? id;
  };

  const currentTemplate = getProjectTemplate(draft.templateId) ?? (listProjectTemplates().find((t) => t.id === "blank") as ProjectTemplateDefinition);
  const recommendedTemplates = listProjectTemplates().filter((template) => !isBlankTemplate(template.id));
  const blankTemplate = listProjectTemplates().find((template) => isBlankTemplate(template.id));

  const nameCheck = validateAndBuildCreationPlan(draft, registries ?? undefined);
  const nameInvalid = draft.name.trim().length > 0 && !nameCheck.ok;
  const canSubmit = nameCheck.ok && !saving;
  const summaryLine = formatTemplateSummaryLine(buildTemplateSummary(draft));

  const chooseProjectFolder = async (): Promise<void> => {
    const folder = await window.api?.pickLocalFolder?.();
    if (folder) setProjectFolder(folder);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const plan = validateAndBuildCreationPlan(draft, registries ?? undefined);
      if (!plan.ok) throw new Error(plan.error);
      const result = await window.api?.db?.createProject?.(plan.request);
      if (!result) throw new Error("Project API 未就绪，请重启应用");
      if (!result.ok) throw new Error(result.error);

      let savedProject = result.project;
      let notice: string | undefined;
      if (projectFolder) {
        let mounted: { id: string; created: boolean } | undefined;
        try {
          mounted = await useAppStore.getState().ensureSpaceFromPath(projectFolder.path, projectFolder.name, null, { activate: false });
          const linked = await window.api?.db?.updateProject?.({ id: savedProject.id, defaultSpaceId: mounted.id });
          if (!linked?.ok) throw new Error(linked?.error ?? "项目工作目录绑定失败");
          savedProject = linked.project;
        } catch (folderError) {
          let cleanupFailed = false;
          if (mounted?.created) {
            try { await useAppStore.getState().deleteSpace(mounted.id); }
            catch { cleanupFailed = true; }
          }
          const detail = folderError instanceof Error ? folderError.message : String(folderError);
          notice = cleanupFailed
            ? `项目已创建，但工作目录绑定失败：${detail}。可能保留了一个未绑定目录记录，请在项目资料中重新选择。`
            : `项目已创建，但工作目录未绑定：${detail}。请在项目资料中重新选择。`;
        }
      }
      onSaved?.(savedProject, notice);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const renderCapabilitySection = (kind: CapabilityKind, options: Array<{ id: string; name: string; description?: string }>): React.JSX.Element => {
    const label = CAPABILITY_KIND_LABELS[kind];
    const ids = draft[kind];
    const available = options.filter((option) => !ids.includes(option.id));
    return (
      <div className="new-project-field">
        <div className="new-project-cap-row">
          <span className="new-project-cap-label">
            {label}
            <span className="new-project-cap-optional">（可选）</span>
          </span>
          <select
            className="project-create-add-select"
            aria-label={`添加${label}`}
            value=""
            disabled={available.length === 0}
            onChange={(event) => {
              addCapability(kind, event.target.value);
              event.target.value = "";
            }}
          >
            <option value="" disabled>
              {available.length === 0 ? "无可添加" : `+ 添加${label}`}
            </option>
            {available.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="project-cap-options">
          {ids.length === 0 && <span className="project-cap-empty">未启用</span>}
          {ids.map((id) => (
            <span key={id} className="project-cap-option active">
              <span className="project-cap-name" title={capabilityName(kind, id)}>
                {capabilityName(kind, id)}
              </span>
              <button
                type="button"
                className="project-create-chip-x"
                title={`移除${label}`}
                onClick={() => removeCapability(kind, id)}
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        className="new-project-modal project-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="new-project-modal-head">
          <div id={titleId} className="new-project-modal-title">新建项目</div>
          <button type="button" className="icon-btn" title="关闭" onClick={requestClose} disabled={saving}>
            <IconX size={16} />
          </button>
        </div>

        <div className="new-project-modal-body">
          <label className="new-project-field">
            <span className="new-project-label">项目名称</span>
            <div className="new-project-name-row">
              <input
                className="new-project-input"
                value={draft.name}
                maxLength={NAME_MAX}
                placeholder="请输入项目名称"
                onChange={(event) => patchDraft({ name: event.target.value }, "name")}
                autoFocus
              />
              <span className="new-project-counter">{draft.name.length}/{NAME_MAX}</span>
            </div>
            {nameInvalid && <span className="project-create-name-error">{nameCheck.error}</span>}
          </label>

          {!showDescription ? (
            <button type="button" className="project-create-add-desc" onClick={() => setShowDescription(true)}>
              <IconPlus size={14} />
              添加项目描述
            </button>
          ) : (
            <label className="new-project-field">
              <span className="new-project-label">项目描述</span>
              <input
                className="new-project-input project-description-input"
                value={draft.description}
                placeholder="这个项目长期要完成什么"
                onChange={(event) => patchDraft({ description: event.target.value }, "description")}
              />
            </label>
          )}

          <div className="new-project-field">
            <span className="new-project-label">项目工作目录 <span className="project-create-cap-optional">（可选）</span></span>
            <div className="project-create-folder-row">
              <input
                className="new-project-input project-create-folder-input"
                aria-label="项目工作目录"
                value={projectFolder?.path ?? ""}
                placeholder="可稍后设置；不会自动读取整个目录"
                readOnly
              />
              <button type="button" className="btn" disabled={saving} onClick={() => void chooseProjectFolder()}>
                {projectFolder ? "重新选择" : "选择文件夹"}
              </button>
              {projectFolder && <button type="button" className="btn" disabled={saving} onClick={() => setProjectFolder(null)}>清除</button>}
            </div>
            <span className="project-create-budget-hint">新任务默认使用这里作为工作目录；已有任务目录不受项目默认值影响，目录内容仍按需读取。</span>
          </div>

          <div className="project-create-template-field">
            <span className="new-project-label">项目 Blueprint</span>
            <button
              type="button"
              className="project-create-template-select"
              aria-haspopup="listbox"
              aria-expanded={templateMenuOpen}
              onClick={() => setTemplateMenuOpen((openValue) => !openValue)}
            >
              <span className="project-create-template-select-icon">{currentTemplate.icon}</span>
              <span className="project-create-template-select-name">{currentTemplate.name}</span>
              <span className="project-create-template-select-chevron">
                {templateMenuOpen ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
              </span>
            </button>

            {templateMenuOpen && (
              <>
                <div className="project-create-menu-backdrop" onClick={() => setTemplateMenuOpen(false)} />
                <div className="project-create-menu" role="listbox" aria-label="项目 Blueprint">
                  <div className="project-create-menu-group-label">推荐</div>
                  {recommendedTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      role="option"
                      aria-selected={template.id === draft.templateId}
                      className={`project-create-menu-item ${template.id === draft.templateId ? "selected" : ""}`}
                      onClick={() => switchTemplate(template.id)}
                    >
                      <span className="project-create-menu-icon">{template.icon}</span>
                      <span className="project-create-menu-text">
                        <span className="project-create-menu-name">{template.name}</span>
                        <span className="project-create-menu-desc">{template.description}</span>
                      </span>
                      {template.id === draft.templateId && (
                        <span className="project-create-menu-check"><IconCheck size={15} /></span>
                      )}
                    </button>
                  ))}
                  <div className="project-create-menu-divider" />
                  {blankTemplate && (
                    <button
                      type="button"
                      role="option"
                      aria-selected={blankTemplate.id === draft.templateId}
                      className={`project-create-menu-item ${blankTemplate.id === draft.templateId ? "selected" : ""}`}
                      onClick={() => switchTemplate(blankTemplate.id)}
                    >
                      <span className="project-create-menu-icon">{blankTemplate.icon}</span>
                      <span className="project-create-menu-text">
                        <span className="project-create-menu-name">{blankTemplate.name}</span>
                        <span className="project-create-menu-desc">{blankTemplate.description}</span>
                      </span>
                      {blankTemplate.id === draft.templateId && (
                        <span className="project-create-menu-check"><IconCheck size={15} /></span>
                      )}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="project-create-summary">
            <div className="project-create-summary-head">
              <span className="project-create-summary-icon">{currentTemplate.icon}</span>
              <div className="project-create-summary-text">
                <span className="project-create-summary-name">{currentTemplate.name}</span>
                <span className="project-create-summary-desc">{currentTemplate.description}</span>
              </div>
            </div>
            <div className="project-create-summary-config">
              <span className="project-create-summary-config-label">默认配置</span>
              <span className="project-create-summary-config-line">{summaryLine}</span>
            </div>
            {warnings.length > 0 && (
              <div className="project-create-warnings">
                {warnings.map((warning) => (
                  <div key={warning} className="project-create-warning">
                    <IconAlert size={13} />
                    {warning}
                  </div>
                ))}
                <span className="project-create-warning-note">缺失能力不阻止创建，可在项目设置中补充。</span>
              </div>
            )}
            <button
              type="button"
              className="project-create-customize-toggle"
              onClick={() => setShowCustomize((openValue) => !openValue)}
            >
              {showCustomize ? "收起配置" : "查看 / 自定义配置"}
              {showCustomize ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            </button>
          </div>

          {showCustomize && (
            <section className="project-create-customize">
              <label className="new-project-field">
                <span className="new-project-label">指令</span>
                <textarea
                  className="new-project-instructions"
                  value={draft.instructions}
                  placeholder="项目目标、团队习惯和输出约束"
                  onChange={(event) => patchDraft({ instructions: event.target.value }, "instructions")}
                />
              </label>

              {renderCapabilitySection("experts", expertOptions)}
              {renderCapabilitySection("skills", skillOptions)}
              {renderCapabilitySection("connectors", connectorOptions)}
              {renderCapabilitySection("mcps", mcpOptions)}

            </section>
          )}

          {error && <div className="project-form-error">{error}</div>}
        </div>

        <div className="new-project-modal-foot">
          <span className="new-project-foot-hint">创建后进入项目工作台；工作目录、资料和能力都可继续调整</span>
          <div className="new-project-foot-actions">
            <button type="button" className="btn" onClick={requestClose} disabled={saving}>取消</button>
            <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
              {saving ? "创建中…" : "创建项目"}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClose}
        title="放弃创建项目？"
        body="未保存的项目配置将丢失。"
        confirmLabel="放弃"
        danger
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />

      <ConfirmDialog
        open={pendingTemplateId !== null}
        title="切换项目 Blueprint？"
        body={
          <div className="project-create-switch-body">
            <p>你已经调整了部分项目配置。</p>
            <label className="project-create-radio">
              <input
                type="radio"
                name="project-create-switch"
                checked={switchKeep}
                onChange={() => setSwitchKeep(true)}
              />
              保留我的调整，并应用新模板的其他默认设置
            </label>
            <label className="project-create-radio">
              <input
                type="radio"
                name="project-create-switch"
                checked={!switchKeep}
                onChange={() => setSwitchKeep(false)}
              />
              使用新模板重新配置
            </label>
          </div>
        }
        confirmLabel="应用"
        onCancel={() => setPendingTemplateId(null)}
        onConfirm={applyTemplateSwitch}
      />
    </div>
  );
}
