import { useAppStore } from "@/store/appStore";
import {
  CONSULT_MAX_PARALLEL, CONSULT_MAX_TIMEOUT_SECONDS, CONSULT_MAX_TOOL_BUDGET,
  CONSULT_MIN_TIMEOUT_SECONDS, type MultiModelConsultConfig,
} from "@shared/multi-model-consult";
import "./MultiModelConsultSettings.css";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(Number.isFinite(value) ? value : min)));

export default function MultiModelConsultSettings({ config, disabled, onChange }: {
  config: MultiModelConsultConfig;
  disabled: boolean;
  onChange: (config: MultiModelConsultConfig) => void;
}): React.JSX.Element {
  const models = useAppStore((state) => state.models).filter((model) => model.enabled !== false);
  const selected = new Set(config.participants.map((p) => p.modelId));
  return (
    <div className="consult-settings" data-testid="consult-settings">
      <div className="consult-settings-members">
        {config.participants.map((participant, index) => {
          const model = models.find((m) => m.id === participant.modelId);
          const levels = model?.thinkingLevels ?? [];
          return (
            <div className="consult-settings-member" key={participant.modelId}>
              <div className="consult-settings-model" title={participant.modelId}>
                <strong>{model?.name ?? participant.modelId}</strong>
                <small>{model ? participant.modelId : "当前不可用或已停用；调用时会报错，不会自动替换"}</small>
              </div>
              <select
                className="capability-model-select" aria-label={`模型 ${index + 1} 思考等级`}
                data-testid={`consult-thinking-${index}`}
                value={participant.thinkingLevel ?? ""} disabled={disabled}
                onChange={(event) => onChange({ ...config, participants: config.participants.map((p, i) => i === index ? { ...p, thinkingLevel: event.target.value || undefined } : p) })}
              >
                <option value="">遵循 Pi 模型设置</option>
                {participant.thinkingLevel && !levels.includes(participant.thinkingLevel) && <option value={participant.thinkingLevel}>{participant.thinkingLevel}（当前不支持）</option>}
                {levels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
              <button className="btn" type="button" disabled={disabled} aria-label={`移除模型 ${index + 1}`} onClick={() => onChange({ ...config, participants: config.participants.filter((_, i) => i !== index) })}>移除</button>
            </div>
          );
        })}
      </div>
      {/* No count limit and no hidden entries: every enabled model stays listed, already-added ones disabled. */}
      <select
        className="capability-model-select" aria-label="添加会诊模型" data-testid="consult-add-model"
        value="" disabled={disabled || !models.length}
        onChange={(event) => {
          const modelId = event.target.value;
          if (modelId && !selected.has(modelId)) onChange({ ...config, participants: [...config.participants, { modelId }] });
        }}
      >
        <option value="">{models.length ? "添加模型（由你明确选择）" : "暂无已启用模型；请先在设置 → 模型中启用"}</option>
        {models.map((model) => {
          const added = selected.has(model.id);
          return <option key={model.id} value={model.id} disabled={added}>{model.name} · {model.vendor}{added ? "（已添加）" : ""}</option>;
        })}
      </select>
      {config.participants.length < 2 && <div className="consult-settings-hint">至少选择两个不同模型。多模型不代表结论一定正确，仍需核验证据。</div>}
      <div className="consult-settings-options">
        <label>最大并发 <input className="capability-field" type="number" min={1} max={CONSULT_MAX_PARALLEL} data-testid="consult-max-parallel" value={config.maxParallel} disabled={disabled} onChange={(event) => onChange({ ...config, maxParallel: clamp(Number(event.target.value) || 1, 1, CONSULT_MAX_PARALLEL) })} /></label>
        <label>单模型超时（秒）<input className="capability-field" type="number" min={CONSULT_MIN_TIMEOUT_SECONDS} max={CONSULT_MAX_TIMEOUT_SECONDS} data-testid="consult-timeout" value={config.timeoutSeconds || ""} disabled={disabled} onChange={(event) => onChange({ ...config, timeoutSeconds: Number(event.target.value) || 0 })} onBlur={() => onChange({ ...config, timeoutSeconds: clamp(config.timeoutSeconds || CONSULT_MIN_TIMEOUT_SECONDS, CONSULT_MIN_TIMEOUT_SECONDS, CONSULT_MAX_TIMEOUT_SECONDS) })} /></label>
        <label>单模型只读工具预算 <input className="capability-field" type="number" min={0} max={CONSULT_MAX_TOOL_BUDGET} data-testid="consult-tool-budget" value={config.maxToolCalls} disabled={disabled || !config.readProjectFiles} onChange={(event) => { const raw = event.target.value.trim(); if (!raw) return; onChange({ ...config, maxToolCalls: clamp(Number(raw), 0, CONSULT_MAX_TOOL_BUDGET) }); }} /></label>
      </div>
      <label className="consult-settings-read"><input type="checkbox" checked={config.readProjectFiles} disabled={disabled} onChange={(event) => onChange({ ...config, readProjectFiles: event.target.checked })} />允许只读读取当前任务授权的文件（关闭后模型没有工具，工具预算不生效）</label>
      <small className="consult-settings-hint">限制都是可调的：只读工具预算填 <strong>0</strong> 表示不限制（只有超时或用户取消才会停止该模型），默认 24 次；超时上限 {CONSULT_MAX_TIMEOUT_SECONDS} 秒；实际并发不会超过参与模型数量。参与模型数量不设上限，每个模型都会独立计费。</small>
      <small className="consult-settings-hint">任务、补充材料及读取到的文件内容会发送给所选模型供应商。模型只读，不执行命令、不写文件、不继续派生模型；完整回答和工具记录保存在当前对话中。</small>
    </div>
  );
}
