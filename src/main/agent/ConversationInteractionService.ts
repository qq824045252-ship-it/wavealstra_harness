import { randomUUID } from "node:crypto";
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
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly repo: ConversationInteractionRepository,
    private readonly emit: (patch: AgentUiPatch) => void,
  ) {
    this.repo.expireAllPending();
  }

  request(ctx: ConversationExecutionContext, request: ConversationInteractionRequest): Promise<ConversationInteractionAnswer> {
    if (this.repo.pendingByExecution(ctx.executionId)) throw new Error("当前执行已经在等待用户回答");
    const interaction = this.repo.insert(this.normalize(ctx, request));
    this.publish(interaction);
    return new Promise<ConversationInteractionAnswer>((resolve, reject) => {
      this.waiters.set(interaction.id, { resolve, reject });
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
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.resolve(answer);
    return { ok: true, interaction };
  }

  cancel(id: string, reason = "用户取消了回答"): ConversationInteractionMutationResult {
    const current = this.repo.get(id);
    if (!current) return { ok: false, code: "not_found", message: "找不到该交互请求" };
    if (current.status !== "pending") return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    const interaction = this.repo.settle(id, "cancelled");
    if (!interaction) return { ok: false, code: "already_resolved", message: "该交互已经结束" };
    this.publish(interaction);
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.reject(new Error(reason));
    return { ok: true, interaction };
  }

  cancelExecution(executionId: string, reason?: string): void {
    const pending = this.repo.pendingByExecution(executionId);
    if (pending) this.cancel(pending.id, reason ?? "当前执行已中止");
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
