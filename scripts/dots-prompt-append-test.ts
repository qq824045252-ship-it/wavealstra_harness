import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { withDurableExecution } from "../src/main/agent/durable/DurableExecutionContext";
import type { DotsActions } from "../src/main/dots/DotsActions";
import { assembleDotsPrompt, dotsExtension } from "../src/main/dots/DotsExtension";
import { normalizeDotsSettings } from "../src/shared/dots-settings";

const plain = assembleDotsPrompt("readWrite", "", "");
assert.deepEqual(plain.map(segment => segment.title), [
  "身份与办事范围", "查资料与文件", "记忆与偏好", "交办与跟进", "回复与交付", "通用回复规范", "常驻工具调用", "Dots 默认回复结构",
]);
assert.deepEqual(assembleDotsPrompt("readWrite", " \n ", "   \n "), plain, "空白沿用默认，并省略追加段");
const edited = assembleDotsPrompt("readWrite", "", "", { delivery: "  在原对话只交付一个文件。 " });
assert.equal(edited[4].content, "在原对话只交付一个文件。");
assert.equal(edited[4].source, "user");
assert.deepEqual(edited.slice(0, 4), plain.slice(0, 4));
assert.deepEqual(edited.slice(5), plain.slice(5));
assert.deepEqual(assembleDotsPrompt("readWrite", "", "", { delivery: " \n " }), plain);

const prompt = assembleDotsPrompt("readOnly", "  你是仓库值班助理。\n", "  先给结论。\n数字注明来源。\n");
assert.deepEqual(prompt.map(segment => segment.source), ["user", "runtime", "seed", "runtime", "seed", "user"]);
assert.equal(prompt[0].content, "你是仓库值班助理。");
assert.match(prompt[1].content, /只读/);
const append = prompt.at(-1)!;
assert.match(append.content, /\n先给结论。\n数字注明来源。$/);
assert.equal(append.chars, append.content.length);
assert.match(assembleDotsPrompt("off", "", "").find(segment => segment.id === "dotsMemoryMode")?.content ?? "", /已关闭/);

type RegistrationApi = Parameters<ReturnType<typeof dotsExtension>>[0];
function getDotsTool(settings = normalizeDotsSettings({})) {
  let registered: ToolDefinition | undefined;
  const handler = dotsExtension({} as DotsActions, () => settings);
  handler({ registerTool(tool: ToolDefinition) { registered = tool; } } as RegistrationApi);
  assert(registered);
  return registered;
}

const tool = getDotsTool();
assert(Value.Check(tool.parameters, { action: "find_tasks", query: "报价核对" }));
assert(Value.Check(tool.parameters, { action: "task", targetTaskId: "original-task", detail: "history", beforeEntryId: 42 }));
assert(Value.Check(tool.parameters, { action: "task", targetTaskId: "original-task", detail: "execution", offset: 10 }));
assert(!Value.Check(tool.parameters, { action: "board", query: "报价核对" }));
assert(!Value.Check(tool.parameters, { action: "task", view: "completed" }));
assert.match(tool.description, /确认任务 ID，就直接用 task/);
assert.match(tool.description, /搜索|find_tasks/);
assert.match(tool.description, /inspection/);

const legacy = normalizeDotsSettings({ operations: { board: false } });
assert.deepEqual(legacy.operations, { find_tasks: false });
assert(!Value.Check(getDotsTool(legacy).parameters, { action: "find_tasks", query: "报价核对" }));
assert(Value.Check(getDotsTool(legacy).parameters, { action: "task", targetTaskId: "original-task" }));
assert.deepEqual(normalizeDotsSettings({ operations: { board: false, find_tasks: true } }).operations, { find_tasks: true });
assert.deepEqual(normalizeDotsSettings({ operations: "invalid" }).operations, {});

const invocation = {
  execution: { taskId: "mybuddy-dots", executionId: "stale-board-tool", assistantMessageId: "fixture" },
  context: {}, native: {}, cwd: "", runId: "fixture",
} as Parameters<typeof withDurableExecution>[0];
await assert.rejects(withDurableExecution(invocation, () =>
  tool.execute("stale-board-tool", { action: "board" }, undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4])),
  /Dots 操作不可用/);

console.log("dots prompt append ok");
