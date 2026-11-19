import { useEffect, useState } from "react";
import type { ModelInfoDto, SubagentConfigDto } from "@shared/agent-ipc";
import { PSTACK_ROLE_COUNT_MAX, type PstackSettings } from "@shared/pstack";
import { validateSubagentReasoningPreference } from "@shared/subagent-model-config";
import { Field, NumberInput } from "./PstackSettingsFields";
import SubagentExecutionSettings from "./SubagentExecutionSettings";

export function RoleAvailability({ id, role, config, models }: {
  id: string; role: PstackSettings["roles"][string]; config: SubagentConfigDto; models: ModelInfoDto[];
}) {
  const model = role.model.trim();
  const allowed = new Set(models.map(m => m.id));
  const candidates = model === "default" ? [config.defaultModel, config.globalDefaultModelId].filter((id): id is string => !!id) :
    config.roles && Object.hasOwn(config.roles, model) ? config.roles[model] : model.includes("/") ? [model] : [];
  const available = candidates.filter(id => allowed.has(id));
  const distinct = available.filter((id, index) =>
    available.findIndex(other => other.split("/").at(-1)?.toLowerCase() === id.split("/").at(-1)?.toLowerCase()) === index);
  const judge = id === "arena-cross-judge";
  const preference = role.effort === "off" ? { enabled: false } : { effort: role.effort };
  const supportsBudget = (target: string) => {
    if (role.effort === "default") return true;
    const check = validateSubagentReasoningPreference({ defaultModel: target, preference, models, globalDefaultModelId: undefined });
    return !check.problems.length && check.cliThinking === role.effort;
  };
  const selected = judge ? distinct.filter(supportsBudget).slice(0, role.count) : model === "diverse" ? distinct.slice(0, role.count) : available.slice(0, 1);
  const messages: string[] = [];
  if (config.disabledAgents?.includes("pstack-" + id)) messages.push("此角色已在全局子代理配置中停用。");
  if (!judge && config.maxParallelTasks && role.count > config.maxParallelTasks) messages.push(`代理数量超出全局单批上限 ${config.maxParallelTasks}。`);
  if (model === "inherit-parent") messages.push("运行时核对父任务模型是否在允许范围内。");
  else if (!judge && model === "diverse" && distinct.length < role.count) messages.push(`需配置 ${role.count} 个不同的可用模型，目前有 ${distinct.length} 个。`);
  else if (!available.length) messages.push("需配置至少一个已启用且允许执行的候选模型。");
  else if (judge && !selected.length) messages.push("当前候选均不支持所选推理预算。更换候选模型或调整预算。");
  else if (judge) messages.push(`可供选取的一名裁判　${selected.join("、")}`);
  else messages.push(`当前可选　${selected.join("、")}`);
  if (role.effort !== "default") {
    for (const target of selected) {
      if (!supportsBudget(target)) {
        messages.push(`当前模型目录无法确认 ${target} 支持推理预算 ${role.effort}。可更换模型，或调整推理预算。`);
      }
    }
  }
  return <div className="pstack-host-summary" aria-label="当前角色的模型可用性">
    {model !== "inherit-parent" && <p>候选模型　{candidates.join("、") || "尚未配置"}</p>}
    {messages.map(message => <p key={message}>{message}</p>)}
  </div>;
}

export function PstackHostSettings({ config, models, onSaved }: {
  config: SubagentConfigDto; models: ModelInfoDto[]; onSaved: (config: SubagentConfigDto) => void;
}) {
  const [batch, setBatch] = useState(config.maxParallelTasks ?? Number.NaN);
  const [workers, setWorkers] = useState(config.maxConcurrency ?? Number.NaN);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setBatch(config.maxParallelTasks ?? Number.NaN);
    setWorkers(config.maxConcurrency ?? Number.NaN);
  }, [config.maxParallelTasks, config.maxConcurrency]);
  const save = async () => {
    setMessage("");
    if (!Number.isInteger(batch) || !Number.isInteger(workers) || batch < 1 || workers < 1 || workers > batch) {
      setMessage("请输入正整数，同时运行数不能超过单批任务上限。");
      return;
    }
    setSaving(true);
    try {
      const next = await window.api?.agent?.saveSubagentConfig?.({
        expectedRevision: config.revision, maxParallelTasks: batch, maxConcurrency: workers,
      });
      if (!next) throw Error("子代理配置接口不可用。");
      onSaved(next);
      setMessage(next.maxParallelTasks === batch && next.maxConcurrency === workers ? "并行限制已保存。" : "保存回读与编辑内容不同。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <details className="pstack-host-settings">
    <summary>全局子代理设置 · 单批 {config.maxParallelTasks} 个，同时运行 {config.maxConcurrency} 个</summary>
    <p>以下设置适用于 MyBuddy 的全部子代理任务。</p>
    <fieldset disabled={saving} className="pstack-host-limits">
      <Field label="单批任务上限"><NumberInput label="单批任务上限" value={batch} min={1} max={PSTACK_ROLE_COUNT_MAX} set={setBatch} /></Field>
      <Field label="最多同时运行"><NumberInput label="最多同时运行" value={workers} min={1} max={batch} set={setWorkers} /></Field>
      <button type="button" className="btn" onClick={() => void save()} disabled={batch === config.maxParallelTasks && workers === config.maxConcurrency}>保存并行限制</button>
      {message && <small role="status">{message}</small>}
    </fieldset>
    <SubagentExecutionSettings config={config} onSaved={onSaved}
      models={models.filter(m => m.kind !== "image-generation" && m.available !== false && m.enabled !== false)} />
  </details>;
}
