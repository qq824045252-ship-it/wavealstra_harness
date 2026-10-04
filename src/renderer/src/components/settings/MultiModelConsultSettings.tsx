import { useAppStore } from "@/store/appStore";
import { CONSULT_MAX_PARTICIPANTS, type MultiModelConsultConfig } from "@shared/multi-model-consult";
import "./MultiModelConsultSettings.css";

export default function MultiModelConsultSettings({ config, disabled, onChange }: {
  config: MultiModelConsultConfig;
  disabled: boolean;
  onChange: (config: MultiModelConsultConfig) => void;
}): React.JSX.Element {
  const models = useAppStore((state) => state.models).filter((model) => model.enabled !== false);
  const selected = new Set(config.participants.map((p) => p.modelId));
  const choices = models.filter((model) => !selected.has(model.id));
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
      {config.participants.length < CONSULT_MAX_PARTICIPANTS && (
        <select
          className="capability-model-select" aria-label="添加会诊模型" data-testid="consult-add-model"
          value="" disabled={disabled || !choices.length}
          onChange={(event) => { if (event.target.value) onChange({ ...config, participants: [...config.participants, { modelId: event.target.value }] }); }}
        >
          <option value="">{choices.length ? "添加模型（由你明确选择）" : "暂无其他已启用模型"}</option>
          {choices.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.vendor}</option>)}
        </select>
      )}
      {config.participants.length < 2 && <div className="consult-settings-hint">至少选择两个不同模型。多模型不代表结论一定正确，仍需核验证据。</div>}
      <div className="consult-settings-options">
        <label>最大并发 <input className="capability-field" type="number" min={1} max={CONSULT_MAX_PARTICIPANTS} value={config.maxParallel} disabled={disabled} onChange={(event) => onChange({ ...config, maxParallel: Math.max(1, Math.min(CONSULT_MAX_PARTICIPANTS, Number(event.target.value) || 1)) })} /></label>
        <label>单模型超时（秒）<input className="capability-field" type="number" min={10} max={1800} value={config.timeoutSeconds || ""} disabled={disabled} onChange={(event) => onChange({ ...config, timeoutSeconds: Number(event.target.value) || 0 })} onBlur={() => onChange({ ...config, timeoutSeconds: Math.max(10, Math.min(1800, Math.trunc(config.timeoutSeconds) || 10)) })} /></label>
      </div>
      <label className="consult-settings-read"><input type="checkbox" checked={config.readProjectFiles} disabled={disabled} onChange={(event) => onChange({ ...config, readProjectFiles: event.target.checked })} />允许只读读取当前任务授权的文件</label>
      <small className="consult-settings-hint">任务、补充材料及读取到的文件内容会发送给所选模型供应商。模型只读，不执行命令、不写文件、不继续派生模型；完整回答和工具记录保存在当前对话中。</small>
    </div>
  );
}
