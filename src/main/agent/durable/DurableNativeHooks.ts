import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { LiveDoc, type EntryRecord, type HookApi, type Storage, type ToolExecutionResult, type ToolHookCall, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HookActor, NativeHookEvent, NativeHookReceipt } from "../../../shared/native-hooks";
import type { HookScope, NativeHookStore, SelectedHook } from "../hooks/NativeHookStore";
import { lookupFileName } from "../hooks/ReadRecoveryHints";
import { nestedReadbackTools, readbackState, repeatedReadFailure, reportsBlocker, requestFeatures, type ReadbackTool } from "../hooks/ImprovementDecisions";
import { DurableConsultIdentity } from "./DurableConsultSession";
import { durableContentText } from "./DurableHistoryProjection";
import { durableMcpToolName } from "./DurableMcp";
import { DurableSubagentIdentity } from "./DurableSubagentIdentity";
import { TOOL_NOT_STARTED_MEMO } from "./DurableToolOutcome";
import { DurableImprovementRuntime, improvementInput } from "./DurableImprovementRuntime";
import { matchingNativeExecutionReceipt, nativeExecutionSucceeded, nativeFileVersion } from "../../../shared/native-execution-receipt";

export interface DurableHookBinding { store: NativeHookStore; scope: () => HookScope; cwd?: string; directory?: string; readHints?: import("../hooks/ReadRecoveryHints").ReadRecoveryHints;
  improvement?: import("../hooks/NativeImprovementService").NativeImprovementService; skillAllowed?: (name: string) => boolean; toolAllowed?: (name: string) => boolean }
type Api = Pick<HookApi, "taskId" | "conversationId" | "snapshot" | "memo">;
type Selection = { actor: HookActor; role: string; taskId: string; hooks: SelectedHook[] };
const toolPlan = "mybuddy.native-hook-tool-plan";
type PinnedPlan = { actor: HookActor; role: string; taskId: string; versions: { id: string; revision: number }[] };

function toolIdentity(name: string, args: unknown) {
  if (name === "mcp_call_tool" && args && typeof args === "object" && "server" in args && typeof args.server === "string"
    && "tool" in args && typeof args.tool === "string" && "arguments" in args)
    return { name: durableMcpToolName(args.server, args.tool), args: args.arguments };
  return { name, args };
}

function finishToolEvidence(entries: EntryRecord[]) {
  const paths = new Map<string, string>();
  const results: Array<ReadbackTool & { entryId: number; callId: string; text: string; textTruncated: boolean }> = [];
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (message.role === "assistant") for (const item of message.content) {
      if (item.type === "toolCall" && typeof item.arguments.path === "string") paths.set(item.id, item.arguments.path);
    }
    if (message.role !== "toolResult") continue;
    const identity = { conversationId: entry.conversationId, toolTaskId: entry.byTaskId, toolName: message.toolName, callId: message.toolCallId };
    const receipt = matchingNativeExecutionReceipt(message, identity);
    const requestedPath = paths.get(message.toolCallId);
    paths.delete(message.toolCallId);
    // Pi appends one rendered diagnostics block after the actual tool content.
    const data = entry.data;
    const diagnostics = data && typeof data === "object" && !Array.isArray(data) ? data.diagnostics : undefined;
    const output = Array.isArray(diagnostics) && diagnostics.length ? message.content.slice(0, -1) : message.content;
    const text = durableContentText(output);
    results.push({ entryId: entry.id, tool: message.toolName, callId: message.toolCallId, requestedPath,
      path: receipt?.fileReadAttempt?.target ?? receipt?.fileChange?.target ?? requestedPath,
      version: nativeFileVersion(receipt),
      isError: !nativeExecutionSucceeded(message, identity), text: text.slice(0, 4000), textTruncated: text.length > 4000 || (Array.isArray(diagnostics)
        && diagnostics.some(d => d && typeof d === "object" && !Array.isArray(d) && d.code === "truncated")) });
  }
  return results;
}

export class DurableNativeHooks {
  private readonly continuations = new WeakMap<AssistantMessage, string>();
  private readonly improvement?: DurableImprovementRuntime;
  private readonly improvementAttempts = new Map<string, number>();
  constructor(private readonly binding: DurableHookBinding, private readonly storage: Storage) {
    if (binding.improvement) this.improvement = new DurableImprovementRuntime(binding, storage, binding.improvement);
  }

