import assert from "node:assert/strict";
import "./api-service-settings-test";
import { verifyApiServiceSettingsDom } from "./api-service-settings-dom-checks";
import { parseHTML } from "linkedom";
import { act } from "react";
import ModelEditorModal from "../src/renderer/src/components/settings/models/ModelEditorModal";
import type { SavedModelEntry } from "../src/renderer/src/components/settings/models/types";

const { window } = parseHTML("<!doctype html><html><body><main id='root'></main></body></html>");
const document = window.document;
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window.HTMLInputElement.prototype, "checked", { configurable: true,
  get() { return this.hasAttribute("checked"); }, set(value: boolean) { value ? this.setAttribute("checked", "") : this.removeAttribute("checked"); } });
const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!;
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true, get: selectValue.get,
  set(value: string) {
    for (const option of this.options) option.removeAttribute("selected");
    [...this.options].find(option => option.value === value)?.setAttribute("selected", "");
  } });
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("root")!);
const initial: SavedModelEntry = { providerId: "deepseek", modelId: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com",
  name: "DeepSeek Flash", contextWindow: 1000000, reasoning: true, imageInput: true, allowOff: true, thinkingKeys: ["low", "high", "max"],
  override: { compat: { supportsStore: false } } };
let key = 0;
let saved: SavedModelEntry | undefined;
async function draw(entry = initial) {
  await act(async () => { root.render(<ModelEditorModal key={++key} mode="edit" initial={entry} busy={false} onClose={() => {}}
    onSave={async value => { saved = structuredClone(value); }} />); });
}
const field = <T extends Element,>(label: string): T => {
  const result = document.querySelector<T>(`[aria-label="${label}"]`); assert(result, label); return result;
};
async function toggle(label: string, checked: boolean) {
  const input = field<HTMLInputElement>(label);
  assert(!input.disabled);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")!.set!.call(input, checked);
    input.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}
async function files(value: string) {
  await act(async () => {
    const select = field<HTMLSelectElement>("DeepSeek 附件处理");
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function save() { await act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "保存")!.click(); }); assert(saved); }
try {
  await verifyApiServiceSettingsDom(root, document);
  await draw();
  assert([...document.querySelectorAll(".models-adv-title")].some(title => title.textContent === "模型原生能力"));
  assert(!document.body.textContent?.includes("DeepSeek 原生能力"));
  assert(!field<HTMLInputElement>("DeepSeek 联网搜索").disabled, "built-in provider base URL / API makes native settings reachable");
  await toggle("DeepSeek 联网搜索", true); await toggle("DeepSeek 网页读取", true); await files("rich"); await save();
  assert.deepEqual(saved!.override?.compat, { supportsStore: false, mybuddyDeepSeek: { webSearch: true, readUrl: true, files: "rich" } });
  await draw(saved!);
  assert(field<HTMLInputElement>("DeepSeek 联网搜索").checked);
  assert(field<HTMLInputElement>("DeepSeek 网页读取").checked);
  assert.equal(field<HTMLSelectElement>("DeepSeek 附件处理").value, "rich");
  await toggle("DeepSeek 联网搜索", false); await toggle("DeepSeek 网页读取", false); await files(""); await save();
  assert.deepEqual(saved!.override?.compat, { supportsStore: false, mybuddyDeepSeek: { webSearch: false, readUrl: false } });
  for (const entry of [{ ...initial, baseUrl: "https://gateway.example/v1" }, { ...initial, api: "anthropic-messages" }, { ...initial, modelId: "deepseek-v4-pro" }]) {
    await draw(entry);
    assert(field<HTMLInputElement>("DeepSeek 联网搜索").disabled);
    assert(field<HTMLSelectElement>("DeepSeek 附件处理").disabled);
  }
  for (const entry of [{ ...initial, api: "openai-responses" }, { ...initial, api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" }]) {
    await draw(entry);
    assert(!field<HTMLInputElement>("DeepSeek 联网搜索").disabled, "all supported official transports expose the same native capabilities");
    assert(!field<HTMLSelectElement>("DeepSeek 附件处理").disabled);
    assert.match(document.body.textContent ?? "", /重启后仍复用/);
  }
  await draw({ ...initial, baseUrl: "https://gateway.example/v1", api: "openai-responses",
    definition: { id: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com" } });
  assert(!field<HTMLInputElement>("DeepSeek 联网搜索").disabled, "model-level transport declarations take precedence over provider defaults");
  await draw({ ...initial, providerId: "openrouter" });
  assert.equal(document.querySelector('[aria-label="DeepSeek 联网搜索"]'), null, "another provider must not inherit native controls by model name");
  console.log("PASS DOM DeepSeek model settings: native opt-ins, preserved compat, save/reopen/disable, endpoint/protocol/model gates");
} finally { await act(async () => { root.unmount(); }); }
