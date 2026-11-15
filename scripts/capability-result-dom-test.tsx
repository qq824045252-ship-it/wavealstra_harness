import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import CapabilityResultCard, { speechDownloadName } from "../src/renderer/src/components/chat/CapabilityResultCard";
import ExecutionTimeline from "../src/renderer/src/components/chat/ExecutionTimeline";
import ToolCallCard from "../src/renderer/src/components/chat/ToolCallCard";
import BotToolResults from "../src/renderer/src/components/pages/BotToolResults";
import WebSearchCard from "../src/renderer/src/components/chat/WebSearchCard";
import { getSpeechStream, ingestSpeechAudio, stopSpeechPlayback } from "../src/renderer/src/lib/speechStreams";
import type { ToolCall } from "../src/renderer/src/types";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";

const { window } = parseHTML("<!doctype html><html><body><main id='root'></main></body></html>");
const document = window.document;
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
  Event: window.Event, CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window.HTMLElement.prototype, "open", { configurable: true, get() { return this.hasAttribute("open"); },
  set(value: boolean) { value ? this.setAttribute("open", "") : this.removeAttribute("open"); } });
let audioPauses = 0;
Object.defineProperty(window.HTMLElement.prototype, "pause", { configurable: true, value() { if (this.tagName === "AUDIO") audioPauses++; } });
let clipboard = "";
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "DOM fixture", clipboard: { writeText: async (text: string) => { clipboard = text; } } } });

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start() {}
  stop() { this.stopped = true; }
}
const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  currentTime = 1;
  destination = {};
  sources: FakeSource[] = [];
  suspended = 0;
  closed = 0;
  constructor() { contexts.push(this); }
  async resume() {}
  async suspend() { this.suspended++; }
  async close() { this.closed++; }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
}
Object.assign(globalThis, { AudioContext: FakeAudioContext });
const scope = { taskId: "task-a", messageId: "message-a", toolCallId: "speech-a", streamId: "stream-a" };
const descriptor: ArtifactDescriptor = { id: "saved-speech", taskId: scope.taskId, kind: "audio", title: "合成语音", mimeType: "audio/wav",
  source: { type: "workspace-file", entryFile: "/test/回答.wav", rootDir: "/test" }, capabilities: {}, version: 1,
  createdByMessageId: scope.messageId, createdByToolCallId: scope.toolCallId, createdAt: 1, updatedAt: 1 };
const reads: unknown[] = [];
const cancels: unknown[] = [];
const downloads: Array<{ href: string; name: string }> = [];
const fetched: string[] = [];
const realFetch = globalThis.fetch;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const anchorClick = window.HTMLAnchorElement.prototype.click;
let downloadStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL) => { fetched.push(String(input));
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: downloadStatus, headers: { "content-type": "audio/wav" } }); }) as typeof fetch;
URL.createObjectURL = blob => { assert.equal((blob as Blob).size, 4); return "blob:test-saved-audio"; };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, name: this.getAttribute("download") ?? "" }); };
let artifactValue: ArtifactDescriptor | null = descriptor;
window.api = { artifactDomain: { get: async request => { reads.push(request); return { artifact: artifactValue }; } },
  speech: { cancel: async request => { cancels.push(request); return true; } } } as unknown as Window["api"];
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("root")!);
const text = () => document.body.textContent ?? "";
const button = (label: string): HTMLButtonElement => {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  assert(value, `button ${label}`); return value;
};
const draw = async (element: React.ReactNode) => { await act(async () => root.render(element)); };
const click = async (label: string) => { await act(async () => button(label).click()); };
const speech: ToolCall = { id: scope.toolCallId, tool: "text_to_speech", summary: "合成语音", status: "running" };
const pcmBase64 = Buffer.from(new Uint8Array(480)).toString("base64");

