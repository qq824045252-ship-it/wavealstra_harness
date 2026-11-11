import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { durableToolDiagnosticMessages } from "../src/main/agent/durable/DurableToolDiagnostics";
import type { ToolDiagnosticEvent } from "../src/shared/task-diagnostics";

const failures = [
  { content: [{ type: "text", text: "[browser_exec] 浏览器导航失败" }], isError: true,
    details: { code: "NAVIGATION_FAILED", error: "浏览器导航失败：http://127.0.0.1:50878/?token=secret",
      details: { cause: "ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:50878/?token=secret'", unrelated: "DO_NOT_COPY" } } },
  { content: [{ type: "text", text: "DO_NOT_COPY" }], isError: true,
    diagnostics: [{ severity: "error", code: "SURFACE_CHANGED", message: "页面已变化，请重新观察" }], details: { unrelated: "DO_NOT_COPY" } },
  { content: [{ type: "text", text: "DO_NOT_COPY" }], isError: true, details: { unrelated: "DO_NOT_COPY" } },
  { content: [{ type: "text", text: "success" }], isError: false, details: { error: "stale field" } },
];
for (const mode of ["native", "codemode"] as const) {
  const cwd = await mkdtemp(join(tmpdir(), "mybuddy-tool-diagnostics-"));
  let turn = 0;
  const events: ToolDiagnosticEvent[] = [];
  const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models: any = { getAuth: async () => undefined, getModel: () => model, streamSimple: () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const index = turn++;
      const content = index < failures.length ? [{ type: "toolCall", id: `call-${index}`, name: mode === "native" ? "browser_exec" : "codemode",
        arguments: mode === "native" ? { index } : { code: `const result = await tools.browser_exec({index:${index}}); text(result);` } }]
        : [{ type: "text", text: "done" }];
      const stopReason = index < failures.length ? "toolUse" : "stop";
      const message: any = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message }); stream.end();
    });
    return stream;
  } };
  // The real extension bridge is part of this regression: testing only native tools
  // would miss the adapter silently dropping extension diagnostics.
  const domain = await durableDomainTools([api => api.registerTool({ name: "browser_exec", label: "Browser", description: "fixture",
    parameters: Type.Object({ index: Type.Number() }), execute: async (_id, args) => failures[args.index] as any })]);
  const runtime = await DurableBotRuntime.open({ cwd, directory: join(cwd, "state"), model: { provider: "fixture", modelId: "fixture" },
    models, toolMode: mode, tools: domain.tools, instructions: () => "fixture", onSnapshot: () => {}, onTool: event => events.push(event) });
  try {
    const submission = await runtime.submit("run fixtures", "diagnostic-request");
    assert.equal((await submission.wait(ctx)).status, "done");
    await runtime.conversation.waitForIdle(ctx);
    const finished = events.filter(event => event.phase === "finish" && event.name === "browser_exec");
    assert.equal(finished.length, failures.length);
    assert.match(finished[0].diagnostics!.join(" "), /NAVIGATION_FAILED.*浏览器导航失败.*ERR_CONNECTION_REFUSED/);
    assert.equal(finished[1].diagnostics![0], "SURFACE_CHANGED: 页面已变化，请重新观察");
    assert.match(finished[2].diagnostics![0], /工具执行失败/);
    assert.equal(finished[3].diagnostics, undefined);
    assert(!JSON.stringify(finished).includes("secret"));
    assert(!JSON.stringify(finished).includes("DO_NOT_COPY"));
  } finally { await runtime.close(); }
  console.log("PASS", mode, "extension → durable runtime → diagnostic observer");
}
const bounded = durableToolDiagnosticMessages({ isError: true, details: { error: "x".repeat(20000) } })!;
assert(bounded[0].length <= 1200);
const redacted = durableToolDiagnosticMessages({ isError: true, details: { error: "https://user:password@example.com/error?token=value#secret Bearer credential token=other" } })!.join(" ");
assert(!/password|credential|value|other|user:/.test(redacted));
console.log("PASS bounded explicit fields and credential redaction");

for (const code of ["exit_code", "image", "truncated", "full_output"]) {
  assert.deepEqual(durableToolDiagnosticMessages({ isError: code === "exit_code", diagnostics: [{ severity: "info", code, message: "descriptive text" }] }), [code], "retain renderer classification for " + code);
}