  private async select(candidates: SelectedHook[], api: Api, ctx: Context): Promise<Selection | undefined> {
    if (!candidates.length) return;
    const child = (await api.snapshot(DurableSubagentIdentity, api.conversationId, ctx))?.value;
    if (!child && (await api.snapshot(DurableConsultIdentity, api.conversationId, ctx))?.key) return;
    const scope = this.binding.scope();
    if (child && child.taskId !== scope.taskId) throw new Error("Hook 子代理身份与任务不匹配");
    const actor = child ? "subagent" : "main";
    const hooks = candidates.filter(({ draft }) => {
      const s = draft.scope;
      return (draft.actor === "all" || draft.actor === actor) && (s.kind === "global"
        || s.id === (s.kind === "project" ? scope.projectId : s.kind === "workspace" ? scope.spaceId : scope.taskId));
    });
    if (hooks.length) return { actor, role: child?.item.agentName ?? "", taskId: scope.taskId, hooks };
  }
  private async evaluate(selection: Selection, event: NativeHookEvent, api: Api, ctx: Context,
    fields: Record<string, unknown>, tool = "", callId = "", runKey = "", parentTaskId?: number): Promise<string> {
    const messages: string[] = [];
    for (const { id, revision, draft } of selection.hooks) {
      if (draft.event !== event) continue;
      const identity = { event, tool, callId, actor: selection.actor, role: selection.role, taskId: selection.taskId,
        conversationId: String(api.conversationId), nativeTaskId: Number(api.taskId) };
      let result: true | string, outcome: NativeHookReceipt["outcome"];
      try {
        result = await this.binding.store.check(draft, { ...fields, ...identity }, ctx.abortSignal);
        outcome = result === true ? "pass" : "feedback";
      } catch (error) {
        ctx.abortSignal?.throwIfAborted();
        result = "检查运行失败：" + String(error instanceof Error ? error.message : error).slice(0, 1500);
        outcome = "error";
      }
      this.binding.store.record({ ...identity, id, revision, outcome, at: Date.now(), message: result === true ? "" : result }, runKey, parentTaskId);
      if (id.startsWith("improvement-") && event === "beforeFinish" && typeof fields.inputEntry === "number" &&
        (outcome === "pass" && fields.readback === "verified" || outcome === "feedback" && fields.readback === "written"))
        this.binding.store.recordReadback(id, revision, selection.taskId, identity.conversationId, runKey, fields.inputEntry, fields.readback);
      if (result !== true) messages.push(`[Hook · ${draft.title} v${revision}] ${result}`);
    }
    return messages.join("\n");
  }
  private restore(plan: PinnedPlan): Selection {
    return { ...plan, hooks: plan.versions.map(v => this.binding.store.version(v.id, v.revision)) };
  }

