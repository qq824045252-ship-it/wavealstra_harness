import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openDurableStorage, openDurablePassiveStorage } from "./DurableStorage";
import type { DurableStorageLease } from "./DurableStorageLease";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createDurableSubagentTools, resolveDurableExecutionCwd } from "./DurableSubagents";

export { VERSION };

/** Invoked only by the isolated package verifier; never reads real credentials or uses a network. */
export async function verifyPackagedDurable() {
  const directory = await mkdtemp(join(tmpdir(), "mybuddy-native-package-"));
  const agentDir = join(directory, "profile"), cwd = join(directory, "workspace");
  const savedProfile = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let harness: Harness | undefined;
  let lease: DurableStorageLease | undefined;
  let writes = 0;
  try {
    await mkdir(join(agentDir, "agents"), { recursive: true }); await mkdir(cwd);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["probe/parent", "probe/child"] }));
    await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Offline package probe\ntools: package_proof\n---\nWrite proof once.\n");
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("probe", { api: "openai-completions", apiKey: "offline", baseUrl: "http://127.0.0.1:1",
      models: ["parent", "child"].map(id => ({ id, name: id, reasoning: false, input: ["text"] satisfies Array<"text" | "image">, contextWindow: 16000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model, request) {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const done = request.messages.some(message => message.role === "toolResult");
          const content: AssistantMessage["content"] = done ? [{ type: "text", text: "verified" }]
            : model.id === "parent" ? [{ type: "toolCall", id: "delegate", name: "subagent", arguments: { agent: "worker", task: "Write proof", model: "probe/child", isolation: "shared" } }]
              : [{ type: "toolCall", id: "proof", name: "package_proof", arguments: {} }];
          const stopReason = done ? "stop" : "toolUse";
          const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "done", reason: stopReason, message }); stream.end();
        });
        return stream;
      },
    });
    const proof = defineTool({ name: "package_proof", description: "Write an isolated proof file", parameters: Type.Object({}), replay: "unsafe",
      execute: async () => { await writeFile(join(cwd, "proof.txt"), String(++writes)); return { output: [{ type: "text", text: "written" }] }; } });
    const open = async () => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: "package-probe", tools: [proof, ...createDurableSubagentTools({ taskId: "package-probe", cwd, models, permissionMode: () => "auto" })] }));
      lease?.release();
      const handle = await openDurableStorage(join(directory, "state"), context); lease = handle.lease;
      return Harness.open(handle.storage, { models, registry,
        env: async (target, ctx) => new NodeExecutionEnv({ cwd: await resolveDurableExecutionCwd(target, ctx, cwd) }) }, context);
    };
    harness = await open();
    let conversation = await harness.root(context, { agent: { cwd, model: { provider: "probe", modelId: "parent" } } });
    const receipt = await conversation.submit({ type: "input", content: "Run offline probe", requestId: "package-operation" }, context);
    assert.equal((await receipt.wait(context)).status, "done"); assert.equal(writes, 1);
    const children = await harness.commit(tx => tx.scanConversations({}, 100), context);
    assert.equal(children.items.filter(item => item.owner).length, 1);
    await harness.close(context); harness = await open(); conversation = await harness.root(context);
    const restored = await conversation.submit({ type: "input", content: "Run offline probe", requestId: "package-operation" }, context);
    assert.equal(restored.id, receipt.id); assert.equal((await restored.wait(context)).status, "done");
    assert.equal(writes, 1); assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "1");
    const passive = await openDurablePassiveStorage(join(directory, "state"), context);
    assert(passive); await passive.close(context);
    const selector = JSON.parse(await readFile(join(directory, "state", ".mybuddy-storage.json"), "utf8"));
    assert.equal(selector.backend, "sqlite");
    return { version: VERSION, runtime: "pi-durable", backend: "sqlite", ownedChild: true, recoveredReceipt: true, effectCount: writes };
  } finally {
    await harness?.close(context);
    lease?.release();
    if (savedProfile === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedProfile;
    await rm(directory, { recursive: true, force: true });
  }
}
