import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodemodeSandbox, loadQuickJSWasm, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { z } from "zod";
import { hookEvents, type HookDraft, type HookVersion, type NativeHookEvent, type NativeHookReceipt, type PublishedHook } from "../../../shared/native-hooks";
import type { NativePersistenceReply, RuntimeAuditReader } from "../../platform/runtime-audit";

const id = z.string().trim().min(1).max(256);
const feedback = z.string().trim().min(1).max(1500);
const draftSchema = z.object({
  title: id, event: z.enum(hookEvents), actor: z.enum(["all", "main", "subagent"]),
  tool: z.string().trim().max(256),
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("global") }).strict(),
    z.object({ kind: z.enum(["project", "workspace", "task"]), id }).strict()]),
  script: z.string().trim().min(1).max(16000),
  cases: z.array(z.object({ input: z.record(z.string(), z.json()), expected: z.union([z.literal(true), feedback]) })).min(1).max(12),
}).strict().refine(d => !d.tool || d.event === "beforeTool" || d.event === "afterTool", "只有工具事件可以指定工具名称");

/** Shared by Code Mode and hooks in both dev and unpacked Electron installations. */
export function durableSandboxAssets(directory?: string): Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> {
  const base = directory?.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
  if (!base) return {};
  const wasm = join(base, "quickjs.wasm"), worker = join(base, "codemode-worker.cjs");
  return existsSync(wasm) && existsSync(worker) ? { wasm: loadQuickJSWasm(wasm), workerUrl: pathToFileURL(worker) } : {};
}

export interface SelectedHook extends HookVersion { draft: HookDraft }
export interface HookScope { taskId: string; projectId?: string | null; spaceId?: string | null }
export interface HookFeedbackSource { task: string; conversation: string; generation: number }
export interface HookReadback { inputEntry: number; observed: "written" | "verified" }

interface HookImprovement {
  hook: PublishedHook | null;
  version: SelectedHook | null;
  triggers: number;
  errors: number;
  repaired: number;
  recurrences: number;
}

export type NativeHookQuery =
  | { kind: "list" }
  | { kind: "find" | "receipts"; id: string }
  | { kind: "candidates"; event: NativeHookEvent }
  | { kind: "toolCandidates"; tool: string }
  | { kind: "versions"; versions: readonly HookVersion[] }
  | { kind: "improvement"; id: string; revision: number; sources: readonly HookFeedbackSource[] }
  | { kind: "childReview"; taskId: string; conversationId: string }
  | { kind: "generationReceipts"; taskId: string; conversationId: string; taskIds: readonly number[] }
  | { kind: "nestedFeedback"; taskId: string; conversationId: string; parentTaskId: number }
  | { kind: "finishAttempts"; taskId: string; conversationId: string; runKey: string };

export type NativeHookMutation =
  | { kind: "publish"; id: string; expectedGeneration?: number; managed: boolean; draftJson: string }
  | { kind: "activate"; id: string; generation: number; revision: number; enabled: boolean }
  | { kind: "record"; receipt: NativeHookReceipt; runKey: string; parentTaskId?: number; readback?: HookReadback };

export class NativeHookStore {
  constructor(
    private readonly core: Pick<RuntimeAuditReader, "readNativeHooks" | "writeNativeHooks"> | undefined,
    private readonly assets: () => ReturnType<typeof durableSandboxAssets> = () => ({}),
  ) {}

  private async read<T>(query: NativeHookQuery, signal?: AbortSignal): Promise<T> {
    return this.unwrap(await this.core?.readNativeHooks<T>(query, signal));
  }

  private async write<T>(mutation: NativeHookMutation): Promise<T> {
    return this.unwrap(await this.core?.writeNativeHooks<T>(mutation));
  }

  private unwrap<T>(reply: NativePersistenceReply<T> | undefined): T {
    if (!reply) throw new Error("Core Hook 存储不可用");
    if (reply.status === "rejected") throw new Error(reply.message);
    return reply.data;
  }

  list(): Promise<PublishedHook[]> {
    return this.read({ kind: "list" });
  }

