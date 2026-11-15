import { MEDIA_PROVIDER_PRESETS } from "@shared/media-capabilities";
import { apiServiceCapabilityLabels, createApiServiceConnection } from "@shared/api-service-settings";
import { SettingsSelect } from "./SettingsPrimitives";
import "./ApiServicePicker.css";

/** One controlled creation surface for every supported provider and custom API. */
export default function ApiServicePicker({ value, disabled, onChange, onAdd }: {
  value: string; disabled: boolean; onChange: (value: string) => void; onAdd: (presetId?: string) => void;
}): React.JSX.Element {
  const preset = MEDIA_PROVIDER_PRESETS.find(item => item.id === value);
  const invalid = Boolean(value && !preset);
  return <div className="settings-row capability-add-service capability-add-service--unified" data-testid="api-service-picker">
    <SettingsSelect label="服务商" aria-label="API 服务商" value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)}>
      <option value="">自定义兼容 API</option>
      {invalid && <option value={value}>原服务商暂不可用</option>}
      {MEDIA_PROVIDER_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </SettingsSelect>
    <div className="settings-row-desc">{preset
      ? `已接入：${apiServiceCapabilityLabels(createApiServiceConnection(preset.id)).join("、")}。模型及账户权限仍以服务端为准。`
      : "填写服务地址和 API Key；添加后为需要的能力选择同一个连接。"}</div>
    <button type="button" className="btn" disabled={disabled || invalid} onClick={() => onAdd(value || undefined)}>添加 API 服务</button>
  </div>;
}
