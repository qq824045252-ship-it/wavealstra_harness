import { useMemo, useState } from "react";
import type { Skill } from "@/types";

type Props =
  | {
      mode: "skill";
      skills?: never;
      onClose: () => void;
      onCreated: (message: string, createdSkill?: Skill) => void | Promise<void>;
    }
  | {
      mode: "expert";
      skills: Skill[];
      onClose: () => void;
      onCreated: (message: string, createdSkill?: Skill) => void | Promise<void>;
    };

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function HubAuthoringModal(props: Props): React.JSX.Element {
  const { mode, onClose, onCreated } = props;
  const [intent, setIntent] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [skillQuery, setSkillQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = name.trim() && description.trim() && instructions.trim() && !busy;
  const sortedSkills = useMemo(
    () => mode === "expert" ? [...props.skills].sort((a, b) => a.name.localeCompare(b.name)) : [],
    [mode, props],
  );
  const visibleSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return sortedSkills;
    return sortedSkills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  }, [skillQuery, sortedSkills]);

  const toggleSkill = (id: string): void => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generateDraft = async (): Promise<void> => {
    const value = intent.trim();
    if (!value || generating || busy) return;
    setGenerating(true);
    setError("");
    try {
      if (mode === "skill") {
        const draft = await window.api?.agent?.generateSkillAuthoringDraft?.({ intent: value });
        if (!draft) throw new Error("Meta Skill 未返回 Skill 草稿");
        setName(draft.name);
        setDescription(draft.description);
        setInstructions(draft.instructions);
        setPositive(draft.triggerExamples.join("\n"));
        setNegative(draft.nonTriggerExamples.join("\n"));
      } else {
        const draft = await window.api?.agent?.generateExpertAuthoringDraft?.({ intent: value });
        if (!draft) throw new Error("Meta Skill 未返回专家草稿");
        setName(draft.name);
        setDescription(draft.description);
        setInstructions(draft.instructions);
        const available = new Set(props.skills.flatMap((skill) => [skill.id, skill.name]));
        setSelectedSkills(new Set(draft.skillIds.filter((id) => available.has(id))));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "skill") {
        const result = await window.api?.agent?.authorSkill?.({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          triggerExamples: lines(positive),
          nonTriggerExamples: lines(negative),
        });
        if (!result) throw new Error("Authoring API 未返回结果");
        await onCreated(`已创建「${result.skill.name}」，默认停用 · ${result.validation.evalCount} 个 eval case`, result.skill as Skill);
      } else {
        const result = await window.api?.agent?.authorExpert?.({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          skillIds: [...selectedSkills],
        });
        if (!result) throw new Error("Authoring API 未返回结果");
        await onCreated(`已创建专家「${result.expert.name}」 · ${result.expert.skills?.length ?? 0} 个 Private Skills`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="mcp-auth-modal" style={{ width: 560, maxWidth: "calc(100vw - 40px)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mcp-auth-title">{mode === "skill" ? "创建 Skill" : "创建专家"}</div>
        <div className="mcp-auth-hint">
          {mode === "skill"
            ? "创建结构化 Skill 包：SKILL.md + references / scripts / templates / evals。新 Skill 默认停用，确认后再启用。"
            : "创建单专家包，并可把当前已安装 Skill 复制为专家 Private Skills。"}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10 }}>
          <textarea
            className="mcp-auth-input"
            rows={3}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={mode === "skill" ? "直接描述你想重复完成的能力，例如：每次拿到模拟前端原理图，按我的规则检查 ADC、参考源、电源和滤波" : "直接描述你想要的长期专家，例如：工业仪表硬件设计专家，负责精密 ADC、Pt100、4-20mA 和 EMC Review"}
            style={{ flex: 1, marginTop: 0 }}
          />
          <button type="button" className="btn primary" disabled={!intent.trim() || generating || busy} onClick={() => void generateDraft()} style={{ flexShrink: 0 }}>
            {generating ? (mode === "skill" ? "评估中…" : "生成中…") : (mode === "skill" ? "AI 评估 / 草稿" : "AI 生成草稿")}
          </button>
        </div>
        <div className="mcp-auth-hint" style={{ marginBottom: 8 }}>Meta Skill 会先判断应新建、复用、改进还是不创建；仅在建议新建时生成结构化草稿，不会直接写文件。</div>

        <label style={{ display: "block" }}>
          <span className="mcp-auth-hint">{mode === "skill" ? "Name" : "专家名称"}</span>
          <input className="mcp-auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "skill" ? "Skill 名称" : "专家名称"} />
        </label>
        <label style={{ display: "block" }}>
          <span className="mcp-auth-hint">{mode === "skill" ? "Intent" : "专家定位"}</span>
          <textarea className="mcp-auth-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它负责什么" />
        </label>
        <label style={{ display: "block" }}>
          <span className="mcp-auth-hint">{mode === "skill" ? "Workflow / Boundary / Output Contract" : "角色说明"}</span>
          <textarea className="mcp-auth-input" rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={mode === "skill" ? "工作流程、约束、输出要求……" : "角色定位、工作方法、判断原则、输出规范……"} />
        </label>

        {mode === "skill" && (
          <>
            <label style={{ display: "block" }}>
              <span className="mcp-auth-hint">Trigger Evals</span>
              <textarea className="mcp-auth-input" rows={3} value={positive} onChange={(e) => setPositive(e.target.value)} placeholder="应该触发的示例（每行一个，可选）" />
            </label>
            <label style={{ display: "block" }}>
              <span className="mcp-auth-hint">Boundary Evals</span>
              <textarea className="mcp-auth-input" rows={3} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="不应该触发的示例（每行一个，可选）" />
            </label>
          </>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {mode === "skill" ? (
            <>
              <span className="hub-card-tag">Trigger {lines(positive).length}</span>
              <span className="hub-card-tag">Boundary {lines(negative).length}</span>
              <span className="mcp-auth-hint">创建后默认停用，并自动打开 Detail 供检查 / Eval。</span>
            </>
          ) : (
            <>
              <span className="hub-card-tag">Private Skills {selectedSkills.size}</span>
              <span className="mcp-auth-hint">绑定后复制为专家私有能力；同名 Global 停用时 Private 可用，Global 启用时仍按现有 first-wins 优先。</span>
            </>
          )}
        </div>

        {mode === "expert" && (
          <div style={{ marginTop: 10 }}>
            <div className="mcp-auth-hint">Private Skills（从当前已安装 Skill 真实目录复制，可不选）</div>
            {sortedSkills.length > 8 ? (
              <input className="mcp-auth-input" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} placeholder="搜索已安装 Skill…" style={{ marginTop: 7 }} />
            ) : null}
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border-color)", borderRadius: 8, padding: 8 }}>
              {sortedSkills.length === 0 ? (
                <div className="mcp-auth-hint">暂无已安装 Skill</div>
              ) : visibleSkills.length === 0 ? (
                <div className="mcp-auth-hint">没有匹配的 Skill</div>
              ) : visibleSkills.map((skill) => (
                <label key={skill.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 4px", cursor: "pointer" }}>
                  <input type="checkbox" checked={selectedSkills.has(skill.id)} onChange={() => toggleSkill(skill.id)} />
                  <span>
                    <strong>{skill.name}</strong>
                    {skill.description ? <span className="mcp-auth-hint" style={{ display: "block" }}>{skill.description}</span> : null}
                    {!skill.enabled ? <span className="mcp-auth-hint" style={{ display: "block" }}>Global 当前停用；绑定为 Private Skill 后会独立启用</span> : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <div className="mcp-auth-error">{mode === "skill" ? "Meta Skill：" : "创建失败："}{error}</div>}
        <div className="mcp-auth-actions">
          <button type="button" className="btn primary" disabled={!canSubmit || generating} onClick={() => void submit()}>{busy ? "创建中…" : "创建"}</button>
          <button type="button" className="btn" disabled={busy || generating} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
