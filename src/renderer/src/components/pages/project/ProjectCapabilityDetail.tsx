/**
 * Project Config Capability Detail（实施规划 §9/§11-§14）。
 * Experts / Skills / Connectors / MCP 共用同一交互：
 * Selected List（× 移除）→ Search → Available List（+ 添加）→ 高级策略 → Footer。
 * 普通 add/remove 只改 Draft 的 allow/prefer 等「普通选择」；deny 等高级语义
 * 必须进入 Advanced Policy（§11/§15），复用 @shared/project-policy-editor。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { CAPABILITY_MANAGE_ENTRY, PROJECT_CAPABILITY_SCOPE_HINT, UNAVAILABLE_LABEL, clonePolicies, filterCapabilityItems, splitCapabilityOptions, type CapabilityOption } from "@/lib/projectConfigDetail";
import { sameProjectFormValue, type ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import {
  emptyProjectPolicies,
  type ProjectDetailsDto,
  type ProjectPoliciesDto,
} from "@shared/project-domain";
import {
  getProjectMcpPolicyState,
  getProjectSelectionPolicyState,
  getProjectSkillPolicyState,
  mergeProjectCapabilityOptions,
  setProjectMcpPolicyState,
  setProjectSelectionPolicyState,
  setProjectSkillPolicyState,
  type ProjectMcpPolicyState,
  type ProjectSelectionPolicyState,
  type ProjectSkillPolicyState,
} from "@shared/project-policy-editor";
import ProjectConfigDetailShell from "./ProjectConfigDetailShell";
import CapabilityPolicyChooser from "./CapabilityPolicyChooser";

type CapabilitySection = "experts" | "skills" | "connectors" | "mcp";

interface Props {
  project: ProjectDetailsDto;
  section: CapabilitySection;
  /** add intent → 打开时 focus 搜索框（§10/§24） */
  addIntent: boolean;
  onDirtyChange: (guard: ProjectUnsavedGuard | null) => void;
  onRefresh: () => Promise<void>;
  onToast: (text: string) => void;
  /** Connector/MCP 的「管理」跳转目标（§13/§14） */
  onManageGlobal?: () => void;
}

interface RegistryItem {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  installed?: boolean;
}

function toOption(item: RegistryItem): CapabilityOption {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    statusLabel: item.installed ? undefined : item.installed === false ? "未安装" : undefined,
  };
}