  candidates(event: NativeHookEvent, signal?: AbortSignal): Promise<SelectedHook[]> {
    return this.read({ kind: "candidates", event }, signal);
  }

  toolCandidates(tool: string, signal?: AbortSignal): Promise<SelectedHook[]> {
    return this.read({ kind: "toolCandidates", tool }, signal);
  }

  versions(versions: readonly HookVersion[], signal?: AbortSignal): Promise<SelectedHook[]> {
    return this.read({ kind: "versions", versions }, signal);
  }
  async check(draft: HookDraft, input: Record<string, unknown>, signal?: AbortSignal): Promise<true | string> {
    if (JSON.stringify(input).length > 512000) throw new Error("Hook 输入超过 512000 字符");
    const sandbox = new CodemodeSandbox({ ...this.assets(), timeoutMs: 3000, memoryLimitBytes: 16 * 1024 * 1024 });
    try {
      const result = await sandbox.execute('const event = load("event");\n' + draft.script, { store: { event: input }, signal });
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.error.message.slice(0, 1500));
      if (result.value === true) return true;
      const parsed = feedback.safeParse(result.value);
      if (!parsed.success) throw new Error("检查脚本必须返回 true 或 1 到 1500 字的处理说明");
      return parsed.data;
    } finally { await sandbox.close(); }
  }
  async publish(input: HookDraft, base?: { id: string; generation: number }): Promise<PublishedHook> {
    return this.publishVersion(input, base);
  }
  async installImprovement(input: HookDraft, key: string): Promise<PublishedHook> {
    if (!/^improvement-[a-f0-9]{64}$/.test(key)) throw new Error("无效的自动改进标识");
    return this.publishVersion(input, undefined, key);
  }
  private async publishVersion(input: HookDraft, base?: { id: string; generation: number }, managedKey?: string): Promise<PublishedHook> {
    const draft = draftSchema.parse(input);
    for (const [i, sample] of draft.cases.entries()) {
      const actual = await this.check(draft, { ...sample.input, event: draft.event, tool: draft.tool || sample.input.tool || "" });
      if (actual !== sample.expected) throw new Error(`用例 ${i + 1} 期望 ${JSON.stringify(sample.expected)}，实际 ${JSON.stringify(actual)}`);
    }
    return this.write({ kind: "publish", id: base?.id ?? managedKey ?? randomUUID(),
      expectedGeneration: base?.generation, managed: managedKey !== undefined, draftJson: JSON.stringify(draft) });
  }

  find(id: string): Promise<PublishedHook | null> {
    return this.read({ kind: "find", id });
  }

  improvement(id: string, revision: number, sources: readonly HookFeedbackSource[] = []): Promise<HookImprovement> {
    return this.read({ kind: "improvement", id, revision, sources });
  }

  childReviewReceipts(taskId: string, conversationId: string): Promise<(HookVersion & { executions: number })[]> {
    return this.read({ kind: "childReview", taskId, conversationId });
  }

  generationReceipts(taskId: string, conversationId: string, taskIds: readonly number[]):
    Promise<Omit<NativeHookReceipt, "taskId" | "conversationId" | "message">[]> {
    return this.read({ kind: "generationReceipts", taskId, conversationId, taskIds });
  }

  activate(id: string, generation: number, revision: number, enabled: boolean): Promise<PublishedHook> {
    return this.write({ kind: "activate", id, generation, revision, enabled });
  }

  async record(receipt: NativeHookReceipt, runKey: string, parentTaskId?: number, readback?: HookReadback): Promise<void> {
    await this.write<null>({ kind: "record", receipt, runKey, parentTaskId, readback });
  }

  nestedFeedback(taskId: string, conversationId: string, parentTaskId: number, signal?: AbortSignal): Promise<string> {
    return this.read({ kind: "nestedFeedback", taskId, conversationId, parentTaskId }, signal);
  }

  finishAttempts(taskId: string, conversationId: string, runKey: string, signal?: AbortSignal): Promise<number> {
    return this.read({ kind: "finishAttempts", taskId, conversationId, runKey }, signal);
  }

  receipts(id: string): Promise<NativeHookReceipt[]> {
    return this.read({ kind: "receipts", id });
  }
}
