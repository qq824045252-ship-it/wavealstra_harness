/**
 * 设置 → Dots → 提示词：载入默认或保存的提示词，并恢复默认。
 * 只渲染组件，不启动应用。
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import type { AppSettingsDto } from "../src/shared/agent-ipc";
import type { AssemblySegmentDto } from "../src/shared/mode-profile";
import DotsPromptSection from "../src/renderer/src/components/settings/DotsPromptSection";

const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const builtIn = "在原对话回传结果";
const custom = "直接告诉我结果";
const append = "先给结论";
let override = "";

(window as unknown as { api: unknown }).api = {
  dots: { getPromptSegments: async (): Promise<AssemblySegmentDto[]> => [
    ...override ? [{ id: "dotsInstructions", title: "整段自定义", source: "user" as const, chars: override.length, content: override }] : [
      { id: "role", title: "身份与办事范围", source: "seed" as const, chars: 12, content: "先判断能否当场作答" },
      { id: "delivery", title: "回复与交付", source: "seed" as const, chars: builtIn.length, content: builtIn },
    ],
    { id: "dotsPromptAppend", title: "Dots 自定义提示词", source: "user", chars: append.length, content: append },
  ] },
  agent: {
    updateAppSettings: async (partial: Partial<AppSettingsDto>) => {
      override = partial.dotsPromptOverride ?? override;
      return { ...partial, dotsPromptOverride: override, dotsPromptAppend: partial.dotsPromptAppend ?? append } as AppSettingsDto;
    },
  },
};

async function main() {
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let saved: AppSettingsDto | undefined;
  const load = (key: string) => act(async () => root.render(<DotsPromptSection key={key} value={append} onSaved={settings => { saved = settings; }} />));
  const systemInput = () => document.querySelector<HTMLTextAreaElement>("#dots-system-prompt")!;
  const restore = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label) as HTMLButtonElement;

  await load("default");
  const delivery = [...document.querySelectorAll(".dots-prompt-categories button")].find(button => button.textContent?.includes("回复与交付")) as HTMLButtonElement;
  assert(delivery, "settings offers a direct entry to 回复与交付");
  await act(async () => { delivery.click(); });
  assert.equal(systemInput().value, "在原对话回传结果");
  assert.equal(systemInput().hasAttribute("disabled"), false);
  assert.equal(restore("恢复本类默认").disabled, true);

  override = custom;
  await load("override");
  assert.equal(systemInput().value, "直接告诉我结果");
  assert.equal(restore("恢复分类默认").disabled, false);
  await act(async () => { restore("恢复分类默认").click(); });
  assert.equal(saved?.dotsPromptOverride, "");
  assert.equal(saved?.dotsPromptAppend, "先给结论");
  assert.match(document.body.textContent ?? "", /下一轮对话生效/);
  assert.equal(systemInput().value, "先判断能否当场作答");
  assert.deepEqual([...document.querySelectorAll(".dots-prompt-preview pre")].map(node => node.textContent), ["先判断能否当场作答", "在原对话回传结果", "先给结论"]);

  await act(async () => root.unmount());
  console.log("dots prompt section DOM ok: default, saved override, restore");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
