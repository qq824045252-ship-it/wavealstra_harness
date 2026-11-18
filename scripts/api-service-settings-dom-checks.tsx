import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import ApiServicePicker from "../src/renderer/src/components/settings/ApiServicePicker";
import { WebFetchSettings, WebSearchConnection } from "../src/renderer/src/components/settings/WebServiceSettings";
import { API_WEB_SERVICE_BINDINGS, createApiServiceConnection, type ApiWebServiceConfig } from "../src/shared/api-service-settings";
import { MEDIA_PROVIDER_PRESETS, type ApiCapabilityConnection } from "../src/shared/media-capabilities";

/** Run within the existing isolated DOM suite; no production credentials or IPC. */
export async function verifyApiServiceSettingsDom(root: { render: (node: ReactNode) => void }, document: Document): Promise<void> {
  const field = (label: string): HTMLSelectElement => {
    const element = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
    assert(element, label); return element;
  };
  const select = async (label: string, value: string): Promise<void> => {
    await act(async () => {
      const element = field(label);
      element.value = value;
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  let presetId = "";
  const added: ApiCapabilityConnection[] = [];
  const drawPicker = async (disabled = false): Promise<void> => {
    await act(async () => { root.render(<ApiServicePicker value={presetId} disabled={disabled}
      onChange={value => { presetId = value; }} onAdd={value => { added.push(createApiServiceConnection(value)); }} />); });
  };
  const addButton = (): HTMLButtonElement => {
    const element = document.querySelector<HTMLButtonElement>('[data-testid="api-service-picker"] button');
    assert(element); return element;
  };
  await drawPicker();
  assert.deepEqual([...field("API 服务商").options].map(option => option.value), ["", ...MEDIA_PROVIDER_PRESETS.map(item => item.id)]);
  assert.equal(addButton().textContent, "添加 API 服务");
  assert(![...document.querySelectorAll("button")].some(button => button.textContent === "添加 DeepSeek"));
  for (const preset of ["deepseek", "openrouter"]) {
    const count = added.length;
    await select("API 服务商", preset);
    await drawPicker();
    assert.equal(added.length, count, "selecting a provider alone does not create a connection");
    await act(async () => { addButton().click(); });
    assert.equal(added.length, count + 1);
    assert.equal(added.at(-1)?.presetId, preset);
    assert.equal(added.at(-1)?.protocol, preset);
  }
  await drawPicker(true);
  assert(field("API 服务商").disabled && addButton().disabled);
  presetId = "removed-provider";
  await drawPicker();
  assert.equal(field("API 服务商").value, "removed-provider");
  assert(addButton().disabled);

  let value: ApiWebServiceConfig = {};
  const connections: Record<string, ApiCapabilityConnection> = { "api-router": createApiServiceConnection("openrouter") };
  let additions = 0;
  const drawWeb = async (): Promise<void> => {
    const onChange = (patch: ApiWebServiceConfig): void => { value = { ...value, ...patch }; };
    await act(async () => { root.render(<><WebSearchConnection binding={API_WEB_SERVICE_BINDINGS[0]} value={value} connections={connections} disabled={false}
      onChange={onChange} onAdd={preset => {
        const id = `api-web-${++additions}`;
        connections[id] = createApiServiceConnection(preset);
        return id;
      }} /><WebFetchSettings value={value} disabled={false} onChange={onChange} /></>); });
  };
  await drawWeb();
  assert(![...field("DeepSeek 搜索服务").options].some(option => option.value === "api-router"));
  await select("DeepSeek 搜索服务", "__add_api__");
  await drawWeb();
  assert.equal(value.deepseekConnectionId, "api-web-1");
  assert.equal(field("DeepSeek 搜索服务").value, "api-web-1");
  await select("网页读取服务", "deepseek");
  await drawWeb();
  assert.equal(value.fetchProvider, "deepseek");
  value = JSON.parse(JSON.stringify(value));
  await drawWeb();
  assert.equal(field("DeepSeek 搜索服务").value, "api-web-1");
  connections["api-web-2"] = createApiServiceConnection("deepseek");
  await select("DeepSeek 搜索服务", "");
  await drawWeb();
  assert.equal(value.deepseekConnectionId, "", "Clearing a previously saved binding sends an explicit unset");
  assert.match(field("DeepSeek 搜索服务").options[0].textContent ?? "", /多个连接/);
  value = { ...value, deepseekConnectionId: "api-removed" };
  await drawWeb();
  assert.equal(field("DeepSeek 搜索服务").value, "api-removed");
  assert.match([...field("DeepSeek 搜索服务").options].find(option => option.value === "api-removed")?.textContent ?? "", /暂不可用/);
  console.log("PASS DOM unified API services: one picker, both providers, explicit creation, disabled/invalid states, shared web references and stale selections");
}
