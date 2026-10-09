import { useAppStore } from "@/store/appStore";
import {
  CONSULT_MAX_PARALLEL, CONSULT_MAX_TIMEOUT_SECONDS, CONSULT_MAX_TOOL_BUDGET,
  CONSULT_MIN_TIMEOUT_SECONDS, consultDistinctModelCount, type ConsultParticipant, type MultiModelConsultConfig,
} from "@shared/multi-model-consult";
import "./MultiModelConsultSettings.css";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(Number.isFinite(value) ? value : min)));

/** "" means "follow the Pi per-model/default preference"; the rest come from the model's Pi levels. */
function levelChoices(levels: string[]): string[] {
  return ["", ...levels];
}

function levelLabel(level: string): string {
  return level || "遵循 Pi 模型设置";
}

export default function MultiModelConsultSettings({ config, disabled, onChange }: {
  config: MultiModelConsultConfig;
  disabled: boolean;
  onChange: (config: MultiModelConsultConfig) => void;
}): React.JSX.Element {
  const models = useAppStore((state) => state.models).filter((model) => model.enabled !== false);
  const participantsOf = (modelId: string): ConsultParticipant[] => config.participants.filter((p) => p.modelId === modelId);
  const addModel = (modelId: string): void => {
    const model = models.find((m) => m.id === modelId);
    const taken = new Set(participantsOf(modelId).map((p) => p.thinkingLevel ?? ""));
    // The same model may join again at a different thinking level; only an exact duplicate is refused.
    const free = levelChoices(model?.thinkingLevels ?? []).find((level) => !taken.has(level));
    if (free === undefined) return;
    onChange({ ...config, participants: [...config.participants, { modelId, ...(free ? { thinkingLevel: free } : {}) }] });
  };
  return (
    <div className="consult-settings" data-testid="consult-settings">
      <div className="consult-settings-members">
        {config.participants.map((participant, index) => {
          const model = models.find((m) => m.id === participant.modelId);
          const levels = model?.thinkingLevels ?? [];
          const takenByOthers = new Set(config.participants.filter((p, i) => i !== index && p.modelId === participant.modelId).map((p) => p.thinkingLevel ?? ""));
          return (
            <div className="consult-settings-member" key={`${index}-${participant.modelId}-${participant.thinkingLevel ?? ""}`}>
              <div className="consult-settings-model" title={participant.modelId}>
                <strong>{model?.name ?? participant.modelId}</strong>
                <small>{model ? participant.modelId : "不可用或已停用"}</small>
              </div>
              <select
                className="capability-model-select" aria-label={`模型 ${index + 1} 思考等级`}
                data-testid={`consult-thinking-${index}`}
                value={participant.thinkingLevel ?? ""} disabled={disabled}
                onChange={(event) => onChange({ ...config, participants: config.participants.map((p, i) => i === index ? { ...p, thinkingLevel: event.target.value || undefined } : p) })}
              >
                {levelChoices(levels).map((level) => (
                  <option key={level || "default"} value={level} disabled={takenByOthers.has(level)}>{levelLabel(level)}{takenByOthers.has(level) ? "（该模型已用）" : ""}</option>
                ))}
                {participant.thinkingLevel && !levels.includes(participant.thinkingLevel) && <option value={participant.thinkingLevel}>{participant.thinkingLevel}（当前不支持）</option>}
              </select>
              <button className="btn" type="button" disabled={disabled} aria-label={`移除模型 ${index + 1}`} onClick={() => onChange({ ...config, participants: config.participants.filter((_, i) => i !== index) })}>移除</button>
            </div>
          );
        })}
      </div>
      {/* No count limit and no hidden entries: every enabled model stays listed, and one already
          added can be added again at another thinking level. */}
      <select
        className="capability-model-select" aria-label="添加会诊模型" data-testid="consult-add-model"
        value="" disabled={disabled || !models.length}
        onChange={(event) => { if (event.target.value) addModel(event.target.value); }}
      >
        <option value="">{models.length ? "添加模型" : "暂无已启用模型；请先在设置 → 模型中启用"}</option>
        {models.map((model) => {
          const added = participantsOf(model.id);
          const taken = new Set(added.map((p) => p.thinkingLevel ?? ""));
          const exhausted = levelChoices(model.thinkingLevels ?? []).every((level) => taken.has(level));
          const suffix = !added.length ? "" : exhausted ? "（等级已全部使用）" : `（已添加 ${added.length}）`;
          return <option key={model.id} value={model.id} disabled={exhausted}>{model.name} · {model.vendor}{suffix}</option>;
        })}
      </select>
      {config.participants.length < 2 && <div className="consult-settings-hint">至少选择两个参与者（模型或思考等级不同）。</div>}
      {config.participants.length >= 2 && consultDistinctModelCount(config.participants) < 2 && (
        <div className="consult-settings-hint">同一模型的不同思考等级不是跨模型验证。</div>
      )}
      <div className="consult-settings-options">
        <label>最大并发 <input className="capability-field" type="number" min={1} max={CONSULT_MAX_PARALLEL} data-testid="consult-max-parallel" title="每个参与者独立计费" value={config.maxParallel} disabled={disabled} onChange={(event) => onChange({ ...config, maxParallel: clamp(Number(event.target.value) || 1, 1, CONSULT_MAX_PARALLEL) })} /></label>
        <label>单模型超时（秒）<input className="capability-field" type="number" min={CONSULT_MIN_TIMEOUT_SECONDS} max={CONSULT_MAX_TIMEOUT_SECONDS} data-testid="consult-timeout" value={config.timeoutSeconds || ""} disabled={disabled} onChange={(event) => onChange({ ...config, timeoutSeconds: Number(event.target.value) || 0 })} onBlur={() => onChange({ ...config, timeoutSeconds: clamp(config.timeoutSeconds || CONSULT_MIN_TIMEOUT_SECONDS, CONSULT_MIN_TIMEOUT_SECONDS, CONSULT_MAX_TIMEOUT_SECONDS) })} /></label>
        <label>单模型只读工具预算 <input className="capability-field" type="number" min={0} max={CONSULT_MAX_TOOL_BUDGET} data-testid="consult-tool-budget" value={config.maxToolCalls} disabled={disabled || !config.readProjectFiles} title="0 表示不限制" onChange={(event) => { const raw = event.target.value.trim(); if (!raw) return; onChange({ ...config, maxToolCalls: clamp(Number(raw), 0, CONSULT_MAX_TOOL_BUDGET) }); }} /></label>
      </div>
      <label className="consult-settings-read" title="读取到的文件内容会发送给所选模型供应商；关闭后模型没有工具，工具预算不生效"><input type="checkbox" checked={config.readProjectFiles} disabled={disabled} onChange={(event) => onChange({ ...config, readProjectFiles: event.target.checked })} />允许只读读取当前任务授权的文件</label>
    </div>
  );
}
