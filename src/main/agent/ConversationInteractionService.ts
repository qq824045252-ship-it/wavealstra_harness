import { createHash, randomUUID } from "node:crypto";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import type {
  ConversationInteractionAnswer,
  ConversationInteractionDto,
  ConversationInteractionMutationResult,
  ConversationInteractionOption,
  ConversationInteractionRequest,
} from "../../shared/conversation-interaction";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import { ConversationInteractionRepository } from "./ConversationInteractionRepository";

type Waiter = {
  resolve: (answer: ConversationInteractionAnswer) => void;
  reject: (error: Error) => void;
};

export class ConversationInteractionService {
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(
    private readonly repo: ConversationInteractionRepository,
    private readonly emit: (patch: AgentUiPatch) => void,
  ) {}

  request(ctx: ConversationExecutionContext, request: ConversationInteractionRequest): Promise<ConversationInteractionAnswer> {
    if (this.repo.pendingByExecution(ctx.executionId)) throw new Error("当前执行已经在等待用户回答");
    const interaction = this.repo.insert(this.normalize(ctx, request));
    this.publish(interaction);
    return this.wait(interaction);
  }

  /** The native tool identity survives replay; cancelling an observer never settles the question. */
  requestDurable(ctx: ConversationExecutionContext, request: ConversationInteractionRequest, options: {
    key: string;
    signal?: AbortSignal;
    onPending?: (interaction: ConversationInteractionDto) => void;
  }): Promise<ConversationInteractionAnswer> {
    if (options.signal?.aborted) return Promise.reject(new Error("交互观察已结束"));
    const id = durableInteractionId(ctx, options.key);
    const candidate = { ...this.normalize(ctx, request), id };
    const prior = this.repo.get(id);
    if (prior && interactionRequestKey(prior) !== interactionRequestKey(candidate)) {
      return Promise.reject(new Error("同一持久交互身份不能用于不同问题"));
    }
    const interaction = prior ?? this.repo.insert(candidate);
    if (interaction.status === "resolved") {
      return interaction.answer === undefined ? Promise.reject(new Error("交互缺少已保存的回答")) : Promise.resolve(interaction.answer);
    }
    if (interaction.status !== "pending") return Promise.reject(new Error("交互已取消或过期"));
    this.publish(interaction);
    options.onPending?.(interaction);
    return this.wait(interaction, options.signal);
  }

