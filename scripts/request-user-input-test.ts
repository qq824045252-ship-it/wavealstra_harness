// The explicit tool waits for the user's actual answer; historical display parsing cannot wake a model turn.
import assert from "node:assert/strict";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import {
  extractRequestUserInputFallback,
  requestUserInputDisplayText,
} from "../src/shared/request-user-input-fallback";

const raw = [
  "前面的业务结论保持不变。",
  "",
  "<request_user_input>",
  JSON.stringify({
    title: "这 6 条被驳回的厂牌主料，走哪条路放行？",
    kind: "single_select",
    description: "请选择后续处理方式。",
    options: [
      { id: "fix-rule", label: "A. 修正规则并重建", recommended: true },
      { id: "reuse-master", label: "B. 复用现有主料" },
      { id: "handover", label: "C. 先停，交给 ERP 开发" },
    ],
  }),
  "</request_user_input>",
].join("\n");

const parsed = extractRequestUserInputFallback(raw);
assert.ok(parsed, "真实故障形态应被识别为 request_user_input fallback");
assert.equal(parsed.visibleText, "前面的业务结论保持不变。");
assert.equal(parsed.request.kind, "single_select");
assert.equal(parsed.request.options?.length, 3);
assert.equal(parsed.request.options?.[0]?.id, "fix-rule");
assert.equal(requestUserInputDisplayText(raw, false), "前面的业务结论保持不变。");

const partial = "正文\n<request_user_input>\n{\"title\":";
assert.equal(requestUserInputDisplayText(partial, true), "正文", "流式阶段不得把协议文本露到 Markdown");
assert.equal(requestUserInputDisplayText(partial, false), partial, "不完整协议在最终态不得静默吞掉");

const invalid = "正文\n<request_user_input>\nnot json\n</request_user_input>";
assert.equal(extractRequestUserInputFallback(invalid), undefined);
assert.equal(requestUserInputDisplayText(invalid, false), invalid, "非法 JSON 不得执行或隐藏");

let interactionRequest: unknown;
let releaseAnswer!: (answer: string) => void;
const answerPromise = new Promise<string>((resolve) => { releaseAnswer = resolve; });

const bridge = {
  resolveContext: () => ({ taskId: "task-a", executionId: "exec-a", assistantMessageId: "assistant-a" }),
  interaction: {
    request: async (_ctx: unknown, request: unknown) => {
      interactionRequest = request;
      return await answerPromise;
    },
  },
  goal: {},
} as any;

const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
const tools = new Map<string, any>();
const sent: Array<{ message: any; options: any }> = [];
const pi = {
  on(event: string, handler: (event: any, ctx?: any) => unknown) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => undefined;
  },
  registerTool(tool: any) { tools.set(tool.name, tool); },
  appendEntry() {},
  sendMessage(message: any, options: any) {
    sent.push({ message, options });
  },
} as any;

createConversationRuntimeExtension(bridge)(pi);
assert.equal(handlers.has("agent_end"), false, "historical text must not inject a recovered model turn");
const inputTool = tools.get("request_user_input");
assert.ok(inputTool, "explicit user input tool remains registered");
let settled = false;
const running = inputTool.execute("explicit-user-input", parsed.request, new AbortController().signal)
  .then((result: any) => { settled = true; return result; });

await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(interactionRequest, parsed.request, "真实工具请求进入正常 ConversationInteractionService");
assert.equal(settled, false, "工具必须等待实际用户回答");
assert.equal(sent.length, 0, "用户回答前不得自动续跑");

releaseAnswer("fix-rule");
const result = await running;
assert.equal(result.isError, undefined);
assert.equal(result.details.answer, "fix-rule");
assert.match(result.content[0].text, /fix-rule/);
assert.equal(sent.length, 0, "回答通过工具结果返回，不能注入隐藏 follow-up");

console.log("request_user_input explicit tool and historical text tests: ok");
