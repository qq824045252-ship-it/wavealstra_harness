/**
 * overview-model-ui-fixture.tsx — Runtime Observatory「模型标识」UI 夹具。
 *
 * 真值来源与线上一致：主 Agent 用任务级 activeModelId + 目录名称；运行中子代理
 * 用 subagent.active() 返回的 resolvedModel/actualModel/modelSource；完成态子代理
 * 从工具结果的 Resolved model 证据行解析。这里只替换 IPC 数据，不改组件逻辑。
 */
import { createRoot } from "react-dom/client";
import RuntimeObservatory from "../src/renderer/src/components/artifact/overview/RuntimeObservatory";
import { state } from "./overview-model-store-stub";
import "../src/renderer/src/styles/global.css";

const now = Date.now();

const model = (id: string, name: string, vendor: string): any => ({
  id,
  name,
  vendor,
  supportsImages: true,
  supportsReasoning: true,
});

state.activeTaskId = "task-ui";
state.activeModelId = "deepseek/deepseek-v4.1-flash";
state.models = [
  model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "deepseek"),
  model("openai/gpt-5", "GPT-5", "openai"),
  model("anthropic/claude-opus-4", "Claude Opus 4", "anthropic"),
];

const subagent = (partial: Record<string, unknown>): any => ({
  role: "fixture",
  roleSource: "user",
  roleDescription: "",
  project: "C:/proj",
  status: "running",
  createdAt: now - 90_000,
  updatedAt: now - 5_000,
  lastPromptAt: now - 42_000,
  runCount: 1,
  steerCount: 0,
  pendingSteers: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  depth: 1,
  workerAlive: true,
  ...partial,
});

state.tasks = [
  {
    id: "task-ui",
    title: "检查账本",
    messages: [
      {
        id: "m-done",
        role: "assistant",
        blocks: [
          {
            type: "tool",
            toolCall: {
              id: "tc-done",
              tool: "subagent",
              summary: "subagent",
              status: "success",
              output: "\n> subagent: sa-ui-done\nResolved model: openai/gpt-5; thinking: high\n\n审查完成：未发现阻断问题",
            },
          },
        ],
      },
    ],
  },
];

(window as any).api = {
  subagent: {
    active: async () => [
      subagent({ subagentId: "sa-ui-1", role: "代码审查", resolvedModel: "openai/gpt-5", actualModel: "gpt-5", modelSource: "invocation", lastTask: "审查 auth 补丁" }),
      subagent({ subagentId: "sa-ui-2", role: "资料检索", resolvedModel: "anthropic/claude-opus-4", modelSource: "role", lastTask: "检索成对凭证规范" }),
      subagent({ subagentId: "sa-ui-3", role: "测试 runner", resolvedModel: "deepseek/deepseek-v4.1-flash", modelSource: "parent", lastTask: "跑 test:all" }),
    ],
    onEvent: () => () => {},
  },
  externalAgent: {
    active: async () => [],
    onEvent: () => () => {},
    cancel: async () => ({ ok: true }),
  },
};

const root = createRoot(document.getElementById("root")!);
root.render(
  <div style={{ width: 348, padding: 10, background: "var(--bg, #16181d)", minHeight: "100vh" }}>
    <RuntimeObservatory />
  </div>,
);
