import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableBotRuntime, type DurableBotOptions } from "./DurableBotRuntime";
import { DEFAULT_PRODUCT_COMPACTION_SETTINGS } from "./context/CompactionPolicy";

const bindingSchema = z.object({
  id: z.string().min(1), kind: z.enum(["btw", "prompt-enhance", "authoring"]),
  parentTaskId: z.string().optional(), parentCwd: z.string().optional(), projectId: z.string().optional(), workspaceId: z.string().optional(),
  cwd: z.string().min(1), instructions: z.string(), snapshot: z.string().optional(), input: z.string().optional(),
  model: z.object({ provider: z.string(), modelId: z.string() }),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  deadline: z.number().optional(),
});
export type DurableAuxiliaryBinding = z.infer<typeof bindingSchema>;

export async function openDurableAuxiliary(options: {
  agentDir: string; id: string; models: Models;
  initialize: () => Promise<DurableAuxiliaryBinding>;
  runtime: (binding: DurableAuxiliaryBinding) => Promise<Pick<DurableBotOptions,
    "tools" | "toolAllowed" | "toolHooks" | "evidenceProjection" | "contextHooks" | "contextManagement" | "onSnapshot" | "onEntries" | "onRequest" | "onResponse" | "onTool">>;
}): Promise<{ runtime: DurableBotRuntime; binding: DurableAuxiliaryBinding }> {
  const directory = join(options.agentDir, "durable-auxiliary", createHash("sha256").update(options.id).digest("hex"));
  const path = join(directory, "binding.json");
  let binding: DurableAuxiliaryBinding;
  try { binding = bindingSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const proposed = bindingSchema.parse(await options.initialize());
    if (proposed.id !== options.id) throw new Error("辅助会话身份不一致");
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `binding-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(proposed), { flag: "wx", flush: true });
      try { await link(temporary, path); binding = proposed; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        binding = bindingSchema.parse(JSON.parse(await readFile(path, "utf8")));
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  if (binding.id !== options.id) throw new Error("辅助会话身份不一致");
  const provided = await options.runtime(binding);
  const runtime = await DurableBotRuntime.open({ ...provided, directory: join(directory, "session"),
    // 辅助会话没有独立设置页：调用方给了 contextManagement 就用调用方的，
    // 否则跟随产品默认阈值（0.8 / 200K）。
    contextManagement: provided.contextManagement ?? { policy: () => DEFAULT_PRODUCT_COMPACTION_SETTINGS },
    cwd: binding.cwd, models: options.models, model: binding.model, taskId: binding.parentTaskId ?? binding.id,
    executionIdentity: { taskId: binding.parentTaskId, sourceKind: "auxiliary", executionScope: `${binding.kind}:${binding.id}` },
    toolMode: "native", instructions: () => binding.instructions });
  try {
    const agent = await runtime.conversation.agent(BACKGROUND_CONTEXT);
    if (binding.thinking && agent.thinkingLevel !== binding.thinking) {
      await runtime.configure(undefined, "native", binding.thinking);
    }
    return { runtime, binding };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
