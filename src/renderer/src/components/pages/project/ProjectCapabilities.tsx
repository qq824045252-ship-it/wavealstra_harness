import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
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
} from "@shared/project-policy-editor";
import CapabilityPolicyChooser from "./CapabilityPolicyChooser";

interface CapabilityOption {
  id: string;
  name: string;
  description?: string;
}

interface Props {
  project: ProjectDetailsDto;
  onRefresh: () => Promise<void>;
  onToast: (text: string) => void;
  onRegisterUnsaved: (guard: ProjectUnsavedGuard | null) => void;
}

export default function ProjectCapabilities({
  project,
  onRefresh,
  onToast,
  onRegisterUnsaved,
}: Props): React.JSX.Element {
  const experts = useAppStore((state) => state.experts);
  const skills = useAppStore((state) => state.skills);
  const connectors = useAppStore((state) => state.connectors);
  const [mcpOptions, setMcpOptions] = useState<CapabilityOption[]>([]);
  const [policies, setPolicies] = useState<ProjectPoliciesDto>(project.policies ?? emptyProjectPolicies());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPolicies(project.policies ?? emptyProjectPolicies());
  }, [project.id, project.updatedAt, project.policies]);

  useEffect(() => {
    void window.api?.mcp?.listServers?.().then((servers) =>
      setMcpOptions(
        servers.map((server) => ({
          id: server.name,
          name: server.name,
          description: `${server.transport} · ${server.endpoint}`,
        })),
      ),
    );
  }, [project.id]);

  const expertOptions = useMemo(() => mergeProjectCapabilityOptions(
    experts.map((expert) => ({ id: expert.id, name: expert.name, description: expert.description })),
    [...policies.expert.allow, ...policies.expert.deny, ...policies.expert.recommended],
  ), [experts, policies.expert]);
  const skillOptions = useMemo(() => mergeProjectCapabilityOptions(
    skills.filter((skill) => skill.installed).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
    [...policies.skill.allow, ...policies.skill.prefer, ...policies.skill.demote, ...policies.skill.hide],
  ), [skills, policies.skill]);
  const connectorOptions = useMemo(() => mergeProjectCapabilityOptions(
    connectors.filter((connector) => connector.installed).map((connector) => ({ id: connector.id, name: connector.name, description: connector.description })),
    [...policies.connector.allow, ...policies.connector.deny, ...policies.connector.recommended],
  ), [connectors, policies.connector]);
  const visibleMcpOptions = useMemo(() => mergeProjectCapabilityOptions(
    mcpOptions,
    [...policies.mcp.allow, ...policies.mcp.deny],
  ), [mcpOptions, policies.mcp]);

  const savedPolicies = project.policies ?? emptyProjectPolicies();
  const dirty = !sameProjectFormValue(policies, savedPolicies);

  const discard = (): void => {
    setPolicies(savedPolicies);
    setError(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({ id: project.id, policies });
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
  };

  useEffect(() => {
    onRegisterUnsaved({ dirty, save, discard });
    return () => onRegisterUnsaved(null);
  });

  return (
    <div className="project-tab-body">
      <p className="project-cap-hint">
        项目能力会影响该项目中的任务。最终可用能力由 Mode、Project 和 Tag 共同决定。
      </p>
      <CapabilityPolicyChooser
        label="Expert Policy"
        options={expertOptions}
        states={[{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "recommended", label: "推荐" }, { value: "deny", label: "拒绝" }]}
        getState={(id) => getProjectSelectionPolicyState(policies.expert, id)}
        onStateChange={(id, state) => setPolicies((value) => ({ ...value, expert: setProjectSelectionPolicyState(value.expert, id, state) }))}
      />
      <CapabilityPolicyChooser
        label="Skill Policy"
        options={skillOptions}
        states={[{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "prefer", label: "优先" }, { value: "demote", label: "降权" }, { value: "hide", label: "隐藏" }]}
        getState={(id) => getProjectSkillPolicyState(policies.skill, id)}
        onStateChange={(id, state) => setPolicies((value) => ({ ...value, skill: setProjectSkillPolicyState(value.skill, id, state) }))}
      />
      <CapabilityPolicyChooser
        label="Connector Policy"
        options={connectorOptions}
        states={[{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "recommended", label: "推荐" }, { value: "deny", label: "拒绝" }]}
        getState={(id) => getProjectSelectionPolicyState(policies.connector, id)}
        onStateChange={(id, state) => setPolicies((value) => ({ ...value, connector: setProjectSelectionPolicyState(value.connector, id, state) }))}
      />
      <div className="new-project-label-row project-mcp-mode-row">
        <span className="new-project-label">MCP 裁决模式</span>
        <select
          className="project-cap-state"
          value={policies.mcp.mode}
          onChange={(event) => setPolicies((value) => ({ ...value, mcp: { ...value.mcp, mode: event.target.value as "hard" | "soft" } }))}
        >
          <option value="hard">Hard · allow 白名单</option>
          <option value="soft">Soft · deny 黑名单</option>
        </select>
      </div>
      <CapabilityPolicyChooser
        label="MCP Policy"
        options={visibleMcpOptions}
        states={[{ value: "inherit", label: "继承" }, { value: "allow", label: "允许" }, { value: "deny", label: "拒绝" }]}
        getState={(id) => getProjectMcpPolicyState(policies.mcp, id)}
        onStateChange={(id, state) => setPolicies((value) => ({ ...value, mcp: setProjectMcpPolicyState(value.mcp, id, state) }))}
      />
      {error && <div className="project-form-error">{error}</div>}
      <div className="project-section-actions">
        <button type="button" className="btn primary" disabled={saving || !dirty} onClick={() => void save().catch(() => undefined)}>
          {saving ? "保存中…" : "保存能力"}
        </button>
      </div>
    </div>
  );
}