export default function ProjectCapabilityDetail({
  project,
  section,
  addIntent,
  onDirtyChange,
  onRefresh,
  onToast,
  onManageGlobal,
}: Props): React.JSX.Element {
  const experts = useAppStore((state) => state.experts);
  const skills = useAppStore((state) => state.skills);
  const connectors = useAppStore((state) => state.connectors);
  const [mcpRegistry, setMcpRegistry] = useState<RegistryItem[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectPoliciesDto>(() => clonePolicies(project.policies ?? emptyProjectPolicies()));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const searchRef = useRef<HTMLInputElement>(null);

  const savedPolicies = project.policies ?? emptyProjectPolicies();

  /** MCP Registry 异步加载（§14：全局服务器列表，Rail 只做选择） */
  useEffect(() => {
    if (section !== "mcp") return;
    let alive = true;
    void window.api?.mcp?.listServers?.()
      .then((servers) => {
        if (!alive) return;
        setMcpRegistry(
          (servers ?? []).map((server) => ({
            id: server.name,
            name: server.name,
            description: `${server.transport ?? "?"} · ${server.endpoint ?? "?"}`,
          })),
        );
      })
      .catch(() => {
        if (alive) setMcpRegistry([]);
      })
      .finally(() => {
        if (alive) setMcpLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [section]);

  /** Project 外部刷新（保存成功 / 切换）→ Draft 同步到新基线 */
  useEffect(() => {
    setDraft(clonePolicies(savedPolicies));
    setError(null);
    setSaving(false);
  }, [project.id, project.updatedAt]);

  /** §24：add intent → focus 搜索 */
  useEffect(() => {
    if (addIntent) searchRef.current?.focus();
  }, [addIntent]);

  /** 当前域 Draft 引用（统一出入口） */
  const policyForSection = useCallback((policies: ProjectPoliciesDto) => {
    if (section === "experts") return policies.expert;
    if (section === "skills") return policies.skill;
    if (section === "connectors") return policies.connector;
    return policies.mcp;
  }, [section]);

  const setSectionPolicy = useCallback((updater: (policy: ReturnType<typeof policyForSection>) => ReturnType<typeof policyForSection>) => {
    setDraft((value) => {
      const next = clonePolicies(value);
      if (section === "experts") next.expert = updater(next.expert) as ProjectPoliciesDto["expert"];
      else if (section === "skills") next.skill = updater(next.skill) as ProjectPoliciesDto["skill"];
      else if (section === "connectors") next.connector = updater(next.connector) as ProjectPoliciesDto["connector"];
      else next.mcp = updater(next.mcp) as ProjectPoliciesDto["mcp"];
      return next;
    });
  }, [section]);

  const registry = useMemo<RegistryItem[]>(() => {
    if (section === "experts") return experts.map((item) => ({ id: item.id, name: item.name, description: item.description, emoji: item.emoji }));
    if (section === "skills") return skills.filter((item) => item.installed).map((item) => ({ id: item.id, name: item.name, description: item.description, emoji: item.icon }));
    if (section === "connectors") return connectors.map((item) => ({ id: item.id, name: item.name, description: item.description, installed: item.installed }));
    return mcpRegistry;
  }, [section, experts, skills, connectors, mcpRegistry]);

  /** 普通选择 = 可被 Summary/Chunk 展示的项（§11：allow + recommended / prefer；deny 不算选择） */
  const selectedIds = useMemo(() => {
    const p = policyForSection(draft);
    if (section === "skills") {
      return [...(p as ProjectPoliciesDto["skill"]).allow, ...(p as ProjectPoliciesDto["skill"]).prefer];
    }
    if (section === "mcp") return [...(p as ProjectPoliciesDto["mcp"]).allow];
    return [
      ...(p as ProjectPoliciesDto["expert"]).allow,
      ...(p as ProjectPoliciesDto["expert"]).recommended,
    ];
  }, [draft, policyForSection, section]);

  const referencedIds = useMemo(() => {
    const p = policyForSection(draft);
    if (section === "skills") {
      const skill = p as ProjectPoliciesDto["skill"];
      return [...skill.allow, ...skill.prefer, ...skill.demote, ...skill.hide];
    }
    if (section === "mcp") {
      const mcp = p as ProjectPoliciesDto["mcp"];
      return [...mcp.allow, ...mcp.deny];
    }
    const selection = p as ProjectPoliciesDto["expert"];
    return [...selection.allow, ...selection.deny, ...selection.recommended];
  }, [draft, policyForSection, section]);

  const selectedOptions = useMemo(() => {
    const byId = new Map(registry.map((item) => [item.id, item]));
    return selectedIds.map((id) => {
      const item = byId.get(id);
      return item
        ? toOption(item)
        : { id, name: id, missing: true, description: UNAVAILABLE_LABEL };
    });
  }, [registry, selectedIds]);

  const { available } = useMemo(() => splitCapabilityOptions(registry.map(toOption), referencedIds), [registry, referencedIds]);
  const availableFiltered = useMemo(() => filterCapabilityItems(available, query), [available, query]);

  /** §15：高级策略直接映射现有 DTO（全量候选，含配置残留项） */
  const advancedOptions = useMemo(() => mergeProjectCapabilityOptions(registry.map(toOption), referencedIds), [registry, referencedIds]);

  const dirty = !sameProjectFormValue(draft, savedPolicies);

  const discard = useCallback((): void => {
    setDraft(clonePolicies(savedPolicies));
    setQuery("");
    setAdvancedOpen(false);
    setError(null);
  }, [savedPolicies]);

  const save = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({ id: project.id, policies: current });
      if (!result?.ok) throw new Error(result?.error ?? "保存失败");
      await onRefresh();
      onToast("已保存");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message || "保存失败");
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      setSaving(false);
    }
  }, [project.id, onRefresh, onToast]);

  /** §6/§7：Draft 只在 Save 写回；dirty 时上报 Guard（保存并继续/放弃/取消） */
  useEffect(() => {
    onDirtyChange(dirty ? { dirty: true, save, discard } : null);
  }, [dirty, onDirtyChange, save, discard]);

  const removeSelected = (id: string): void => {
    setSectionPolicy((policy) => {
      if (section === "skills") return setProjectSkillPolicyState(policy as ProjectPoliciesDto["skill"], id, "inherit") as typeof policy;
      if (section === "mcp") return setProjectMcpPolicyState(policy as ProjectPoliciesDto["mcp"], id, "inherit") as typeof policy;
      return setProjectSelectionPolicyState(policy as ProjectPoliciesDto["expert"], id, "inherit") as typeof policy;
    });
  };

  const addAvailable = (id: string): void => {
    setSectionPolicy((policy) => {
      if (section === "skills") return setProjectSkillPolicyState(policy as ProjectPoliciesDto["skill"], id, "allow") as typeof policy;
      if (section === "mcp") return setProjectMcpPolicyState(policy as ProjectPoliciesDto["mcp"], id, "allow") as typeof policy;
      return setProjectSelectionPolicyState(policy as ProjectPoliciesDto["expert"], id, "allow") as typeof policy;
    });
  };

  const onPolicyStateChange = (id: string, state: string): void => {
    setSectionPolicy((policy) => {
      if (section === "skills") return setProjectSkillPolicyState(policy as ProjectPoliciesDto["skill"], id, state as ProjectSkillPolicyState) as typeof policy;
      if (section === "mcp") return setProjectMcpPolicyState(policy as ProjectPoliciesDto["mcp"], id, state as ProjectMcpPolicyState) as typeof policy;
      return setProjectSelectionPolicyState(policy as ProjectPoliciesDto["expert"], id, state as ProjectSelectionPolicyState) as typeof policy;
    });
  };

  const policyStates = section === "skills"
    ? [{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "prefer", label: "优先" }, { value: "demote", label: "降权" }, { value: "hide", label: "隐藏" }]
    : section === "mcp"
      ? [{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "deny", label: "拒绝" }]
      : [{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "recommended", label: "推荐" }, { value: "deny", label: "拒绝" }];

  const meta = section === "experts"
    ? { title: "专家", description: "为这个项目准备长期可用的专家。", emptySelected: "尚未添加专家", emptyAvailable: "没有可添加的专家" }
    : section === "skills"
      ? { title: "技能", description: "为这个项目准备长期可用的技能。", emptySelected: "尚未添加技能", emptyAvailable: "没有可添加的技能" }
      : section === "connectors"
        ? { title: "连接器", description: "允许这个项目使用已经配置好的外部服务。", emptySelected: "尚未添加连接器", emptyAvailable: "没有可添加的连接器" }
        : { title: "MCP", description: "选择这个项目允许使用的 MCP 工具来源。", emptySelected: "尚未配置 MCP", emptyAvailable: "没有可添加的 MCP" };

  return (
    <ProjectConfigDetailShell
      title={meta.title}
      description={meta.description}
      dirty={dirty}
      saving={saving}
      error={error}
      saveDisabledReason={section === "mcp" && mcpLoading ? "正在加载 MCP 列表…" : null}
      onSave={() => void save().catch(() => undefined)}
      onCancel={discard}
      footerExtra={
        onManageGlobal ? (
          <button type="button" className="project-config-manage-link" onClick={onManageGlobal}>
            {CAPABILITY_MANAGE_ENTRY[section === "connectors" ? "connectors" : "mcp"]?.label ?? "管理"}
          </button>
        ) : undefined
      }
    >
      <p className="project-config-scope-hint">{PROJECT_CAPABILITY_SCOPE_HINT}</p>

      <div className="project-config-detail-section">
        <div className="project-config-detail-section-title">项目{meta.title}</div>
        {selectedOptions.length === 0 ? (
          <p className="project-config-empty">{meta.emptySelected}</p>
        ) : (
          <ul className="project-config-selected-list">
            {selectedOptions.map((item) => (
              <li key={item.id} className={`project-config-cap-row ${item.missing ? "missing" : ""}`}>
                {item.emoji ? <span className="project-config-cap-emoji">{item.emoji}</span> : null}
                <span className="project-config-cap-name">
                  {item.name}
                  {item.missing && <span className="project-config-cap-badge">{UNAVAILABLE_LABEL}</span>}
                  {item.statusLabel ? <span className="project-config-cap-badge soft">{item.statusLabel}</span> : null}
                </span>
                <button
                  type="button"
                  className="icon-btn project-config-cap-remove"
                  title={`从项目中移除${item.name}`}
                  aria-label={`从项目中移除${item.name}`}
                  onClick={() => removeSelected(item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="project-config-detail-section">
        <div className="project-config-detail-section-title">添加{meta.title}</div>
        <input
          ref={searchRef}
          className="project-inline-search project-config-search"
          type="search"
          placeholder={`搜索${meta.title}`}
          value={query}
          aria-label={`搜索${meta.title}`}
          onChange={(event) => setQuery(event.target.value)}
        />
        {availableFiltered.length === 0 ? (
          <p className="project-config-empty">{query.trim() ? "没有匹配项" : meta.emptyAvailable}</p>
        ) : (
          <ul className="project-config-available-list">
            {availableFiltered.map((item) => (
              <li key={item.id} className="project-config-cap-row">
                {item.emoji ? <span className="project-config-cap-emoji">{item.emoji}</span> : null}
                <span className="project-config-cap-name">
                  {item.name}
                  {item.statusLabel ? <span className="project-config-cap-badge soft">{item.statusLabel}</span> : null}
                  {item.description ? <span className="project-config-cap-desc">{item.description}</span> : null}
                </span>
                <button
                  type="button"
                  className="icon-btn project-config-cap-add"
                  title={`添加${item.name}`}
                  aria-label={`添加${item.name}`}
                  onClick={() => addAvailable(item.id)}
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="project-config-advanced">
        <button
          type="button"
          className={`project-config-advanced-toggle ${advancedOpen ? "open" : ""}`}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <span className="project-config-advanced-caret">▸</span> 高级策略
        </button>
        {advancedOpen && (
          <div className="project-config-advanced-body">
            {section === "mcp" && (
              <div className="new-project-label-row project-mcp-mode-row">
                <span className="new-project-label">MCP 裁决模式</span>
                <select
                  className="project-cap-state"
                  value={(draft.mcp).mode}
                  aria-label="MCP 裁决模式"
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, mcp: { ...value.mcp, mode: event.target.value as "hard" | "soft" } }))
                  }
                >
                  <option value="hard">Hard · allow 白名单</option>
                  <option value="soft">Soft · deny 黑名单</option>
                </select>
              </div>
            )}
            <CapabilityPolicyChooser
              label={`${meta.title} Policy`}
              options={advancedOptions}
              states={policyStates}
              getState={(id) => {
                const policy = policyForSection(draft);
                if (section === "skills") return getProjectSkillPolicyState(policy as ProjectPoliciesDto["skill"], id);
                if (section === "mcp") return getProjectMcpPolicyState(policy as ProjectPoliciesDto["mcp"], id);
                return getProjectSelectionPolicyState(policy as ProjectPoliciesDto["expert"], id);
              }}
              onStateChange={onPolicyStateChange}
            />
          </div>
        )}
      </div>
    </ProjectConfigDetailShell>
  );
}
