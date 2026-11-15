import { API_WEB_SERVICE_BINDINGS, webServiceConnections, type ApiWebServiceConfig } from "@shared/api-service-settings";
import type { ApiCapabilityConnection } from "@shared/media-capabilities";
import { SettingsSelect } from "./SettingsPrimitives";

const ADD_SERVICE = "__add_api__";
/** Adapter metadata maps existing persisted fields; the view never owns credentials. */
export default function WebServiceSettings({ value, connections, disabled, onChange, onAdd }: {
  value: ApiWebServiceConfig;
  connections: Record<string, ApiCapabilityConnection>;
  disabled: boolean;
  onChange: (patch: ApiWebServiceConfig) => void;
  onAdd: (presetId: string) => string | undefined;
}): React.JSX.Element {
  return <>
    <div className="capability-form-grid">
      {API_WEB_SERVICE_BINDINGS.map(binding => {
        const choices = webServiceConnections(binding, connections);
        const selected = value[binding.connectionField] ?? "";
        return <SettingsSelect key={binding.provider} label="搜索 / 网页服务连接" aria-label={`${binding.label} 搜索服务`}
          disabled={disabled} value={selected} hint={`供 ${binding.label} 检索接口使用，与其他工具共用 API 服务连接。`}
          onChange={event => {
            const id = event.target.value === ADD_SERVICE ? onAdd(binding.presetId) : event.target.value;
            if (id !== undefined) onChange({ [binding.connectionField]: id || undefined });
          }}>
          <option value="">{choices.length > 1 ? "存在多个连接，请明确选择" : "自动使用唯一的匹配连接"}</option>
          {selected && !choices.some(([id]) => id === selected) && <option value={selected}>原服务暂不可用（已保留选择）</option>}
          {choices.map(([id, connection]) => <option key={id} value={id}>{connection.name}</option>)}
          <option value={ADD_SERVICE}>＋ 添加 API 服务…</option>
        </SettingsSelect>;
      })}
      <SettingsSelect label="网页读取服务" aria-label="网页读取服务" disabled={disabled} value={value.fetchProvider ?? "auto"}
        onChange={event => {
          const next = event.target.value;
          const binding = API_WEB_SERVICE_BINDINGS.find(item => item.fetchProvider === next);
          if (next === "auto" || binding) onChange({ fetchProvider: binding?.fetchProvider ?? "auto" });
        }}>
        <option value="auto">自动（现有网页读取）</option>
        {API_WEB_SERVICE_BINDINGS.map(binding => <option key={binding.provider} value={binding.fetchProvider}>{binding.label}</option>)}
      </SettingsSelect>
    </div>
    <p className="settings-row-desc">只显示已接入检索接口的服务连接；支持多种模型不代表支持全部工具接口。连接和 Key 在统一的 API 服务区管理，主聊天模型可独立选择。</p>
  </>;
}
