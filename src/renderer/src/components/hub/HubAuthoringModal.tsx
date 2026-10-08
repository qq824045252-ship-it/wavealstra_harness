import { useEffect, useRef, useState } from "react";
import type { Skill } from "@/types";
import type { ExpertDto } from "@shared/agent-ipc";
import type { ExpertDetailDto } from "@shared/expert-binding";
import { ExpertCapabilityFields } from "./ExpertCapabilityFields";
import "@/styles/expert-editor.css";

type Props = {
  onClose: () => void;
  onCreated: (message: string, createdSkill?: Skill) => void | Promise<void>;
} & ({ mode: "skill"; skills?: never; expertId?: never; onExpertSaved?: never } | {
  mode: "expert"; skills: Skill[]; expertId?: string; onExpertSaved?: (expert: ExpertDto) => void | Promise<void>;
});

function lines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function agentApi() { if (!window.api?.agent) throw new Error("专家 API 不可用，请重新启动应用"); return window.api.agent; }

export function HubAuthoringModal(props: Props): React.JSX.Element {
  const { mode, onClose, onCreated } = props;
  const editing = mode === "expert" && Boolean(props.expertId);
  const [detail, setDetail] = useState<ExpertDetailDto | null>(null);
  const [loading, setLoading] = useState(editing);
  const [intent, setIntent] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const committedExpert = useRef<ExpertDto | null>(null);
  const generation = useRef(0);
  const generationRequest = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; if (generationRequest.current) void window.api?.agent.cancelExpertAuthoring(generationRequest.current).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (mode !== "expert" || !props.expertId) return;
    let cancelled = false;
    setLoading(true);
    void Promise.resolve().then(() => agentApi().getExpertDetail(props.expertId!)).then((value) => {
      if (cancelled) return;
      setDetail(value); setName(value.name); setDescription(value.description); setInstructions(value.instructions);
      setSkillIds(value.skills ?? []); setMcpIds(value.mcpIds); setConnectorIds(value.connectorIds);
    }).catch((err) => { if (!cancelled) setError(String(err)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, props.expertId]);
  const canSubmit = Boolean(name.trim() && description.trim() && instructions.trim() && !busy && !loading && !generating && (!editing || detail));
  const fieldsLocked = busy || generating || Boolean(committedExpert.current);
  const cancelGeneration = (): void => {
    const requestId = generationRequest.current;
    generation.current += 1; generationRequest.current = null; setGenerating(false);
    if (requestId) void window.api?.agent.cancelExpertAuthoring(requestId).catch((err) => setError(String(err)));
  };
  const generateDraft = async (): Promise<void> => {
    if (!intent.trim() || generating || busy) return;
    const token = ++generation.current;
    setGenerating(true); setError("");
    try {
      if (mode === "skill") {
        const draft = await window.api?.agent?.generateSkillAuthoringDraft?.({ intent: intent.trim() });
        if (!mounted.current || token !== generation.current) return;
        if (!draft) throw new Error("Meta Skill 未返回 Skill 草稿");
        setName(draft.name); setDescription(draft.description); setInstructions(draft.instructions);
        setPositive(draft.triggerExamples.join("\n")); setNegative(draft.nonTriggerExamples.join("\n"));
      } else {
        const requestId = crypto.randomUUID?.() ?? `expert-${Date.now()}-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
        generationRequest.current = requestId;
        const draft = await window.api?.agent?.generateExpertAuthoringDraft?.({ intent: intent.trim(), requestId });
        if (!mounted.current || token !== generation.current) return;
        if (!draft) throw new Error("Meta Skill 未返回专家草稿");
        setName(draft.name); setDescription(draft.description); setInstructions(draft.instructions);
        const available = new Set(props.skills.flatMap((skill) => [skill.id, skill.name]));
        setSkillIds(draft.skillIds.filter((id) => available.has(id)));
      }
    } catch (err) { if (mounted.current && token === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (mounted.current && token === generation.current) { setGenerating(false); generationRequest.current = null; } }
  };
  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true); setError("");
    try {
      if (mode === "skill") {
        const result = await window.api?.agent?.authorSkill?.({ name: name.trim(), description: description.trim(), instructions: instructions.trim(), triggerExamples: lines(positive), nonTriggerExamples: lines(negative) });
        if (!result) throw new Error("Authoring API 未返回结果");
        await onCreated(`已创建「${result.skill.name}」，默认停用 · ${result.validation.evalCount} 个 eval case`, result.skill as Skill);
      } else {
        const fields = { name: name.trim(), description: description.trim(), instructions: instructions.trim(), skillIds, mcpIds, connectorIds };
        const expert = committedExpert.current ?? (editing && detail
          ? await agentApi().updateExpert({ ...fields, id: detail.id, expectedRevision: detail.revision })
          : (await agentApi().authorExpert(fields)).expert);
        committedExpert.current = expert;
        await onCreated(`已${editing ? "更新专家模板" : "创建专家"}「${expert.name}」`);
        await props.onExpertSaved?.(expert);
      }
      onClose();
    } catch (err) { setError(`${committedExpert.current ? "专家已保存，但后续刷新 / 绑定未完成；可重试保存继续，不会重复创建。" : ""}${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay expert-editor-overlay" role="presentation" onClick={(event) => event.stopPropagation()}>
    <div className="mcp-auth-modal expert-editor-modal" role="dialog" aria-modal="true" aria-label={editing ? "编辑专家模板" : mode === "expert" ? "创建专家" : "创建 Skill"}>
      <div className="mcp-auth-title">{editing ? "查看 / 编辑专家模板" : mode === "expert" ? "创建专家" : "创建 Skill"}</div>
      {mode === "expert" ? <div className="expert-editor-scope">{editing ? "修改的是可复用专家模板。已绑定的任务保留各自身份；在任务中选择“同步模板”才采用新版。" : "创建可复用的专家模板；角色说明和能力会在绑定时保存到任务。"}</div> : <div className="mcp-auth-hint">创建结构化 Skill 包，新 Skill 默认停用，确认后再启用。</div>}
      {loading ? <div>正在读取专家模板…</div> : <>
        {!editing && <><div className="expert-editor-inline"><textarea className="mcp-auth-input" rows={3} value={intent} disabled={fieldsLocked} onChange={(e) => setIntent(e.target.value)} placeholder={mode === "expert" ? "描述你希望专家长期负责什么（也可直接填写下方字段）" : "描述你希望重复完成的能力"} /><button type="button" className="btn" disabled={!intent.trim() || fieldsLocked} onClick={() => void generateDraft()}>{generating ? "生成中…" : mode === "skill" ? "AI 评估 / 草稿" : "AI 生成草稿"}</button>{mode === "expert" && generating && <button type="button" className="btn" onClick={cancelGeneration}>取消生成</button>}</div><div className="mcp-auth-hint">{mode === "expert" ? "AI 草稿可选；生成后请检查角色说明和能力，再点击创建。" : "Meta Skill 先判断应新建、复用、改进还是不创建；生成草稿不会直接写文件。"}</div></>}
        <label className="expert-editor-field"><span className="mcp-auth-hint">{mode === "expert" ? "专家名称" : "Name"} *</span><input className="mcp-auth-input" value={name} disabled={fieldsLocked} onChange={(e) => setName(e.target.value)} /></label>
        <label className="expert-editor-field"><span className="mcp-auth-hint">{mode === "expert" ? "专家定位" : "Intent"} *</span><textarea className="mcp-auth-input" rows={2} value={description} disabled={fieldsLocked} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="expert-editor-field"><span className="mcp-auth-hint">{mode === "expert" ? "角色说明" : "Workflow / Boundary / Output Contract"} *</span><textarea className="mcp-auth-input" rows={8} value={instructions} disabled={fieldsLocked} onChange={(e) => setInstructions(e.target.value)} placeholder="职责、工作方式、判断原则、输出要求…" /></label>
        {mode === "skill" ? <><label className="expert-editor-field"><span className="mcp-auth-hint">Trigger Evals</span><textarea className="mcp-auth-input" rows={3} value={positive} onChange={(e) => setPositive(e.target.value)} /></label><label className="expert-editor-field"><span className="mcp-auth-hint">Boundary Evals</span><textarea className="mcp-auth-input" rows={3} value={negative} onChange={(e) => setNegative(e.target.value)} /></label></> : <ExpertCapabilityFields skills={props.skills} skillIds={skillIds} mcpIds={mcpIds} connectorIds={connectorIds} onSkills={setSkillIds} onMcp={setMcpIds} onConnectors={setConnectorIds} disabled={fieldsLocked} />}
      </>}
      {error && <div className="mcp-auth-error" role="alert">{error}</div>}
      <div className="mcp-auth-actions"><button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "保存中…" : committedExpert.current ? "重试后续操作" : editing ? "保存专家模板" : "创建"}</button><button type="button" className="btn" disabled={busy || generating} onClick={onClose}>取消</button></div>
    </div>
  </div>;
}