  private wait(interaction: ConversationInteractionDto, signal?: AbortSignal): Promise<ConversationInteractionAnswer> {
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(interaction.id) ?? new Set<Waiter>();
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (!waiters.size) this.waiters.delete(interaction.id);
      };
      const waiter: Waiter = {
        resolve: answer => { cleanup(); resolve(answer); },
        reject: error => { cleanup(); reject(error); },
      };
      const onAbort = () => waiter.reject(new Error("交互观察已结束"));
      waiters.add(waiter);
      this.waiters.set(interaction.id, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  respond(id: string, answer: ConversationInteractionAnswer): ConversationInteractionMutationResult {
    const current = this.repo.get(id);
    if (!current) return { ok: false, code: "not_found", message: "找不到该交互请求" };
    if (current.status !== "pending") return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    const validation = validateAnswer(current, answer);
    if (validation) return { ok: false, code: "invalid_answer", message: validation };
    const interaction = this.repo.settle(id, "resolved", answer);
    if (!interaction) return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    this.publish(interaction);
    for (const waiter of [...this.waiters.get(id) ?? []]) waiter.resolve(answer);
    return { ok: true, interaction };
  }

  cancel(id: string, reason = "用户取消了回答"): ConversationInteractionMutationResult {
    const current = this.repo.get(id);
    if (!current) return { ok: false, code: "not_found", message: "找不到该交互请求" };
    if (current.status !== "pending") return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    const interaction = this.repo.settle(id, "cancelled");
    if (!interaction) return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    this.publish(interaction);
    for (const waiter of [...this.waiters.get(id) ?? []]) waiter.reject(new Error(reason));
    return { ok: true, interaction };
  }

  /** Retire one obsolete native tool question on replay, without touching other
   * questions in the same execution or changing any saved user answer. */
  cancelDurable(ctx: ConversationExecutionContext, key: string, reason?: string): ConversationInteractionMutationResult {
    return this.cancel(durableInteractionId(ctx, key), reason);
  }

  cancelExecution(executionId: string, reason?: string): void {
    for (const pending of this.repo.listPendingByExecution(executionId)) this.cancel(pending.id, reason ?? "当前执行已中止");
  }

  cancelTask(taskId: string, reason = "当前任务已由用户停止"): void {
    for (const pending of this.repo.listByTask(taskId)) if (pending.status === "pending") this.cancel(pending.id, reason);
  }

  listByTask(taskId: string): ConversationInteractionDto[] { return this.repo.listByTask(taskId); }
  deleteFrom(taskId: string, createdAt: number): number { return this.repo.deleteFrom(taskId, createdAt); }

  cloneTerminal(sourceTaskId: string, childTaskId: string, messageIdMap: Map<string, string>): number {
    let count = 0;
    for (const source of this.repo.listByTask(sourceTaskId)) {
      const childMessageId = messageIdMap.get(source.assistantMessageId);
      if (source.status === "pending" || !childMessageId) continue;
      this.repo.insert({
        ...source,
        id: `interaction-${randomUUID()}`,
        taskId: childTaskId,
        executionId: `execution-${randomUUID()}`,
        assistantMessageId: childMessageId,
        version: 1,
        createdAt: Date.now(),
      });
      count++;
    }
    return count;
  }

  private normalize(ctx: ConversationExecutionContext, request: ConversationInteractionRequest): ConversationInteractionDto {
    const title = request.title.trim().slice(0, 240);
    if (!title) throw new Error("交互标题不能为空");
    const options: ConversationInteractionOption[] = (request.options ?? []).slice(0, 20).map((option, index) => ({
      ...option,
      id: option.id?.trim() || `option-${index + 1}`,
      label: option.label.trim().slice(0, 160),
      description: option.description?.trim().slice(0, 500) || undefined,
    })).filter((option) => option.label.length > 0);
    if ((request.kind === "single_select" || request.kind === "multi_select") && options.length < 2) {
      throw new Error("选择类交互至少需要两个选项");
    }
    if (request.kind === "confirm" && options.length === 0) {
      options.push({ id: "yes", label: "确认", recommended: true }, { id: "no", label: "取消" });
    }
    const minSelections = request.kind === "multi_select" ? Math.max(0, request.minSelections ?? 1) : undefined;
    const maxSelections = request.kind === "multi_select"
      ? Math.max(minSelections ?? 1, Math.min(options.length, request.maxSelections ?? options.length))
      : undefined;
    return {
      id: `interaction-${randomUUID()}`,
      ...ctx,
      kind: request.kind,
      title,
      description: request.description?.trim().slice(0, 1200) || undefined,
      options,
      minSelections,
      maxSelections,
      allowCustom: request.allowCustom === true,
      customPlaceholder: request.customPlaceholder?.trim().slice(0, 160) || undefined,
      status: "pending",
      version: 1,
      createdAt: Date.now(),
    };
  }

  private publish(interaction: ConversationInteractionDto): void {
    this.emit({
      type: "conversation_interaction_snapshot",
      taskId: interaction.taskId,
      executionId: interaction.executionId,
      messageId: interaction.assistantMessageId,
      interaction,
    });
  }
}

function durableInteractionId(ctx: ConversationExecutionContext, key: string): string {
  return `interaction-durable-${createHash("sha256").update(JSON.stringify([ctx.taskId, ctx.executionId, key])).digest("hex")}`;
}

function interactionRequestKey(value: ConversationInteractionDto): string {
  return JSON.stringify([value.taskId, value.executionId, value.assistantMessageId, value.kind, value.title,
    value.description, value.options, value.minSelections, value.maxSelections, value.allowCustom, value.customPlaceholder]);
}

function validateAnswer(interaction: ConversationInteractionDto, answer: ConversationInteractionAnswer): string | undefined {
  if (interaction.kind === "confirm") return typeof answer === "boolean" ? undefined : "确认请求必须提交布尔值";
  if (interaction.kind === "short_text" || interaction.kind === "long_text") {
    return typeof answer === "string" && answer.trim().length > 0 ? undefined : "请输入回答";
  }
  const enabled = new Set(interaction.options.filter((option) => !option.disabled).map((option) => option.id));
  if (interaction.kind === "single_select") {
    if (typeof answer !== "string") return "请选择一个选项";
    if (enabled.has(answer) || (interaction.allowCustom && answer.trim())) return undefined;
    return "选择的选项无效";
  }
  if (!Array.isArray(answer)) return "请选择一个或多个选项";
  const unique = [...new Set(answer)];
  const valid = unique.every((value) => enabled.has(value) || (interaction.allowCustom && value.trim()));
  if (!valid) return "选择中包含无效选项";
  if (unique.length < (interaction.minSelections ?? 0)) return "选择数量不足";
  if (unique.length > (interaction.maxSelections ?? Number.MAX_SAFE_INTEGER)) return "选择数量过多";
  return undefined;
}