try {
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={speech} />);
  assert.match(text(), /正在准备语音/);
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={{ ...speech, capabilityResult: { kind: "speech", transport: "http", artifacts: [] } }} />);
  assert.match(text(), /正在合成语音，完成后可播放/);
  assert(!text().includes("实时试听"), "HTTP synthesis does not promise streaming chunks");
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={speech} />);
  await act(async () => ingestSpeechAudio({ ...scope, kind: "start", format: "pcm_s16le", sampleRate: 24_000, channels: 1 }));
  assert(button("播放实时语音"));
  assert.equal(contexts.length, 0, "an arriving stream does not autoplay");
  await click("播放实时语音");
  assert.match(text(), /缓冲中/);
  await act(async () => ingestSpeechAudio({ ...scope, kind: "chunk", sequence: 0, pcmBase64 }));
  assert.equal(contexts[0].sources.length, 1);
  assert.match(text(), /正在播放/);
  await click("暂停试听");
  assert.equal(contexts[0].suspended, 1);
  await act(async () => ingestSpeechAudio({ ...scope, kind: "chunk", sequence: 1, pcmBase64 }));
  assert.equal(contexts[0].sources.length, 1);
  await click("继续试听");
  assert.equal(contexts[0].sources.length, 2);
  await click("停止试听");
  assert(contexts[0].sources.every(source => source.stopped));
  await act(async () => ingestSpeechAudio({ ...scope, kind: "chunk", sequence: 2, pcmBase64 }));
  assert.equal(contexts.length, 1, "later chunks cannot restart stopped playback");
  await click("取消语音生成");
  assert.deepEqual(cancels, [{ taskId: scope.taskId, toolCallId: scope.toolCallId, streamId: scope.streamId }]);

  const complete: ToolCall = { ...speech, status: "success", capabilityResult: { kind: "speech", stream: scope, provider: "deepseek", transport: "websocket",
    voice: "stella", artifacts: [{ id: descriptor.id, name: "回答.wav", durationSeconds: 6 }] } };
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={complete} />);
  assert.deepEqual(reads[0], { taskId: scope.taskId, artifactId: descriptor.id }, "saved audio uses explicit task ownership");
  const audio = document.querySelector<HTMLAudioElement>("audio")!;
  assert(audio);
  assert.equal(audio.getAttribute("preload"), "none");
  assert.equal(audio.hasAttribute("autoplay"), false);
  assert.equal(audio.getAttribute("src"), "mybuddy-artifact://local/saved-speech/?v=1");
  assert(button("下载音频"));
  await click("下载音频");
  assert.deepEqual(downloads, [{ href: "blob:test-saved-audio", name: "合成语音.wav" }], "a friendly artifact title preserves the trusted WAV extension when downloading");
  assert.deepEqual(fetched, ["mybuddy-artifact://local/saved-speech/?v=1"], "downloads only read the validated artifact protocol");
  assert.equal(speechDownloadName({ ...descriptor, title: "answer.txt", mimeType: "audio/mpeg" }, "fallback"), "answer.mp3");
  assert.equal(speechDownloadName({ ...descriptor, title: "", mimeType: "audio/ogg" }, "fallback"), "fallback.ogg");
  downloadStatus = 404;
  await click("下载音频");
  assert.match(text(), /读取音频失败（404）/);
  assert.equal(downloads.length, 1, "a failed download never emits an empty or corrupt file");
  assert(!text().includes("取消语音生成"), "completed tools do not offer stale cancellation");
  await click("播放实时语音");
  const resumed = contexts.at(-1)!;
  await act(async () => audio.dispatchEvent(new window.Event("play", { bubbles: true })));
  assert.equal(resumed.closed, 1, "playing a saved WAV stops the live preview");
  await click("播放实时语音");
  const navigation = contexts.at(-1)!;
  await draw(<div>另一个对话</div>);
  assert.equal(navigation.closed, 1, "navigation/unmount stops current playback");
  assert(audioPauses > 0, "saved audio also pauses on navigation");

  const ocr: ToolCall = { id: "ocr-a", tool: "ocr_file", summary: "文档识别", status: "success", capabilityResult: {
    kind: "ocr", provider: "deepseek", purpose: "rich_layout_recognition", text: "全部页次文字", pageCount: 4, truncated: true,
    pages: [{ index: 0, text: "第一页 <|box|>100 200 300 400<|/box|>", finishReason: "stop" }, { index: 1, text: "第二页正文", finishReason: "length" },
      { index: 2, text: "第三页正文", finishReason: "stop" }, { index: 3, text: "第四页正文", finishReason: "stop" }] } };
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={ocr} />);
  assert.match(text(), /部分页面未完整识别/);
  assert.match(text(), /页面归一化坐标/);
  assert.match(text(), /第 2 页 · 内容未完整返回/);
  assert(!text().includes("第四页正文"), "long documents only mount page text when expanded");
  const page = document.querySelectorAll<HTMLDetailsElement>(".capability-ocr-page")[3];
  await act(async () => { page.open = true; page.dispatchEvent(new window.Event("toggle", { bubbles: true })); });
  assert.match(text(), /第四页正文/);
  await click("复制文本");
  assert.equal(clipboard, "全部页次文字");

  const transcript: ToolCall = { id: "asr-a", tool: "speech_to_text", summary: "音频转写", status: "success", capabilityResult: {
    kind: "transcript", text: "这是完整转写。", provider: "deepseek", durationMs: 65000, channelSelection: "left" } };
  await draw(<CapabilityResultCard taskId={scope.taskId} toolCall={transcript} />);
  assert.match(text(), /音频时长 1:05/);
  assert.match(text(), /已转写左声道/);
  assert.match(text(), /这是完整转写/);
  assert.equal(document.querySelector(".capability-transcript-segments"), null, "no segment timestamps are fabricated");
  await draw(<ExecutionTimeline taskId={scope.taskId} message={{ id: scope.messageId, role: "assistant", createdAt: 1,
    streaming: false, blocks: [{ type: "tool", toolCall: transcript }] }} />);
  assert(document.querySelector(".capability-transcript"), "ordinary chat keeps usable results outside its collapsed process timeline");
  await draw(<BotToolResults taskId={scope.taskId} messageId={scope.messageId} tools={[ocr as never, transcript as never, complete as never]} />);
  assert.equal(document.querySelectorAll(".capability-result-card").length, 3, "Bot and ordinary chat share the same result cards");
  await draw(<ToolCallCard taskId={scope.taskId} messageId={scope.messageId} toolCall={{ ...speech, status: "pending_approval", approvalKind: "acp",
    externalRunId: "external-run", acpPermissionOptions: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] }} />);
  assert(document.querySelector(".approval-acp-shell"), "a media-shaped external tool retains its original permission controls");
  assert.equal(document.querySelector(".capability-result-card"), null);

  const search: ToolCall = { id: "search-a", tool: "deepseek_web_search", summary: "搜索", status: "success", webSearch: {
    version: 1, id: "report-a", status: "complete", queries: ["查询"], sources: [{ title: "网页", url: "https://example.test/source", snippet: "来源摘录", summary: "服务生成的页面摘要", evidence: "snippet" }],
    runs: [{ provider: "deepseek", query: "查询", status: "success", durationMs: 1234, results: [], answer: "服务综合答案" }] } };
  let followup = "";
  await draw(<WebSearchCard toolCall={search} onFollowup={value => { followup = value; }} />);
  await act(async () => document.querySelector<HTMLButtonElement>(".web-search-heading")!.click());
  assert.match(text(), /服务综合答案/);
  assert.match(text(), /供应商生成的页面摘要 · 未独立核验/);
  assert.match(text(), /仅搜索摘要/);
  assert(!text().includes("已读取原文"));
  assert.equal(document.querySelector<HTMLAnchorElement>(".web-search-source a")!.getAttribute("href"), "https://example.test/source");
  const tabs = document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => { const event = new window.Event("keydown", { bubbles: true }); Object.defineProperty(event, "key", { value: "ArrowRight" }); tabs[0].dispatchEvent(event); });
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].getAttribute("tabindex"), "-1");
  assert(document.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby")?.endsWith("-tab-1"));
  await click("继续核验关键结论");
  assert.match(followup, /查询/);
  await draw(<BotToolResults taskId={scope.taskId} messageId={scope.messageId} tools={[search as never]} />);
  await act(async () => document.querySelector<HTMLButtonElement>(".web-search-heading")!.click());
  assert.equal(document.querySelector(".web-search-followup"), null, "read-only Bot views do not append into an unrelated ordinary composer");

  artifactValue = { ...descriptor, taskId: "other-task" };
  await draw(<CapabilityResultCard key="other-task" taskId={scope.taskId} toolCall={complete} />);
  assert.equal(document.querySelector("audio"), null, "a mismatched artifact never becomes a media source");
  assert.match(text(), /不属于当前工具调用/);
  assert(getSpeechStream(scope));
  console.log("PASS DOM capability results: scoped live playback/actions, saved WAV controls, navigation cleanup, OCR pages/truncation/copy, ASR metadata, shared Bot/chat cards, labeled search summaries and accessible tabs");
} finally { await act(async () => { root.unmount(); stopSpeechPlayback(); });
  globalThis.fetch = realFetch; URL.createObjectURL = realCreateObjectURL; URL.revokeObjectURL = realRevokeObjectURL;
  window.HTMLAnchorElement.prototype.click = anchorClick;
}
