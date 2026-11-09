import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import { artifactImageUrl } from "../src/shared/artifact-ipc";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.assign(globalThis, { window: testWindow, document: testDocument, localStorage: storage,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(testWindow, "localStorage", { value: storage });
Object.defineProperty(testWindow, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(testWindow.HTMLElement.prototype, {
  showModal() { this.setAttribute("open", ""); },
  close() { this.removeAttribute("open"); },
});
async function main() {
  const { createRoot } = await import("react-dom/client");
  const { useAppStore } = await import("../src/renderer/src/store/appStore");
  const { BotMessage } = await import("../src/renderer/src/components/pages/BotWorkspacePage");
  await import("../src/renderer/src/components/chat/ChatMarkdown");
  const source = String.raw`C:\Users\fixture\.mybuddy\bot-workspaces\report-workspace\截图预览\桌面_首屏.png`;
  const image: ArtifactDescriptor = { id: "report-snapshot", taskId: "report-task", kind: "image", version: 1,
    source: { type: "managed-content", storagePath: "report-task/report-snapshot/index.bin", rootDir: "C:/artifacts" },
    capabilities: {}, title: "evidence.png", createdByMessageId: "report", createdAt: 1, updatedAt: 1 };
  const foreign: ArtifactDescriptor = { ...image, id: "foreign", taskId: "sidebar-task",
    source: { type: "workspace-file", entryFile: source, rootDir: "C:/" } };
  const loads: string[] = [];
  useAppStore.setState({ activeTaskId: "sidebar-task", artifactProjection: {
    artifactsByTask: { "sidebar-task": [foreign] }, revisionByTask: {}, loadStateByTask: {},
  } as unknown as ReturnType<typeof useAppStore.getState>["artifactProjection"],
    ensureArtifactRenderPayload: async id => { loads.push(id); return null; }, releaseArtifactRender() {},
  });
  const message: BotMessageDto = { messageId: "report", botId: "bot", conversationId: "chat", requestId: "feedback",
    ordinal: 1, role: "assistant", text: `![截图](${source})`, status: "completed", workIds: ["work"], createdAt: 1, updatedAt: 1,
    reportImages: { taskId: image.taskId, artifacts: [image], sources: { [source]: image.id } } };
  const container = testDocument.body.appendChild(testDocument.createElement("div"));
  const root = createRoot(container);
  const render = async (value: BotMessageDto) => {
    await act(async () => { root.render(<StrictMode><BotMessage message={value} botName="Bot" works={[]} onOpenWork={() => {}} onCancel={() => {}} /></StrictMode>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  };
  try {
    await render(message);
    const rendered = container.querySelector("img.chat-inline-image");
    assert(rendered, container.innerHTML);
    assert.equal(rendered.getAttribute("src"), artifactImageUrl(image.id, "thumb", { version: 1 }));
    assert.equal(loads.length, 0, "message snapshots render without global task hydration");
    await act(async () => rendered.dispatchEvent(new testWindow.Event("error")));
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "重试图片");
    assert(retry);
    await act(async () => retry.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
    assert(container.querySelector("img.chat-inline-image"));
    assert.equal(useAppStore.getState().activeTaskId, "sidebar-task");
    await act(async () => container.querySelector("img.chat-inline-image")!.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
    const preview = testDocument.querySelector('dialog[aria-label="报告原图"]');
    assert(preview); assert(preview.hasAttribute("open"));
    assert.equal(preview.querySelector("img")?.getAttribute("src"), artifactImageUrl(image.id, "full", { version: 1 }));
    await act(async () => preview.querySelector("button")!.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
    assert.equal(testDocument.querySelector('dialog'), null);
    assert.equal(useAppStore.getState().activeTaskId, "sidebar-task");
    for (const text of ["![截图](capture(1).png)", "![截图][proof]\n\n[proof]: capture(1).png \"证据\""] ) {
      await render({ ...message, text, reportImages: { ...message.reportImages!, sources: { "capture(1).png": image.id } } });
      assert.equal(container.querySelector("img.chat-inline-image")?.getAttribute("src"), artifactImageUrl(image.id, "thumb", { version: 1 }));
    }
    const parenthesesPath = String.raw`C:\(shots)\image.png`;
    await render({ ...message, text: `![shot](${parenthesesPath})`,
      reportImages: { ...message.reportImages!, sources: { [parenthesesPath]: image.id } } });
    assert.equal(container.querySelector("img.chat-inline-image")?.getAttribute("src"), artifactImageUrl(image.id, "thumb", { version: 1 }));
    await render({ ...message, reportImages: undefined });
    assert.equal(container.querySelector("img.chat-inline-image"), null, "no sidebar Task fallback when the report lacks a binding");
    assert(container.textContent.includes("图片无法显示"));
    await render({ ...message, text: `![foreign](${artifactImageUrl(foreign.id, "thumb")})` });
    assert.equal(container.querySelector("img.chat-inline-image"), null, "foreign artifact protocol URLs cannot bypass the message scope");
    await render(message);
    assert.equal(container.querySelector("img.chat-inline-image")?.getAttribute("src"), artifactImageUrl(image.id, "thumb", { version: 1 }));
    console.log("PASS bot report React UI: scoped protocol image, no active-task or foreign URL fallback, repeated navigation");
  } finally { await act(async () => root.unmount()); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
