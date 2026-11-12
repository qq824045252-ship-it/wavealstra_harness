import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";

const root = await mkdtemp(join(tmpdir(), "browser-durable-contract-"));
const calls: string[] = [];
const bridge = await durableDomainTools([api => {
  api.registerTool({ name: "browser_exec", label: "Browser boundary fixture", description: "Structured host outcomes", parameters: Type.Object({ action: Type.String(), text: Type.String() }),
    execute: async (_id, args) => {
      calls.push(args.text);
      const failed = args.text === "3";
      const details = failed ? { error: "target replaced", code: "SURFACE_CHANGED", details: { outcome: { dispatch: "not_started", effect: "none" } } }
        : { action: "fill", text: args.text, outcome: { dispatch: "dispatched", effect: "confirmed" }, observation: { status: "completed", result: { text: "accepted" } } };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: failed };
    } });
}]);
if (process.env.BROWSER_CONTRACT_MISSING_SCHEMA === "1") bridge.tools = bridge.tools.map(({ structuredOutputSchema: _missing, ...tool }) => tool);
const model = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
let generations = 0;
model.registerProvider("fixture", { api: "openai-completions", apiKey: "isolated", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "model", name: "contract", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model, request) => {
    generations++;
    const previous = request.messages.at(-1);
    let content: AssistantMessage["content"];
    if (previous?.role !== "toolResult") content = [{ type: "toolCall", id: "compose", name: "codemode", arguments: { code: `const completed=[];let failedStep;for(let i=1;i<=4;i++){const r=await tools.browser_exec({action:'fill',text:String(i)});if(r.isError){if(r.outcome.dispatch!=='not_started')throw Error('lost dispatch state');failedStep=i;break;}if(r.observation.status!=='completed'||r.outcome.effect!=='confirmed')throw Error('lost confirmed result');completed.push(r.text);}text({completed,failedStep});` } }];
    else {
      assert.equal(previous.isError, false, "Pi must accept the declared structured output, including after-observation results");
      const output = previous.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.match(output, /"completed"\s*:\s*\[\s*"1"\s*,\s*"2"\s*\]/);
      assert.match(output, /"failedStep"\s*:\s*3/);
      content = [{ type: "text", text: "verified partial execution" }];
    }
    const stream = createAssistantMessageEventStream();
    const reason = content.some(item => item.type === "toolCall") ? "toolUse" : "stop";
    queueMicrotask(() => { stream.push({ type: "done", reason, message: { role: "assistant", content, stopReason: reason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end(); });
    return stream;
  } });
const open = () => DurableBotRuntime.open({ taskId: "browser-contract", cwd: root, directory: join(root, "state"), models: model, model: { provider: "fixture", modelId: "model" }, toolMode: "codemode", tools: bridge.tools, instructions: () => "boundary contract fixture", onSnapshot: () => {} });
await mkdir(join(root, "state"));
let runtime = await open();
try {
  assert.equal((await (await runtime.submit("run", "stable-input")).wait(context)).status, "done");
  assert.deepEqual(calls, ["1", "2", "3"]);
  assert.equal(generations, 2);
  await runtime.close(); runtime = await open();
  assert.equal((await (await runtime.submit("run", "stable-input")).wait(context)).status, "done");
  assert.deepEqual(calls, ["1", "2", "3"], "reopening the same native input must not replay completed nested browser actions");
  console.log("browser Durable composition: PASS (real Pi schema validation, two retained successes, third failure, fourth absent, native journal reopen)");
} finally { await runtime.close(); }
