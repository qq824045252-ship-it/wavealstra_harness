import { resolve } from "node:path";
import { LiveDoc, type ConversationId, type EntryRecord, type HookApi, type Storage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { NativeImprovementService } from "../hooks/NativeImprovementService";
import { parseDeliveryContract } from "../hooks/DeliveryContract";
import { executeDeliveryTool } from "../hooks/DeliveryTool";
import { durableRegisteredArtifact } from "./DurableArtifactRegistration";
import { DurableSubagentIdentity } from "./DurableSubagentIdentity";
import { DurableConsultIdentity } from "./DurableConsultSession";
import { improvementInput, type DurableHookBinding } from "./DurableNativeHooks";

const memoKey = "mybuddy.weekly-improvement-plan";
const injectedKey = "mybuddy.weekly-improvement-injected";
type Api = HookApi;

export async function improvementOwnsConversation(storage: Pick<Storage, "conversation">, id: number, actor: number, ctx: Context): Promise<boolean> {
  const seen = new Set<number>();
  while (!seen.has(id)) {
    if (id === actor) return true;
    seen.add(id);
    const conversation = await storage.conversation(id as ConversationId, ctx);
    if (!conversation?.owner) return false;
    id = conversation.owner.conversationId;
  }
  return false;
}

export function improvementOracleDecision(result: { status: "passed" | "missing" | "unknown"; missing: string[] }, note: string):
  { event?: "falseTrigger" | "error"; note: string } {
  if (result.status === "passed" && note) return { event: "falseTrigger", note: "" };
  if (result.status === "missing" && !note) return { event: "error", note: `交付检查还缺少：${result.missing.join("、")}` };
  return { note };
}

/** Selection is pinned in the native generation task, including the empty plan. */
export class DurableImprovementRuntime {
  constructor(private readonly binding: DurableHookBinding, private readonly storage: Storage, private readonly service: NativeImprovementService) {}

  private async plan(api: Api, ctx: Context) {
    if ((await api.snapshot(DurableConsultIdentity, api.conversationId, ctx))?.key) return;
    const child = (await api.snapshot(DurableSubagentIdentity, api.conversationId, ctx))?.value;
    if (!child && (await this.storage.conversation(api.conversationId, ctx))?.owner) return;
    if (child && !child.item.tools.includes("read")) return;
    const scope = this.binding.scope();
    if (child && child.taskId !== scope.taskId) throw new Error("改进版本的子代理任务身份不匹配");
    const run = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run;
    if (!run) return;
    const submission = run.inputs.at(-1);
    const entry = submission === undefined ? run.first : (await this.storage.submission(submission, ctx))?.entry ?? run.first;
    if (entry === undefined) return;
    let pin = await api.memo<{ versions: { id: string; revision: number }[] }>(memoKey, ctx);
    if (!pin) {
      const selected = this.service.packages.select({ taskId: scope.taskId, projectId: scope.projectId ?? undefined, workspaceId: scope.spaceId ?? undefined });
      pin = await api.memo(memoKey, { versions: selected ? [{ id: selected.release.id, revision: selected.release.revision }] : [] }, ctx);
    }
    const packages = pin.versions.flatMap(v => {
      const found = this.service.packages.version(v.id, v.revision);
      if (!found?.release.enabled) return [];
      const expected = found.release.scope.kind === "task" ? scope.taskId : found.release.scope.kind === "project" ? scope.projectId : scope.spaceId;
      if (found.release.scope.id !== expected) return [];
      const knowledge = this.service.knowledge();
      const task = { taskId: scope.taskId, projectId: scope.projectId, workspaceId: scope.spaceId };
      if (!knowledge || !found.draft.knowledge.every(asset => knowledge.isCurrent(asset, task))) return [];
      return [found];
    });
    return { packages, scope, run, entry, cwd: child?.workspace.cwd ?? this.binding.cwd,
      parentInputs: child?.parentSubmissionIds, canRead: this.binding.toolAllowed?.("read") !== false && (!child || child.item.tools.includes("read")),
      actor: child ? "subagent" as const : "main" as const,
      conversation: String(api.conversationId), generation: Number(api.taskId) };
  }

  private record(plan: NonNullable<Awaited<ReturnType<DurableImprovementRuntime["plan"]>>>, id: string, revision: number,
    kind: "hook" | "tool" | "skill" | "convention" | "memory", event: string, detail?: string) {
    this.service.packages.record(id, revision, { task: plan.scope.taskId, conversation: plan.conversation, actor: plan.actor,
      run: String(plan.entry), generation: plan.generation, kind, event, ...(detail ? { detail } : {}) });
  }

  async beforeRequest(api: Api, ctx: Context): Promise<string> {
    const plan = await this.plan(api, ctx);
    if (!plan) return "";
    const input = await api.entry(plan.entry, ctx);
    if (!parseDeliveryContract(improvementInput(input))) return "";
    const notes: string[] = [];
    const injected: string[] = [];
    const knowledge = this.service.knowledge();
    for (const { release, draft } of plan.packages) {
      if (draft.convention) {
        notes.push(draft.convention);
        this.record(plan, release.id, release.revision, "convention", "applied");
      }
      if (draft.tool && plan.canRead) {
        notes.push("交付前将检查本轮明确要求的 Markdown 章节及附件。");
        this.record(plan, release.id, release.revision, "tool", "offered");
      }
      for (const asset of draft.knowledge) {
        const resolved = await knowledge?.resolve(asset, { taskId: plan.scope.taskId, projectId: plan.scope.projectId,
          workspaceId: plan.scope.spaceId, canUseSkill: (name: string) => plan.canRead && this.binding.skillAllowed?.(name) === true });
        if (!resolved) continue;
        injected.push(asset.version);
        if (resolved.kind === "skill") {
          notes.push(`技能 ${resolved.name}：\n${resolved.content}`);
          this.record(plan, release.id, release.revision, "skill", "read", resolved.path);
        } else {
          notes.push(`相关记忆：${resolved.title}\n${resolved.content}`);
          this.record(plan, release.id, release.revision, "memory", "recalled");
        }
      }
    }
    await api.memo(injectedKey, { assets: injected }, ctx);
    return notes.join("\n\n");
  }

  async beforeFinish(api: Api, ctx: Context): Promise<string> {
    const plan = await this.plan(api, ctx);
    if (!plan || !plan.cwd || !plan.canRead) return "";
    const entry = await api.entry(plan.entry, ctx);
    const contract = parseDeliveryContract(improvementInput(entry));
    if (!contract) return "";
    const messages: string[] = [];
    for (const { release, draft } of plan.packages) {
      if (!draft.contract) continue;
      this.record(plan, release.id, release.revision, "tool", "executed");
      let result = await executeDeliveryTool(draft.tool,plan.cwd,contract);
      if (result.status === "passed") {
        for (const path of [contract.document, ...contract.attachments]) {
          if (!await this.hasCurrentArtifact(api, ctx, plan.parentInputs ?? plan.run.inputs, plan.cwd, path, result.evidence[path])) {
            result = { status: "unknown", missing: [], evidence: result.evidence };
            break;
          }
        }
      }
      this.record(plan, release.id, release.revision, "tool", result.status);
      let note: string;
      try { note = await this.service.packages.runHook(draft, result); }
      catch (error) {
        ctx.abortSignal?.throwIfAborted();
        this.service.packages.regression(release.id,release.revision,result,{task:plan.scope.taskId,conversation:plan.conversation,
          actor:plan.actor,run:String(plan.entry),generation:plan.generation,kind:"hook",event:"error",detail:String(error).slice(0,500)});
        throw error;
      }
      const decision = improvementOracleDecision(result, note);
      if (decision.event) {
        this.service.packages.regression(release.id,release.revision,result,{task:plan.scope.taskId,conversation:plan.conversation,
          actor:plan.actor,run:String(plan.entry),generation:plan.generation,kind:"hook",event:decision.event});
        if (decision.note) messages.push(decision.note);
        continue;
      }
      this.record(plan, release.id, release.revision, "hook", note ? "feedback" : result.status === "passed" ? "passed" : "unknown");
      if (note) messages.push(note);
    }
    return messages.join("\n");
  }

  async beforeProviderRequest(api: Api, ctx: Context): Promise<void> {
    const plan = await this.plan(api, ctx);
    if (!plan || !parseDeliveryContract(improvementInput(await api.entry(plan.entry, ctx)))) return;
    const knowledge = this.service.knowledge();
    const injected = await api.memo<{ assets: string[] }>(injectedKey, ctx);
    if (!injected) return;
    const pinned = await api.memo<{ versions: { id: string; revision: number }[] }>(memoKey, ctx);
    if ((pinned?.versions.length ?? 0) !== plan.packages.length) throw new Error("本轮改进版本已撤回或作用域已变化，请重新开始");
    for (const { draft } of plan.packages) for (const asset of draft.knowledge) {
      if (!injected.assets.includes(asset.version)) continue;
      const task = { taskId: plan.scope.taskId, projectId: plan.scope.projectId, workspaceId: plan.scope.spaceId };
      if (!knowledge?.isCurrent(asset, task)) throw new Error("改进资产来源已变化，请重新开始本轮");
      if (asset.kind === "skill" && (!plan.canRead || this.binding.skillAllowed?.(asset.name) !== true))
        throw new Error("改进技能权限已变化，请重新开始本轮");
      if (!await knowledge.resolve(asset, { ...task, canUseSkill: name => plan.canRead && this.binding.skillAllowed?.(name) === true }))
        throw new Error("改进资产文件已变化，请重新开始本轮");
    }
  }

  private async hasCurrentArtifact(api: Api, ctx: Context, inputs: readonly number[], cwd: string, path: string, digest?: string): Promise<boolean> {
    if (!digest || !this.binding.directory) return false;
    let owner = api.conversationId;
    const seen = new Set<number>();
    while (!seen.has(owner)) {
      seen.add(owner);
      const conversation = await this.storage.conversation(owner, ctx);
      if (!conversation) return false;
      if (!conversation.owner) break;
      owner = conversation.owner.conversationId;
    }
    const expected = resolve(cwd, path);
    let cursor: Parameters<Storage["scanEntries"]>[2];
    do {
      const page = await this.storage.scanEntries({ conversationId: owner, order: "descending" }, 100, cursor, ctx);
      for (const entry of page.items as EntryRecord[]) for (const input of inputs) {
        const receipt = durableRegisteredArtifact(entry, input, cwd, this.binding.directory);
        if (receipt?.path === expected && await improvementOwnsConversation(this.storage, receipt.toolConversationId, api.conversationId, ctx)) return receipt.digest === digest;
      }
      cursor = page.next;
    } while (cursor);
    return false;
  }

}
