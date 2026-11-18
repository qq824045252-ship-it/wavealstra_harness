import { API_WEB_SERVICE_BINDINGS, webServiceConnections, type ApiWebServiceBinding, type ApiWebServiceConfig } from "@shared/api-service-settings";
import type { ApiCapabilityConnection } from "@shared/media-capabilities";
import { SettingsSelect } from "./SettingsPrimitives";

const ADD_SERVICE = "__add_api__";
type WebServiceFields = {
  value: ApiWebServiceConfig;
  disabled: boolean;
  onChange: (patch: ApiWebServiceConfig) => void;
};

/** Bind a provider row to the same shared connection used by its other tools. */
export function WebSearchConnection({ binding, value, connections, disabled, onChange, onAdd }: WebServiceFields & {
  binding: ApiWebServiceBinding;
  connections: Record<string, ApiCapabilityConnection>;
  onAdd: (presetId: string) => string | undefined;
}): React.JSX.Element {
  const choices = webServiceConnections(binding, connections);
  const selected = value[binding.connectionField] ?? "";
  return <SettingsSelect label="API 连接" aria-label={`${binding.label} 搜索服务`} disabled={disabled} value={selected}
    hint="搜索与其他工具共用此连接和 API Key。"
    onChange={event => {
      const id = event.target.value === ADD_SERVICE ? onAdd(binding.presetId) : event.target.value;
      // An empty string explicitly clears the previous reference on save.
      if (id !== undefined) onChange({ [binding.connectionField]: id });
    }}>
    <option value="">{choices.length > 1 ? "存在多个连接，请明确选择" : choices.length === 1 ? "自动使用唯一的匹配连接" : "尚未添加 API 连接"}</option>
    {selected && !choices.some(([id]) => id === selected) && <option value={selected}>原服务暂不可用（已保留选择）</option>}
    {choices.map(([id, connection]) => <option key={id} value={id}>{connection.name}</option>)}
    <option value={ADD_SERVICE}>＋ 添加 API 连接…</option>
  </SettingsSelect>;
}

export function WebFetchSettings({ value, disabled, onChange }: WebServiceFields): React.JSX.Element {
  return <SettingsSelect label="网页读取服务" aria-label="网页读取服务" disabled={disabled} value={value.fetchProvider ?? "auto"}
    onChange={event => {
      const next = event.target.value;
      const binding = API_WEB_SERVICE_BINDINGS.find(item => item.fetchProvider === next);
      if (next === "auto" || binding) onChange({ fetchProvider: binding?.fetchProvider ?? "auto" });
    }}>
    <option value="auto">自动（现有网页读取）</option>
    {API_WEB_SERVICE_BINDINGS.map(binding => <option key={binding.provider} value={binding.fetchProvider}>{binding.label}</option>)}
  </SettingsSelect>;
}