  wrap(tool: ToolRegistration): ToolRegistration {
    return { ...tool, execute: async (args, api, ctx) => {
      const target = toolIdentity(tool.name, args);
      try {
        if (this.binding.store.hasToolVersions()) {
          let plan = await api.memo<PinnedPlan>(toolPlan, ctx);
          if (!plan) {
            const candidates = [...this.binding.store.candidates("beforeTool", target.name), ...this.binding.store.candidates("afterTool", target.name)];
            const selected = await this.select(candidates, api, ctx);
            if (selected) plan = await api.memo(toolPlan, { actor: selected.actor, role: selected.role, taskId: selected.taskId,
              versions: selected.hooks.map(({ id, revision }) => ({ id, revision })) }, ctx);
          }
          if (plan) {
            const blocked = await this.evaluate(this.restore(plan), "beforeTool", api, ctx, { args: target.args }, target.name, api.callId);
            if (blocked) throw new Error(blocked);
          }
          ctx.abortSignal?.throwIfAborted();
        }
      } catch (error) {
        const proofContext = withoutAbortSignal(ctx);
        const task = await this.storage.task(api.taskId, proofContext);
        // A blocked replay says nothing about how far the previous execution got.
        if (task && !task.restarts) await api.memo(TOOL_NOT_STARTED_MEMO, { toolName: target.name, callId: api.callId,
          taskId: api.taskId, conversationId: api.conversationId, phase: "validation" }, proofContext);
        throw error;
      }
      return tool.execute(args, api, ctx);
    } };
  }
  private async readAdvice(call: ToolHookCall, result: ToolExecutionResult, api: HookApi, ctx: Context) {
    const { readHints, cwd } = this.binding;
    if (!readHints || !cwd || call.name !== "read" || typeof call.arguments.path !== "string") return;
    try {
      const task = this.binding.scope().taskId;
      if (!readHints.has(task, cwd) || (await api.snapshot(DurableSubagentIdentity, api.conversationId, ctx))?.value
        || (await api.snapshot(DurableConsultIdentity, api.conversationId, ctx))?.key) return;
      const live = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run;
      if (live?.first === undefined) return;
      const error = result.isError ? [durableContentText(result.output), ...(result.diagnostics ?? []).map(d => d.message)].join("\n") : "";
      return await readHints.observe(task, cwd, call.arguments.path, Boolean(result.isError), error,
        String(api.conversationId), JSON.stringify([live.first, live.inputs.at(-1)]), call.id);
    } catch (e) { ctx.abortSignal?.throwIfAborted(); console.warn("[NativeImprovement] File hint unavailable", e); }
  }
  async afterTool(call: ToolHookCall, result: ToolExecutionResult, api: HookApi, ctx: Context): Promise<ToolExecutionResult | undefined> {
    const advice = await this.readAdvice(call, result, api, ctx);
    const advised: ToolExecutionResult | undefined = advice ? { ...result, diagnostics: [...result.diagnostics ?? [], { severity: "info", code: "verified_read_path", message: advice }] } : undefined;
    if (!this.binding.store.hasToolVersions()) return advised;
    const plan = await api.memo<PinnedPlan>(toolPlan, ctx);
    if (await api.memo(TOOL_NOT_STARTED_MEMO, ctx)) return advised;
    const target = toolIdentity(call.name, call.arguments);
    const own = plan && await this.evaluate(this.restore(plan), "afterTool", api, ctx, {
      args: target.args, result: { isError: Boolean(result.isError), text: durableContentText(result.output).slice(0, 16000), diagnostics: result.diagnostics ?? [] },
    }, target.name, call.id, "", call.parent?.taskId);
    // Nested output is a program's return value. Attach feedback to the containing Code Mode call, including after replay.
    const nested = call.name === "codemode" && this.binding.store.nestedFeedback(this.binding.scope().taskId, String(api.conversationId), api.taskId);
    const note = [own, nested].filter(Boolean).join("\n");
    if (note) return { ...result, diagnostics: [...(advised ?? result).diagnostics ?? [], { severity: "warn", code: "native_hook_feedback", message: note }] };
    return advised;
  }
  async beforeRequest(messages: readonly Message[], api: HookApi, ctx: Context): Promise<string> {
    const improvement = await this.improvement?.beforeRequest(api, ctx);
    const selected = await this.select(this.binding.store.candidates("beforeRequest"), api, ctx);
    const { readHints, cwd } = this.binding;
    const scope = readHints && cwd && messages.at(-1)?.role === "user" ? this.binding.scope() : undefined;
    const lookup = Boolean(scope && cwd && readHints?.has(scope.taskId, cwd));
    if (!selected && !lookup) return improvement ?? "";
    const user = [...messages].reverse().find(m => m.role === "user");
    const userText = durableContentText(user?.content).slice(0, 16000);
    if (!lookup && selected && !selected.hooks.some(h => h.id.startsWith("improvement-"))) return [improvement, await this.evaluate(selected, "beforeRequest", api, ctx, { userText })].filter(Boolean).join("\n");
    const live = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run;
    const inputId = live?.inputs.at(-1);
    const entryId = inputId === undefined ? live?.first : (await this.storage.submission(inputId, ctx))?.entry;
    const entry = entryId === undefined ? undefined : await api.entry(entryId, ctx);
    const original = improvementInput(entry);
    const name = lookup && entry?.kind === "mybuddy.user" ? lookupFileName(original) : undefined;
    let fileNote: string | undefined;
    if (name && scope && cwd && readHints && live?.first !== undefined
      && !(await api.snapshot(DurableSubagentIdentity, api.conversationId, ctx))?.value
      && !(await api.snapshot(DurableConsultIdentity, api.conversationId, ctx))?.key) {
      try {
        fileNote = await readHints.suggest(scope.taskId, cwd, name, String(api.conversationId),
          JSON.stringify([live.first,inputId]), "request:" + api.taskId);
      } catch (error) { ctx.abortSignal?.throwIfAborted(); console.warn("[NativeImprovement] File lookup unavailable", error); }
    }
    const checks = selected && await this.evaluate(selected, "beforeRequest", api, ctx, { userText, ...requestFeatures(original),
      hasPriorAnswer: user && messages.at(-1) === user && messages.slice(0, messages.lastIndexOf(user)).some(m => m.role === "assistant" && m.stopReason === "stop"),
      repeatedReadFailure: Boolean(original) && repeatedReadFailure(messages) }, "", "", String(live?.first ?? inputId ?? ""));
    return [improvement, fileNote, checks].filter(Boolean).join("\n");
  }
  async beforeFinish(answer: AssistantMessage, api: HookApi, ctx: Context): Promise<void> {
    if (!["stop", "length", "toolUse"].includes(answer.stopReason) || answer.content.some(item => item.type === "toolCall")) return;
    try {
      const selected = await this.select(this.binding.store.candidates("beforeFinish"), api, ctx);
      const improvement = await this.improvement?.beforeFinish(api, ctx);
      if (!selected && !improvement) return;
      const live = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run;
      if (!live || (live.first === undefined && !live.inputs.length)) throw new Error("无法读取本轮会话身份");
      const runKey = String(live.first ?? live.inputs[0]);
      const page = live.first === undefined ? undefined : await api.entries({ minEntryId: live.first, order: "descending" }, 48, undefined, ctx);
      const tools = finishToolEvidence(page?.items.slice().reverse() ?? []);
      const inputId = live.inputs.at(-1);
      const inputEntry = inputId !== undefined ? (await this.storage.submission(inputId, ctx))?.entry : undefined;
      const entryId = inputEntry ?? live.first;
      const entry = entryId === undefined ? undefined : await api.entry(entryId, ctx);
      const user = entry?.model?.find(m => m.role === "user");
      const target = requestFeatures(improvementInput(entry)).target;
      const observed: ReadbackTool[] = [];
      let cwd = this.binding.cwd;
      if (target) {
        cwd = (await api.snapshot(DurableSubagentIdentity, api.conversationId, ctx))?.value?.workspace.cwd ?? cwd;
        const byCall = new Map(tools.map(t => [`${t.entryId}:${t.callId}`, t]));
        for (const record of page?.items.slice().reverse() ?? []) {
          if (record.conversationId !== api.conversationId || (entryId !== undefined && record.id < entryId)) continue;
          for (const m of record.model ?? []) if (m.role === "toolResult") {
            if (m.toolName === "codemode") observed.push(...nestedReadbackTools(m.details));
            else {
              const item = byCall.get(`${record.id}:${m.toolCallId}`);
              if (item) observed.push(item);
            }
          }
        }
      }
      const hookNote = selected && await this.evaluate(selected, "beforeFinish", api, ctx, { answer: durableContentText(answer.content).slice(0, 16000),
        inputEntry: entryId, readback: readbackState(target, observed, cwd),
        reportedBlocker: reportsBlocker(durableContentText(answer.content)),
        userText: durableContentText(user?.content).slice(0, 16000), recentTools: tools, historyTruncated: Boolean(page?.next) }, "", "", runKey);
      const note = [improvement, hookNote].filter(Boolean).join("\n");
      if (!note) return;
      answer.content = [{ type: "text", text: note }];
      const attemptKey = `${api.conversationId}:${runKey}`;
      const attempts = (this.improvementAttempts.get(attemptKey) ?? 0) + 1;
      this.improvementAttempts.set(attemptKey, attempts);
      if (attempts <= 2 && (!selected || this.binding.store.finishAttempts(selected.taskId, String(api.conversationId), runKey) <= 2)) {
        this.continuations.set(answer, note);
        return;
      }
      throw new Error("两次补救后仍未通过完成检查。\n" + note);
    } catch (error) {
      // Pi treats an extension exception as diagnostic. Classify this response before Pi commits it.
      answer.stopReason = "aborted";
      answer.errorMessage = String(error instanceof Error ? error.message : error);
      answer.content = [{ type: "text", text: answer.errorMessage }];
    }
  }
  continuation(answer: AssistantMessage): string | undefined { return this.continuations.get(answer); }
  async beforeProviderRequest(api: HookApi, ctx: Context): Promise<void> { await this.improvement?.beforeProviderRequest(api, ctx); }
}
