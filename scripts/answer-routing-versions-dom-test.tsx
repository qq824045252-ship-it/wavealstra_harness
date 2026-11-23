/**
 * 设置里的版本历史面板：列表、当前版标记、恢复、备注、两版对比、记忆绑定规则只读。
 * 只渲染组件，不启动应用。
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import type { AnswerRule, AnswerRuleVersion } from "../src/shared/answer-routing";
import AnswerRoutingVersions from "../src/renderer/src/components/answer-routing/AnswerRoutingVersions";

const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const history: AnswerRuleVersion[] = [
  { ruleId: "dots-default-policy", revision: 3, at: 1_700_000_000_000, source: "restore", title: "默认调度策略",
    note: "", uses: 2, changes: ["读取上限 8000 字/2 来源/2 次 → 24000 字/4 来源/6 次"], summary: "自动 · 无流程" },
  { ruleId: "dots-default-policy", revision: 2, at: 1_699_000_000_000, source: "save", title: "默认调度策略",
    note: "对接客户 A", uses: 0, changes: ["读取上限 24000 字/4 来源/6 次 → 8000 字/2 来源/2 次"], summary: "自动 · 无流程" },
  { ruleId: "dots-default-policy", revision: 1, at: 1_698_000_000_000, source: "baseline", title: "默认调度策略",
    note: "", uses: 0, changes: ["开始记录这一版"], summary: "自动 · 无流程" },
];
const restored: number[] = [];
const compared: Array<[number, number]> = [];
let loads = 0;
(window as unknown as { api: unknown }).api = {
  answerRouting: {
    versions: async () => { loads += 1; return history; },
    restore: async (_id: string, revision: number) => { restored.push(revision); return { id: "dots-default-policy", revision: 4 } as AnswerRule; },
    annotate: async () => undefined,
    compare: async (_id: string, from: number, to: number) => {
      compared.push([from, to]);
      return { ruleId: "dots-default-policy", from, to,
        entries: [{ label: "前台读取上限", before: "24000 字/4 来源/6 次", after: "8000 字/2 来源/2 次" }] };
    },
  },
};

async function main() {
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let saved: AnswerRule | undefined;
  const render = (memoryBound?: boolean) => root.render(<AnswerRoutingVersions ruleId="dots-default-policy"
    currentRevision={3} memoryBound={memoryBound} onRestored={rule => { saved = rule; }} />);

  await act(async () => render());
  assert.match(document.body.textContent ?? "", /最多保留最近 50 版/);
  const rows = [...document.querySelectorAll(".answer-rule-version")];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent ?? "", /第 3 版/);
  assert.match(rows[0].textContent ?? "", /当前版本/);
  assert.match(rows[0].textContent ?? "", /2 轮对话用过/);
  assert.match(rows[1].textContent ?? "", /备注：对接客户 A/);
  assert.equal((rows[0].querySelector("button") as HTMLButtonElement).disabled, true, "当前版不能恢复到自身");

  // 两版对比：默认旧版是最早版本、新版是当前版本。
  const compareButton = [...document.querySelectorAll("button")].find(button => button.textContent === "对比两版")!;
  await act(async () => { compareButton.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(compared, [[1, 3]]);
  const table = document.querySelector(".answer-rule-diff table");
  assert.ok(table, "对比结果出现在页面上");
  assert.match(table.textContent ?? "", /前台读取上限/);
  assert.match(table.textContent ?? "", /24000 字\/4 来源\/6 次/);
  assert.match(table.textContent ?? "", /8000 字\/2 来源\/2 次/);

  const second = rows[1].querySelector("button") as HTMLButtonElement;
  assert.equal(second.disabled, false);
  await act(async () => { second.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(restored, [2]);
  assert.equal(saved?.revision, 4);
  assert.equal(loads, 2, "恢复后重新读取版本列表");

  await act(async () => render(true));
  const buttons = [...document.querySelectorAll(".answer-rule-version button")] as HTMLButtonElement[];
  assert(buttons.length === 6 && buttons.filter(button => button.textContent?.includes("恢复")).every(button => button.disabled),
    "记忆来源的规则不能单独回退");
  assert.match(document.body.textContent ?? "", /只能在记忆里修改/);

  await act(async () => root.unmount());
  console.log("answer-routing versions DOM ok: list, note, uses, compare, restore, memory-bound");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
