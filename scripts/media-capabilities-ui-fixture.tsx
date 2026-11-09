import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import CapabilitiesTab from "../src/renderer/src/components/settings/CapabilitiesTab";
import { BUILTIN_CAPABILITY_TOOLS, DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import type { BuiltinCapabilitiesConfigDto, BuiltinCapabilitiesSnapshotDto, BuiltinCapabilityId, SaveBuiltinCapabilitySettingsRequest } from "../src/shared/builtin-capabilities";
import { API_PROTOCOL_CAPABILITIES, CODEX_CONNECTION_ID, LOCAL_WHISPER_CONNECTION_ID, MAGPIE_CONNECTION_ID, MEDIA_CAPABILITY_IDS, OPENROUTER_API_ROOT } from "../src/shared/media-capabilities";
import type { CapabilityConnectionOption, MediaCapabilityId } from "../src/shared/media-capabilities";
import type { WebSearchConfigDto } from "../src/shared/agent-ipc";
import "../src/renderer/src/styles/global.css";

const container = document.body.appendChild(document.createElement("main"));
container.style.cssText = "max-width:1020px;margin:0 auto;padding:24px;height:100vh;overflow:auto;box-sizing:border-box";
const root = createRoot(container);
const clone = <T,>(value: T): T => structuredClone(value);
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
// Yield without an arbitrary 35 ms cushion: fast interaction must not lose edits
// to pending passive effects after the initial settings render.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let config: BuiltinCapabilitiesConfigDto;
let search: WebSearchConfigDto;
type ModelCatalog = Partial<Record<MediaCapabilityId, Array<{ id: string; label: string }>>>;
let catalogs: Record<string, ModelCatalog>;
/** The main process discovers a catalogue after saving; the renderer only sees it after a refresh. */
let discoveredCatalogs: Record<string, ModelCatalog>;
let revision: number;
let keyReferences: Set<string>;
let failMain = false;
let failSearch = false;
let failRefresh = false;
let failCheck = false;
let signedIn = true;
let saveGate: Promise<void> | undefined;
let refreshMutation: (() => void) | undefined;
const calls: { main: SaveBuiltinCapabilitySettingsRequest[]; search: WebSearchConfigDto[]; refresh: number; check: BuiltinCapabilityId[]; jobs: number } = { main: [], search: [], refresh: 0, check: [], jobs: 0 };

function enabled(id: BuiltinCapabilityId): boolean {
  switch (id) {
    case "speech-to-text": return config.speechToText.enabled;
    case "ocr": return config.ocr?.enabled ?? false;
    case "text-to-speech": return config.textToSpeech.enabled;
    case "image-generation": return config.imageGeneration.enabled;
    case "video-generation": return config.videoGeneration.enabled;
    case "vision": return config.vision.enabled;
    case "web": return config.web.enabled;
    case "browser": return config.browser.enabled;
    case "runtime-diagnostics": return config.diagnostics?.enabled ?? config.browser.enabled;
    case "terminal": return config.execution.terminalEnabled;
    case "code-execution": return config.execution.codeExecutionEnabled;
    case "subagent": return config.subagent.enabled;
    case "multi-model-consult": return config.multiModelConsult.enabled;
  }
}
function snapshot(): BuiltinCapabilitiesSnapshotDto {
  const mediaServices: CapabilityConnectionOption[] = [
    { id: CODEX_CONNECTION_ID, label: "OpenAI Codex", source: "login", capabilities: ["image-generation"], models: { "image-generation": [{ id: "gpt-image-2", label: "GPT Image 2" }] }, allowCustomModel: false, configured: signedIn, authState: signedIn ? "signed-in" : "needs-login" },
    { id: MAGPIE_CONNECTION_ID, label: "Magpie", source: "login", capabilities: ["image-generation"], models: { "image-generation": [{ id: "magpie-image", label: "Magpie 图片模型" }] }, allowCustomModel: false, configured: true, authState: "signed-in" },
    { id: LOCAL_WHISPER_CONNECTION_ID, label: "本机 Whisper", source: "local", capabilities: ["speech-to-text"], models: {}, allowCustomModel: false, configured: true, authState: "none", location: "loopback" },
    ...Object.entries(config.services ?? {}).map(([id, service]): CapabilityConnectionOption => {
      const capability = service.adapter === "http-asr" ? "speech-to-text" : "ocr";
      return { id: `legacy:${id}`, label: "现有识别服务", source: "legacy", capabilities: [capability], models: { [capability]: [{ id: service.model, label: service.model }] }, allowCustomModel: true, configured: true, authState: service.credentialRef ? keyReferences.has(service.credentialRef) ? "configured" : "missing-key" : "none", location: "loopback" };
    }),
    ...Object.entries(config.connections ?? {}).map(([id, connection]): CapabilityConnectionOption => ({ id, label: connection.name, source: "api", capabilities: API_PROTOCOL_CAPABILITIES[connection.protocol], models: clone(catalogs[id] ?? {}), allowCustomModel: true, configured: true, authState: connection.auth === "none" ? "none" : connection.credentialRef && keyReferences.has(connection.credentialRef) ? "configured" : "missing-key", location: "remote" })),
  ];
  if (config.videoGeneration.provider) mediaServices.push({ id: `registered:${config.videoGeneration.provider}`, label: "原有服务（尚未接入）", source: "legacy", capabilities: [], models: {}, allowCustomModel: false, configured: false, authState: "none" });
  return clone({ config, revision: String(revision), checkedAt: Date.now(), mediaServices, capabilities: Object.keys(BUILTIN_CAPABILITY_TOOLS).map(raw => { const id = raw as BuiltinCapabilityId; return { id, label: id, description: "fixture", category: "media" as const, enabled: enabled(id), state: enabled(id) ? "unchecked" as const : "disabled" as const, tools: BUILTIN_CAPABILITY_TOOLS[id], detail: "已读取配置，未上传任何样本。" }; }) });
}
function installApi(): void {
  (window as any).api = { platform: "linux", agent: {
    getBuiltinCapabilities: async () => snapshot(),
    getWebSearchConfig: async () => clone(search),
    refreshBuiltinMediaServices: async () => {
      calls.refresh++;
      if (failRefresh) throw new Error("模拟目录不可用");
      refreshMutation?.();
      if (Object.keys(discoveredCatalogs).length) { catalogs = { ...catalogs, ...discoveredCatalogs }; discoveredCatalogs = {}; }
      return snapshot();
    },
    saveBuiltinCapabilitySettings: async (request: SaveBuiltinCapabilitySettingsRequest) => {
      calls.main.push(clone(request));
      if (saveGate) await saveGate;
      if (failMain) throw new Error("模拟能力保存失败");
      assert(request.expectedRevision === String(revision), "Save uses the latest safely merged revision");
      config = clone(request.config);
      for (const change of request.credentials ?? []) {
        const legacy = change.connectionId.startsWith("legacy:") ? config.services?.[change.connectionId.slice(7)] : undefined;
        const connection = config.connections?.[change.connectionId];
        const target = legacy ?? connection;
        assert(target, "Credential updates refer to a real connection");
        const ref = target!.credentialRef ?? `internal.${change.connectionId}`;
        target!.credentialRef = ref;
        if (change.clear) keyReferences.delete(ref); else if (change.secret?.trim()) keyReferences.add(ref);
      }
      revision++;
      // The main process discovers the catalogue after saving; it is published on the next status refresh.
      for (const [id, connection] of Object.entries(config.connections ?? {})) {
        if (connection.protocol !== "openrouter" || Object.keys(catalogs[id] ?? {}).length) continue;
        discoveredCatalogs[id] = {
          ocr: [{ id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" }],
          "image-generation": [{ id: "google/gemini-2.5-flash-image", label: "Google Gemini 2.5 Flash Image" }],
        };
      }
      return snapshot();
    },
    saveWebSearchConfig: async (request: WebSearchConfigDto) => { calls.search.push(clone(request)); if (failSearch) throw new Error("模拟搜索保存失败"); search = clone(request); return clone(search); },
    testBuiltinCapability: async (id: BuiltinCapabilityId) => { calls.check.push(id); if (failCheck) throw new Error("模拟检查失败：本机组件不可用"); return { ok: true, state: "unchecked", detail: "配置检查完成，未发起生成。", checkedAt: Date.now() }; },
    listBuiltinVideoJobs: async () => { calls.jobs++; return [{ id: "video-00000000-0000-4000-8000-000000000001", taskId: "fixture-task", connectionId: "api-demo", status: "in_progress", createdAt: 10, updatedAt: 20 }]; },
  } };
}
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!condition()) { if (Date.now() > until) throw new Error(message); await settle(); }
}
async function setup(mutate?: (value: BuiltinCapabilitiesConfigDto) => void, options?: { search?: WebSearchConfigDto; catalogs?: Record<string, ModelCatalog> }): Promise<void> {
  flushSync(() => root.render(null));
  config = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.ocr = { enabled: true, serviceId: "ocr-existing" };
  config.services = { "ocr-existing": { adapter: "http-ocr", endpoint: "http://127.0.0.1:9000/ocr", model: "existing-ocr", credentialRef: "protected-ocr", location: "local", dataPolicy: "local-only", timeoutMs: 60000 } };
  config.videoGeneration.enabled = false;
  config.textToSpeech.enabled = false;
  mutate?.(config);
  search = options?.search ? clone(options.search) : {};
  catalogs = options?.catalogs ? clone(options.catalogs) : {};
  discoveredCatalogs = {};
  revision = 1; keyReferences = new Set(["protected-ocr"]);
  failMain = failSearch = failRefresh = failCheck = false; signedIn = true; saveGate = undefined; refreshMutation = undefined;
  calls.main = []; calls.search = []; calls.refresh = 0; calls.check = []; calls.jobs = 0;
  installApi();
  flushSync(() => root.render(<><h2 className="settings-content-title">工具能力</h2><CapabilitiesTab /></>));
  await waitFor(() => Boolean(document.querySelector('[aria-label="图片生成服务"]')), "Settings load");
}
function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  assert(found, `Missing element: ${selector}`);
  return found!;
}
async function change(selector: string, value: string): Promise<void> {
  const input = element<HTMLInputElement | HTMLSelectElement>(selector);
  await reveal(input);
  assert(!input.matches(":disabled"), `Editable control: ${selector}`);
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
  await settle();
}
async function click(selector: string): Promise<void> {
  const button = element<HTMLElement>(selector);
  await reveal(button);
  assert(!button.matches(":disabled"), `Enabled action: ${selector}`);
  flushSync(() => button.click());
  await settle();
}
async function clickText(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".capabilities-page button")].find(item => item.textContent?.trim() === text);
  assert(button, `Button: ${text}`);
  await reveal(button!);
  assert(!button!.matches(":disabled"), `Enabled button: ${text}`);
  flushSync(() => button!.click()); await settle();
}
async function open(selector: string): Promise<void> { const details = element<HTMLDetailsElement>(selector); if (!details.open) { flushSync(() => { details.open = true; }); await settle(); } }
const CAPABILITY_DISCLOSURE = "details.capability-config-disclosure";
/** Collapsed rows stay mounted; expand every enclosing disclosure before touching their controls. */
async function reveal(node: Element | null): Promise<void> {
  let details = node?.closest?.(CAPABILITY_DISCLOSURE) as HTMLDetailsElement | null | undefined;
  while (details) {
    if (!details.open) { flushSync(() => { details!.open = true; details!.dispatchEvent(new Event("toggle")); }); await settle(); }
    details = details.parentElement?.closest?.(CAPABILITY_DISCLOSURE) as HTMLDetailsElement | null | undefined;
  }
}
async function expand(selector: string): Promise<void> {
  const details = element<HTMLDetailsElement>(selector);
  if (!details.open) { flushSync(() => { details.open = true; details.dispatchEvent(new Event("toggle")); }); await settle(); }
  assert(element<HTMLDetailsElement>(selector).open, `Collapsible row is expanded: ${selector}`);
}
const row = (id: string) => `[data-capability-id="${id}"]`;
const searchRowDisclosure = `${row("web")} ${CAPABILITY_DISCLOSURE}`;
const saveButton = ".capabilities-footer .btn.primary";
async function save(): Promise<void> { await click(saveButton); await waitFor(() => !element(".capabilities-page").getAttribute("aria-busy")?.includes("true"), "Save completes"); }
async function addApi(capability = "图片生成"): Promise<string> {
  await change(`[aria-label="${capability}服务"]`, "__add_api__");
  await waitFor(() => Boolean(document.querySelector("[data-connection-id]")), "New connection editor");
  return element("[data-connection-id]").getAttribute("data-connection-id")!;
}
async function fillApi(id: string): Promise<void> {
  const panel = `[data-connection-id="${id}"]`;
  await change(`${panel} [aria-label="服务名称"]`, "共享测试 API");
  await change(`${panel} [aria-label="API 地址"]`, "https://example.test/v1");
  await change(`${panel} [aria-label="API Key"]`, "fixture-only-key");
}

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  await setup();
  assert(document.querySelectorAll(".capabilities-page h2").length === 0, "Title belongs to SettingsModal only");
  assert(MEDIA_CAPABILITY_IDS.every(id => Boolean(document.querySelector(`${row(id)} select[aria-label$="服务"]`))), "All five capabilities use the same service selector");
  assert(!element(row("image-generation")).textContent?.includes("仅图片理解模型"), "Image input support is never treated as image generation support");
  assert(!element(".capabilities-page").textContent?.includes("Credential ID"), "No credential namespace in the form");
  assert(!document.querySelector('input[placeholder*="Adapter"]'), "No raw adapter ID field");
  assert(element(row("speech-to-text")).textContent?.includes("已配置，未试用"), "Configuration checks do not claim real inference success");
  assert(calls.check.length === 0 && calls.jobs === 0 && calls.main.length === 0, "Opening the page makes no inference, probes, or writes");
  assert(element<HTMLSelectElement>(`${row("ocr")} [aria-label$="服务"]`).value === "legacy:ocr-existing", "Older OCR remains selected");
  assert(!document.querySelector(`${row("ocr")} [aria-label="识别结果用于"]`), "Legacy restrictive policy is read-only");
  assert(element(row("ocr")).textContent?.includes("已保留“仅限本机”"), "Existing privacy restriction is explained");
  passed.push("five shared selectors, precise service catalogue, no exposed adapter/credential IDs or automatic inference");

  refreshMutation = () => { config.mediaBindings!["image-generation"] = { connectionId: CODEX_CONNECTION_ID, model: "gpt-image-2", selection: "auto" }; revision++; };
  await clickText("刷新状态");
  assert(element<HTMLSelectElement>('[aria-label="图片生成模型"]').value === "gpt-image-2", "A resolved automatic service appears without discarding a nonexistent draft");
  assert(!document.querySelector(".capability-message.is-warning"), "Automatic resolution is not an external-edit conflict");
  assert(element<HTMLButtonElement>(saveButton).disabled, "Refreshed defaults are accepted as saved");
  passed.push("first automatic image resolution updates its visible provider/model without an edit conflict");

  await setup();
  await change('[aria-label="图片生成服务"]', MAGPIE_CONNECTION_ID);
  await click(`${row("image-generation")} .switch`);
  refreshMutation = () => { config.mediaBindings!["image-generation"] = { connectionId: CODEX_CONNECTION_ID, model: "gpt-image-2", selection: "auto" }; revision++; };
  await clickText("刷新状态");
  assert(element<HTMLSelectElement>('[aria-label="图片生成服务"]').value === MAGPIE_CONNECTION_ID, "Explicit choice wins over initial auto resolution");
  assert(element(`${row("image-generation")} .switch`).getAttribute("aria-pressed") === "false", "Refresh never re-enables a deliberately disabled capability");
  await save();
  assert(config.mediaBindings!["image-generation"]?.connectionId === MAGPIE_CONNECTION_ID && !config.imageGeneration.enabled, "Manual provider and off preference survive save");
  assert(calls.main[0].expectedRevision === "2", "Safe automatic-default merge advances the submitted revision");
  signedIn = false;
  refreshMutation = undefined;
  await clickText("刷新状态");
  assert(element<HTMLSelectElement>('[aria-label="图片生成服务"]').value === MAGPIE_CONNECTION_ID, "Login changes do not replace the selected provider");
  passed.push("refresh merges new defaults while preserving manual provider and explicit off preferences");

  await setup();
  const id = await addApi();
  assert(/^api-[a-f0-9-]+$/.test(id) && id.length < 100, "Connection identity is internal and generated randomly");
  await fillApi(id);
  await change('[aria-label="图片生成模型"]', "vendor-image");
  await change('[aria-label="文字转语音服务"]', id);
  await change('[aria-label="文字转语音模型"]', "vendor-tts");
  await change('[aria-label="文字转语音声音"]', "voice-one");
  await click(`${row("text-to-speech")} .switch`);
  assert(document.querySelectorAll("[data-connection-id]").length === 1, "Two capabilities reuse one API connection/editor");
  await expand(searchRowDisclosure);
  await open(`${row("web")} .capability-options`);
  await change('[aria-label="Tavily API Key"]', "fixture-search-key");
  failMain = true;
  await save();
  assert(calls.main.length === 1 && calls.search.length === 1, "Both independent save results are observed");
  assert(element(".capability-message.is-ok").textContent?.includes("搜索设置已保存"), "Partial success is visible");
  assert(element(".capability-message.is-error").textContent?.includes("工具能力保存失败"), "Failed part is visible");
  assert(element<HTMLInputElement>(`[data-connection-id="${id}"] [aria-label="API Key"]`).value === "fixture-only-key", "Rejected save preserves the password draft for retry");
  failMain = false;
  await save();
  assert(calls.main.length === 2 && calls.search.length === 1, "Retry does not repeat the successfully saved search settings");
  assert(calls.main[1].credentials?.length === 1 && calls.main[1].credentials[0].connectionId === id, "The shared key is submitted once outside config");
  assert(!JSON.stringify(calls.main[1].config).includes("fixture-only-key"), "Secret is absent from configuration DTO");
  assert(config.mediaBindings!["image-generation"]?.connectionId === id && config.mediaBindings!["text-to-speech"]?.connectionId === id, "Both bindings retain the same connection");
  assert(element<HTMLInputElement>(`[data-connection-id="${id}"] [aria-label="API Key"]`).value === "", "Password is cleared after confirmed success");
  assert(config.services!["ocr-existing"].credentialRef === "protected-ocr" && config.services!["ocr-existing"].dataPolicy === "local-only", "Unrelated legacy privacy and credential reference are preserved");
  passed.push("one reusable connection/key, independent save outcomes, secret isolation and targeted retry");

  await setup();
  await click(`${row("image-generation")} .switch`);
  await expand(searchRowDisclosure);
  await open(`${row("web")} .capability-options`);
  await change('[aria-label="Tavily API Key"]', "another-search-key");
  failSearch = true;
  await save();
  assert(!config.imageGeneration.enabled && calls.main.length === 1, "Main success remains committed when search fails");
  assert(element<HTMLInputElement>('[aria-label="Tavily API Key"]').value === "another-search-key", "Failed search input is retained");
  failSearch = false;
  await save();
  assert(calls.main.length === 1 && calls.search.length === 2, "Search retry does not resend capability settings");
  passed.push("search failure retains its draft without resubmitting already-saved capability settings");

  await setup();
  await change(`${row("ocr")} [aria-label="模型"]`, "updated-ocr");
  await change(`${row("ocr")} [aria-label="API Key"]`, "new-legacy-key");
  let finishSave: (() => void) | undefined;
  saveGate = new Promise<void>(resolve => { finishSave = resolve; });
  await click(saveButton);
  assert([...document.querySelectorAll(".capabilities-page input, .capabilities-page select, .capabilities-page .switch")].every(input => input.matches(":disabled")), "All mutable fields are locked while save awaits confirmation");
  finishSave!();
  await waitFor(() => !element(".capabilities-page").getAttribute("aria-busy")?.includes("true"), "Deferred save completes");
  assert(config.services!["ocr-existing"].model === "updated-ocr" && config.services!["ocr-existing"].credentialRef === "protected-ocr", "Legacy model edit retains internal reference");
  assert(config.services!["ocr-existing"].dataPolicy === "local-only", "Legacy model/key edit cannot relax privacy");
  assert(calls.main[0].credentials?.[0].connectionId === "legacy:ocr-existing", "Legacy key uses the same settings API");
  passed.push("pending-save lock prevents lost edits; legacy endpoint/model/key remain editable without relaxing privacy");

  await setup(value => { value.services!["ocr-other"] = { ...value.services!["ocr-existing"], credentialRef: undefined, endpoint: "https://example.test/ocr", location: "cloud", dataPolicy: "allow-cloud" }; });
  await change('[aria-label="图片文字识别服务"]', "legacy:ocr-other");
  assert(element(`${row("ocr")} .capability-policy-note`).textContent?.includes("仅限本机"), "Changing legacy service cannot hide the inherited restrictive binding");
  await change(`${row("ocr")} [aria-label="模型"]`, "another-ocr");
  await save();
  assert(config.mediaBindings?.ocr?.dataPolicy === "local-only" && config.services!["ocr-other"].dataPolicy === "allow-cloud", "Editing a target service preserves the stricter binding without rewriting the service policy");
  await clickText("允许识别正文用于当前对话");
  await save();
  assert(config.mediaBindings?.ocr?.dataPolicy === "allow-cloud" && config.services!["ocr-existing"].dataPolicy === "local-only", "Only an explicit choice relaxes the new binding; the original legacy restriction stays intact");
  passed.push("restrictive recognition policy survives service changes and edits until explicitly changed on the new binding");

  await setup(value => {
    value.connections = { "api-a": { name: "服务 A", protocol: "openai-compatible", baseUrl: "https://a.test/v1", auth: "none", timeoutMs: 60000 }, "api-b": { name: "服务 B", protocol: "openai-compatible", baseUrl: "https://b.test/v1", auth: "none", timeoutMs: 60000 } };
    value.mediaBindings!["text-to-speech"] = { connectionId: "api-a", model: "tts-a", selection: "manual" };
    value.textToSpeech = { enabled: true, voice: "voice-a", rate: "1.5" };
  });
  await change('[aria-label="文字转语音服务"]', "api-b");
  assert(element<HTMLInputElement>('[aria-label="文字转语音声音"]').value === "" && element<HTMLInputElement>('[aria-label="文字转语音语速"]').value === "", "A new TTS service never inherits another service's voice/rate");
  await change('[aria-label="文字转语音声音"]', "voice-b");
  await change('[aria-label="文字转语音语速"]', "1.25");
  await change('[aria-label="文字转语音模型"]', "tts-b");
  assert(element<HTMLInputElement>('[aria-label="文字转语音声音"]').value === "voice-b", "Changing model within one service preserves its voice choice");
  assert(element<HTMLInputElement>('[aria-label="文字转语音语速"]').value === "1.25", "Changing model within one service preserves its rate");
  await save();
  assert(config.textToSpeech.voice === "voice-b" && config.textToSpeech.rate === "1.25" && config.mediaBindings?.["text-to-speech"]?.model === "tts-b", "Saving a model edit persists voice and rate");
  await change('[aria-label="文字转语音服务"]', "__add_api__");
  assert(element<HTMLInputElement>('[aria-label="文字转语音声音"]').value === "", "Adding a TTS connection also clears the prior service's voice");
  passed.push("TTS voice and rate reset on connection changes, while model edits within a service preserve voice");

  await setup();
  const abandonedId = await addApi("文字转语音");
  await change('[aria-label="文字转语音服务"]', "");
  await click(`[data-connection-id="${abandonedId}"] .capability-connection-actions .btn`);
  assert(!document.querySelector(`[data-connection-id="${abandonedId}"]`), "An incomplete new service can be abandoned even with no alternative provider");
  await save();
  assert(!config.textToSpeech.enabled && !config.connections?.[abandonedId], "Cancelling a new connection does not leave a required invalid endpoint behind");
  passed.push("an incomplete API connection can be unassigned and removed without trapping the settings form");

  await setup(value => {
    value.connections = { "api-a": { name: "服务 A", protocol: "openai-compatible", baseUrl: "https://a.test/v1", auth: "none", timeoutMs: 60000 }, "api-b": { name: "服务 B", protocol: "openai-compatible", baseUrl: "https://b.test/v1", auth: "none", timeoutMs: 60000 } };
  });
  await open("#capability-connection-api-a");
  await click('[data-connection-id="api-a"] .capability-connection-actions .btn');
  refreshMutation = () => { config.connections!["api-b"].name = "服务器更新的 B"; revision++; };
  await clickText("刷新状态");
  assert(!document.querySelector('[data-connection-id="api-a"]') && element<HTMLInputElement>('[data-connection-id="api-b"] [aria-label="服务名称"]').value === "服务器更新的 B", "Deleted entries do not reappear as undefined connections during a three-way merge");
  await save();
  assert(!Object.prototype.hasOwnProperty.call(config.connections, "api-a") && config.connections!["api-b"].name === "服务器更新的 B", "Local deletion and an independent incoming edit both survive save");
  passed.push("refresh merges connection deletion and independent external edits without undefined map entries");

  await setup(value => { value.videoGeneration.provider = "old-custom-provider"; value.videoGeneration.model = "old-video-model"; });
  assert(element<HTMLSelectElement>('[aria-label="视频生成服务"]').value === "registered:old-custom-provider", "Unknown existing provider remains represented");
  await change('[aria-label="图片生成服务"]', MAGPIE_CONNECTION_ID);
  failRefresh = true;
  await clickText("刷新状态");
  assert(element<HTMLSelectElement>('[aria-label="图片生成服务"]').value === MAGPIE_CONNECTION_ID, "Failed refresh preserves manual drafts");
  failRefresh = false;
  await save();
  assert(config.videoGeneration.provider === "old-custom-provider" && config.videoGeneration.model === "old-video-model", "Unrelated save does not erase a legacy provider");
  await open(`${row("video-generation")} .capability-status-details`);
  await clickText("查看最近的视频任务");
  assert(calls.jobs === 1 && element(".capability-video-jobs").textContent?.includes("video-00000000"), "Video job records can be read without submitting another generation");
  assert(element(".capability-video-jobs").textContent?.includes("停止等待不会取消远端生成"), "Remote cancellation is not falsely promised");
  passed.push("unavailable legacy providers and draft refresh failures are preserved; video jobs are read-only and recoverable by id");

  // 1) 联网搜索默认收起，摘要随配置实时变化；展开后搜索控件仍可用。
  await setup(undefined, { search: { searchPolicy: { mode: "parallel", providers: ["tavily", "brave"], providerTimeoutMs: 30000, totalTimeoutMs: 60000, maxRequests: 12, verifySources: true } } });
  const webDisclosure = element<HTMLDetailsElement>(searchRowDisclosure);
  assert(webDisclosure.tagName.toLowerCase() === "details" && !webDisclosure.open, "联网搜索默认收起");
  const summaryText = () => element(`${searchRowDisclosure} > .capability-config-summary > .capability-config-summary-text`).textContent?.trim() ?? "";
  assert(summaryText().includes("多源同时搜索 · 2 家供应商"), "收起摘要显示并行模式的供应商数量");
  assert(element(`${row("web")} .search-provider-grid`).closest(CAPABILITY_DISCLOSURE) === webDisclosure, "收起时子内容保持挂载，未保存的草稿不会丢失");
  assert(element(`${row("web")} .switch`).getAttribute("aria-pressed") === "true" && Boolean(element(`${row("web")} .capability-state`)), "收起状态下行头仍显示开关与状态徽标");
  assert(!element(`${row("web")} .capability-status-details`).closest(CAPABILITY_DISCLOSURE), "检查按钮所在的详情区不随配置折叠");
  assert(element(`${row("web")} .capability-check-btn`).textContent?.trim() === "检查", "折叠不隐藏检查操作");
  await expand(searchRowDisclosure);
  assert(element<HTMLDetailsElement>(searchRowDisclosure).open, "展开后可操作搜索设置");
  const providerGrid = element(`${row("web")} .search-provider-grid`);
  assert(providerGrid.querySelectorAll('input[type="checkbox"]').length === 2 && providerGrid.querySelectorAll("label").length === 2, "展开后供应商网格可见且可勾选");
  assert(!element(`${row("web")} .search-provider-grid input[value="brave"]`).matches(":disabled"), "供应商复选框可用于勾选");
  await click(`${row("web")} .search-provider-grid input[value="brave"]`);
  assert(summaryText().includes("多源同时搜索 · 1 家供应商"), "取消勾选供应商后摘要数量实时更新");
  await change('[aria-label="搜索方式"]', "single");
  assert(summaryText().includes("指定单源 · Tavily"), "单源摘要显示供应商名称");
  await change('[aria-label="搜索方式"]', "fallback");
  assert(summaryText().includes("按序回退 · 1 家"), "回退摘要显示按序供应商数量");
  await change('[aria-label="搜索方式"]', "auto");
  assert(summaryText().includes("自动选择可用源"), "自动模式摘要说明自动选择");
  await click(`${row("web")} .switch`);
  assert(summaryText() === "已关闭", "关闭能力后摘要显示已关闭");
  passed.push("联网搜索默认收起且摘要实时（并行/单源/回退/自动/关闭），展开后供应商网格可勾选，关键操作不被折叠隐藏");

  // 2) 有模型目录时用下拉选择；无目录时仍是文本输入并提示刷新。
  const openRouterCatalog: ModelCatalog = { "image-generation": [{ id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" }, { id: "openai/gpt-5-image", label: "GPT-5 Image" }] };
  await setup(value => {
    value.connections = { "api-or": { name: "OpenRouter", protocol: "openrouter", baseUrl: OPENROUTER_API_ROOT, auth: "none", timeoutMs: 60000 } };
    value.mediaBindings!["image-generation"] = { connectionId: "api-or", model: "openai/gpt-5-image", selection: "manual" };
  }, { catalogs: { "api-or": openRouterCatalog } });
  const modelSelect = element<HTMLSelectElement>('[aria-label="图片生成模型"]');
  assert(modelSelect.tagName.toLowerCase() === "select", "有模型目录时即使允许自定义也用下拉选择");
  assert(modelSelect.options[0].textContent === "请选择模型", "下拉首项为请选择模型");
  assert([...modelSelect.options].some(option => option.value === "google/gemini-2.5-flash-image"), "目录中的模型出现在下拉中");
  assert([...modelSelect.options].some(option => option.textContent === "自定义模型…"), "下拉末尾提供自定义模型入口");
  assert(modelSelect.value === "openai/gpt-5-image", "已绑定的模型保持选中");
  await change('[aria-label="图片生成模型"]', "__custom_model__");
  const customModelInput = element<HTMLInputElement>('[aria-label="图片生成模型（自定义）"]');
  assert(customModelInput.value === "openai/gpt-5-image", "切到文本输入后保留当前模型值");
  await change('[aria-label="图片生成模型（自定义）"]', "vendor/custom-model");
  await save();
  assert(config.mediaBindings!["image-generation"]?.model === "vendor/custom-model", "自定义模型名称可以保存");
  assert(calls.refresh === 0, "目录已存在时保存不重复刷新");
  await clickText("刷新状态");
  assert(element<HTMLInputElement>('[aria-label="图片生成模型（自定义）"]').value === "vendor/custom-model", "同服务目录刷新不退出自定义编辑");
  await change('[aria-label="图片生成服务"]', MAGPIE_CONNECTION_ID);
  assert(!document.querySelector('[aria-label="图片生成模型（自定义）"]'), "切换服务同步重置自定义编辑");
  await change('[aria-label="图片生成服务"]', "api-or");
  assert(!document.querySelector('[aria-label="图片生成模型（自定义）"]'), "切回原服务也从目录选择开始");
  await setup(value => {
    value.connections = { "api-or": { name: "OpenRouter", protocol: "openrouter", baseUrl: OPENROUTER_API_ROOT, auth: "none", timeoutMs: 60000 } };
    value.mediaBindings!["image-generation"] = { connectionId: "api-or", model: "vendor/legacy-model", selection: "manual" };
  }, { catalogs: { "api-or": openRouterCatalog } });
  const staleSelect = element<HTMLSelectElement>('[aria-label="图片生成模型"]');
  assert(staleSelect.value === "vendor/legacy-model" && [...staleSelect.options].some(option => option.value === "vendor/legacy-model" && option.textContent?.includes("暂不可用")), "已绑定但不在目录中的模型保留为暂不可用项");
  await setup();
  const cataloglessId = await addApi("图片生成");
  await fillApi(cataloglessId);
  assert(element('[aria-label="图片生成模型"]').tagName.toLowerCase() === "input", "无目录时仍使用文本输入");
  assert(element(row("image-generation")).textContent?.includes("刷新状态以加载模型目录"), "无目录时提示刷新状态以加载模型目录");
  passed.push("OpenRouter 目录存在时模型改为下拉（含请选择/暂不可用/自定义模型…），无目录时保留文本输入与刷新提示");

  // 3) 检查结果行内可见，错误同样行内可见。
  await setup();
  assert(!document.querySelector(`${row("speech-to-text")} .capability-check-result`), "未检查时行内没有结果");
  const clickCheck = async (id: string): Promise<void> => {
    await click(`${row(id)} .capability-check-btn`);
    await waitFor(() => element(`${row(id)} .capability-check-btn`).textContent?.trim() === "检查", `检查完成：${id}`);
  };
  await clickCheck("speech-to-text");
  assert(calls.check.includes("speech-to-text"), "检查通过设置 API 执行");
  assert(element(`${row("speech-to-text")} .capability-check-result.is-ok`).textContent?.includes("配置检查完成"), "语音转文字行内显示检查详情");
  assert(element(".capability-message.is-ok").textContent?.includes("配置检查完成"), "页面底部消息仍然保留");
  await clickCheck("ocr");
  assert(element(`${row("ocr")} .capability-check-result`).textContent?.includes("配置检查完成"), "图片文字识别行内显示检查详情");
  failCheck = true;
  await clickCheck("speech-to-text");
  assert(element(`${row("speech-to-text")} .capability-check-result.is-error`).textContent?.includes("模拟检查失败"), "失败原因在该行内可见");
  assert(element(".capability-message.is-error").textContent?.includes("模拟检查失败"), "错误同时保留在页面底部");
  passed.push("检查结果与失败原因在对应能力行内可见，同时保留页面底部消息");

  // 4) 保存含 OpenRouter 连接的草稿后自动刷新目录，使模型下拉立即出现。
  await setup(value => {
    value.connections = { "api-or": { name: "OpenRouter", protocol: "openrouter", baseUrl: OPENROUTER_API_ROOT, auth: "none", timeoutMs: 60000 } };
    value.mediaBindings!["image-generation"] = { connectionId: "api-or", model: "openai/gpt-5-image", selection: "manual" };
  });
  assert(element('[aria-label="图片生成模型"]').tagName.toLowerCase() === "input", "保存前没有目录，使用文本输入");
  await change('[aria-label="图片生成模型"]', "openai/gpt-5-image-2");
  await save();
  assert(calls.refresh === 1, "保存含 OpenRouter 连接的草稿后自动刷新目录");
  const refreshedSelect = element<HTMLSelectElement>('[aria-label="图片生成模型"]');
  assert(refreshedSelect.tagName.toLowerCase() === "select", "目录自动出现后改用下拉选择");
  assert([...refreshedSelect.options].some(option => option.value === "google/gemini-2.5-flash-image"), "自动加载的目录模型可选");
  assert(refreshedSelect.value === "openai/gpt-5-image-2" && [...refreshedSelect.options].some(option => option.textContent?.includes("暂不可用")), "尚未收录在目录中的已保存值保留显示");
  assert(element(".capability-message.is-ok").textContent?.includes("工具能力已保存"), "保存成功提示不受目录刷新影响");
  await click(`${row("image-generation")} .switch`);
  await save();
  assert(calls.refresh === 1, "目录已经存在时保存不再重复刷新");
  passed.push("保存 OpenRouter 连接后自动刷新模型目录并接受新状态，已有目录时不重复刷新");

  await setup(value => {
    value.connections = { "api-or": { name: "OpenRouter", protocol: "openrouter", baseUrl: OPENROUTER_API_ROOT, auth: "none", timeoutMs: 60000 } };
    value.mediaBindings!["image-generation"] = { connectionId: "api-or", model: "openai/gpt-5-image", selection: "manual" };
  });
  failRefresh = true;
  await change('[aria-label="图片生成模型"]', "openai/gpt-5-image-3");
  await save();
  assert(calls.refresh === 1, "保存后尝试一次模型目录刷新");
  assert(element(".capability-message.is-ok").textContent?.includes("工具能力已保存"), "目录刷新失败不改变保存成功的提示");
  assert(element(".capability-message.is-ok").textContent?.includes("模型目录暂时未能加载"), "目录刷新失败作为提示呈现");
  assert(!document.querySelector(".capability-message.is-error"), "目录刷新失败不算保存失败");
  assert(element('[aria-label="图片生成模型"]').tagName.toLowerCase() === "input", "目录未加载时保持文本输入");
  failRefresh = false;
  await clickText("刷新状态");
  assert(element<HTMLSelectElement>('[aria-label="图片生成模型"]').tagName.toLowerCase() === "select", "手动刷新后模型目录恢复为下拉");
  passed.push("模型目录刷新失败只提示且保留保存成功状态，手动刷新后可恢复下拉");
  return passed;
}

export async function preview(dark = false): Promise<void> {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  await setup(value => {
    value.connections = { "api-demo": { name: "团队 API", protocol: "openai-compatible", baseUrl: "https://example.test/v1", auth: "api-key", credentialRef: "demo-key", timeoutMs: 60000 } };
    value.mediaBindings = {
      "speech-to-text": { connectionId: "api-demo", model: "transcription-model", selection: "manual", dataPolicy: "allow-cloud" },
      "image-generation": { connectionId: CODEX_CONNECTION_ID, model: "gpt-image-2", selection: "auto" },
      "text-to-speech": { connectionId: "api-demo", model: "speech-model", selection: "manual" },
      "video-generation": { connectionId: "api-demo", model: "video-model", selection: "manual" },
    };
    value.textToSpeech = { enabled: true, voice: "demo-voice", rate: "1" };
    value.videoGeneration.enabled = true;
  });
  keyReferences.add("demo-key");
  await expand(searchRowDisclosure);
  container.scrollTop = 0;
  await settle();
}
export async function showConnections(): Promise<void> { await open(".capability-connection"); element(".capability-connection").scrollIntoView({ block: "start" }); await settle(); }
export function layout(): { width: number; pageWidth: number; fields: number; columns: string } {
  const page = element(".capabilities-page");
  assert(document.documentElement.scrollWidth <= innerWidth + 1, "No horizontal page overflow");
  const fields = [...page.querySelectorAll<HTMLElement>(".settings-input")].filter(field => field.getBoundingClientRect().width > 0);
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    assert(rect.width >= 110 && rect.left >= 0 && rect.right <= innerWidth + 1, "Visible shared fields fit in the viewport");
    const style = getComputedStyle(field);
    assert(style.borderTopStyle !== "none" && parseFloat(style.fontSize) >= 13, "Every input/select uses the shared border and type size");
  }
  const grid = element(`${row("ocr")} .recognition-service-editor .capability-form-grid`);
  const columns = getComputedStyle(grid).gridTemplateColumns;
  assert(columns.split(" ").length === (page.clientWidth > 520 ? 2 : 1), "Legacy recognition fields use the responsive shared grid");
  return { width: innerWidth, pageWidth: page.clientWidth, fields: fields.length, columns };
}
