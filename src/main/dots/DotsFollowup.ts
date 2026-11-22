import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type Cursor } from "@earendil-works/pi-durable";
import { openDurablePassiveStorage } from "../agent/durable/DurableStorage";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import type { ConversationGoalDto, GoalContinuationOrigin } from "../../shared/conversation-goal";
import { DOTS_NO_CHANGE, type DotsDelegation } from "../../shared/dots";
import { readDotsWorkerOutcome } from "./DotsWorkerOutcome";

export type DotsFollowupDecision = {
  kind: "quiet" | "ask" | "deliver" | "progress" | "continued" | "deferred";
  text?: string;
  artifacts?: DotsDelegation["artifacts"];
};
export const followupInstructions = [
  "这轮是 Dots 的后台任务。Dots 读取你的内部回执，把 result 显示给用户。用户对文字和版式的要求适用于 result。",
  '本轮完整交付时，最后一条助手消息的全部正文必须是一个 JSON 对象 {"dotsState":"complete","result":"按用户约定格式交付的正文"}。可交付的总结、测试结论和 Markdown 全部写进 result 字符串。JSON 前后不要另写总结或说明。',
  "用 register_artifact 登记需要交付的文件。若用户只需要文件且已登记，result 可留空。用户在原任务中直接发起的新请求按新请求正常回复。",
  '若本轮只完成一个实质里程碑、原授权范围内确有下一步，返回一行 JSON {"dotsState":"progress","result":"已取得的具体结果","remainingQuote":"原交办中仍待完成的逐字片段"}。不要把计划、收到指令或重复状态标为进展。下一步会在本普通任务中继续。',
  "若已取得可交付的实质里程碑且本轮仍在执行，可以在调用下一工具前用同一 progress 格式报告里程碑。宿主会继续当前执行。",
  "具体业务选择或缺少无法自行取得的资料时，使用 request_user_input 只问一个具体问题，并在题干交代已有结果。",
].join("\n");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function humanFailure(raw: string) {
  const body = raw.replace(/^\s*(?:HTTP\s+)?[45]\d\d\s*[:\-]?\s*/i, "");
  let reason = body;
  try {
    const payload = JSON.parse(body);
    reason =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : typeof payload?.message === "string"
          ? payload.message
          : "执行器拒绝了本次请求";
  } catch {
    /* Provider also returns plain-text errors. */
  }
  return (
    (reason
      .trim()
      .replace(/[。.!！]+$/u, "")
      .slice(0, 600) || "执行器没有返回原因") + "。"
  );
}
function transientFailure(text: string) {
  const status = /^(?:HTTP\s+)?([45]\d\d)\b/i.exec(text.trim());
  if (status) return [408, 425, 429, 500, 502, 503, 504].includes(Number(status[1]));
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|timed? ?out|连接中断|请求超时|暂时不可用/i.test(
    text,
  );
}
interface Plan {
  taskId: string;
  source: string;
  goal: string;
  assignment: string;
  assignmentQuote?: string;
  steps: string[];
  step: number;
  previous: string[];
  retry: boolean;
  lastProgress?: string;
  request: AgentPromptRequest;
  parent?: string;
}
interface Hooks {
  allowed(task: string): boolean;
  proactive(task: string): boolean;
  goal(task: string, id: string): ConversationGoalDto | undefined;
  link(request: AgentPromptRequest, source: string): void;
  version(task: string): Promise<string>;
  receipt(task: string, id: string): Promise<number | undefined>;
  send(request: AgentPromptRequest, source: string): Promise<boolean>;
}
type Row = { plan: string };
const quiet: DotsFollowupDecision = { kind: "quiet" };
export class DotsFollowup {
  constructor(
    private db: Database.Database,
    private hooks: Hooks,
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS dots_followup_plans(operation_id TEXT PRIMARY KEY,plan TEXT NOT NULL)");
  }
  private get(id: string) {
    const row = this.db.prepare("SELECT plan FROM dots_followup_plans WHERE operation_id=?").get(id) as Row | undefined;
    return row ? (JSON.parse(row.plan) as Plan) : undefined;
  }
  private put(request: AgentPromptRequest, plan: Plan) {
    this.db
      .prepare("INSERT OR IGNORE INTO dots_followup_plans VALUES(?,?)")
      .run(request.userMessageId, JSON.stringify(plan));
  }
  remember(request: AgentPromptRequest, source: string, goal: string, steps: string[] = []) {
    if (!this.get(request.userMessageId))
      this.put(request, {
        taskId: request.taskId,
        source,
        goal,
        assignment: request.displayText ?? request.text,
        steps,
        step: 0,
        previous: [],
        retry: false,
        request,
      });
  }
  latestPlan(taskId: string) {
    const row = this.db.prepare(`SELECT p.plan FROM dots_delegations d
      LEFT JOIN dots_followup_plans p ON p.operation_id=d.operation_id
      WHERE d.task_id=? ORDER BY d.seq DESC LIMIT 1`).get(taskId) as { plan: string | null } | undefined;
    return row?.plan ? JSON.parse(row.plan) as Plan : undefined;
  }

  assignment(operationId: string) {
    return this.get(operationId)?.assignment;
  }

  anchorAssignment(operationId: string, quote: string) {
    this.db.prepare("UPDATE dots_followup_plans SET plan=json_set(plan,'$.assignmentQuote',?) WHERE operation_id=? AND json_extract(plan,'$.assignmentQuote') IS NULL")
      .run(quote, operationId);
  }

  rememberResume(request: AgentPromptRequest, source: string, previous: Plan, addition?: string) {
    this.put(request, { ...previous, parent: undefined, request, source,
      goal: [previous.goal, addition].filter(Boolean).join("\n"), retry: false });
  }
  validate(request: AgentPromptRequest) {
    if (!request.userMessageId.startsWith("dots-input-auto-")) return;
    const plan = this.get(request.userMessageId);
    if (
      !plan?.parent ||
      plan.taskId !== request.taskId ||
      !this.hooks.proactive(request.taskId) ||
      !this.current(plan.parent, request.taskId, request.userMessageId)
    )
      throw new Error("自动续办的原意图已变化或已暂停");
  }
  async recoverGoalCompletionLink(taskId: string, id: string, workId: string, revision: number) {
    if (this.get(id)) return;
    const prefix = `goal-continuation:${workId}:${revision}:`;
    if (!id.startsWith(prefix)) return;
    const attempt = Number(id.slice(prefix.length));
    if (!Number.isSafeInteger(attempt) || attempt < 1) return;
    await this.goalAccepted({ taskId, userMessageId: id, assistantMessageId: `goal-continuation-answer:${workId}:${revision}:${attempt}`,
      text: "原目标续跑" }, { workId, intentRevision: revision, attempt });
  }

  goalCompletion(taskId: string, id: string, workId: string, revision: number) {
    const plan = this.get(id);
    if (!plan || plan.taskId !== taskId || plan.request.dotsGoalId !== workId) return;
    if (!this.current(id, taskId) || plan.request.dotsGoalIntentRevision !== revision) return { stale: true } as const;
    let root = plan;
    while (root.parent) {
      const parent = this.get(root.parent);
      if (!parent || parent.taskId !== taskId || parent.request.dotsGoalIntentRevision !== revision) return { stale: true } as const;
      root = parent;
    }
    const userAcceptance = this.db.prepare(`SELECT 1 FROM dots_followup_plans p JOIN dots_delegations d ON d.operation_id=p.operation_id
      WHERE d.task_id=? AND d.goal_id=? AND json_extract(p.plan,'$.request.dotsGoalUserAcceptance') IS NOT NULL LIMIT 1`).get(taskId, workId);
    return { stale: false, evidenceOrigin: root.request.userMessageId, userAcceptance: Boolean(userAcceptance || root.request.dotsGoalUserAcceptance) } as const;
  }
  private current(id: string, taskId: string, child?: string) {
    if (!this.hooks.allowed(taskId)) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
      WHERE d.operation_id=? AND d.task_id=? AND d.status!='superseded' AND t.space_id IS d.space_id AND s.path IS d.space_path
      AND (t.cwd IS d.cwd OR (d.cwd IS NULL AND t.cwd IS d.space_path))
      AND NOT EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq AND newer.operation_id IS NOT ?)`,
        )
        .get(id, taskId, child ?? null),
    );
  }
  /** A side effect may precede a failed/empty answer. Only retry if the native ledger rules that out. */
  private async safeToRetry(task: string, operation: string, version: string) {
    const binding = this.db.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").get(task) as
      | { directory: string }
      | undefined;
    if (!binding) return false;
    const storage = await openDurablePassiveStorage(binding.directory, ctx);
    if (!storage) return false;
    try {
      const [conversationId, receipt] = JSON.parse(version) as [ConversationId, number];
      const input = await storage.submissionByRequest(conversationId, operation, ctx);
      if (
        input?.type !== "input" ||
        input.id !== receipt ||
        !(input.status === "done" || input.status === "unanswered")
      )
        return false;
      if (!input.entry) return false;
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries(
          { conversationId, minEntryId: input.entry, maxEntryId: input.answer },
          80,
          cursor,
          ctx,
        );
        for (const e of page.items) {
          if (
            e.kind === "mybuddy.artifact-registered" ||
            e.kind === "pi.tool-result" ||
            e.model?.some(
              (m) =>
                m.role === "toolResult" || (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")),
            )
          )
            return false;
        }
        cursor = page.next;
      } while (cursor);
      return true;
    } finally {
      await storage.close(ctx);
    }
  }
  /** Adopt only a Goal ignition that followed the same source's native task input. */
  async goalAccepted(request: AgentPromptRequest, origin: GoalContinuationOrigin) {
    if (!this.hooks.allowed(request.taskId)) return;
    const prior = this.db
      .prepare(
        "SELECT operation_id,source_message_id,goal_id FROM dots_delegations WHERE task_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(request.taskId) as { operation_id: string; source_message_id: string; goal_id: string } | undefined;
    if (!prior || prior.goal_id !== origin.workId || prior.operation_id === request.userMessageId) return;
    const plan = this.get(prior.operation_id);
    if (!plan || !this.current(prior.operation_id, request.taskId)) return;
    const binding = this.db
      .prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?")
      .get(request.taskId) as { directory: string } | undefined;
    if (!binding) return;
    const [cid] = JSON.parse(await this.hooks.version(request.taskId)) as [ConversationId, number];
    const storage = await openDurablePassiveStorage(binding.directory, ctx);
    if (!storage) return;
    let found = false,
      previous: string | undefined,
      cursor: Cursor | undefined;
    try {
      do {
        const page = await storage.scanSubmissions({ conversationId: cid, order: "descending" }, 32, cursor, ctx);
        for (const input of page.items) {
          if (input.type !== "input") continue;
          if (!found) {
            if (input.requestId !== request.userMessageId) return;
            found = true;
            continue;
          }
          previous = input.requestId;
          break;
        }
        cursor = page.next;
      } while (cursor && !previous);
    } finally {
      await storage.close(ctx);
    }
    if (previous !== prior.operation_id || !this.current(prior.operation_id, request.taskId)) return;
    if (plan.request.dotsGoalIntentRevision !== origin.intentRevision) return;
    const bound = { ...request, spaceId: plan.request.spaceId, dotsGoalId: origin.workId,
      dotsGoalIntentRevision: origin.intentRevision, dotsGoalUserAcceptance: plan.request.dotsGoalUserAcceptance };
    this.db.transaction(() => {
      this.put(bound, { ...plan, parent: prior.operation_id, request: bound });
      this.hooks.link(bound, prior.source_message_id);
    })();
  }
  /** Reconcile native admission that committed immediately before the prior desktop process exited. */
  async recoverGoals() {
    const roots = this.db
      .prepare(
        `SELECT d.task_id,d.goal_id,d.operation_id FROM dots_delegations d
      WHERE d.goal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dots_delegations n WHERE n.task_id=d.task_id AND n.seq>d.seq)`,
      )
      .all() as { task_id: string; goal_id: string; operation_id: string }[];
    for (const row of roots) {
      if (!this.hooks.allowed(row.task_id) || !this.get(row.operation_id)) continue;
      const counter = this.db
        .prepare("SELECT intent_revision,attempt_serial AS serial FROM conversation_goal_continuations WHERE work_id=?")
        .get(row.goal_id) as { intent_revision: number; serial: number } | undefined;
      if (!counter) continue;
      const key = `goal-continuation:${row.goal_id}:${counter.intent_revision}:${counter.serial}`;
      if (key === row.operation_id || (await this.hooks.receipt(row.task_id, key)) === undefined) continue;
      await this.goalAccepted(
        {
          taskId: row.task_id,
          userMessageId: key,
          assistantMessageId: "goal-continuation-answer:" + key.slice("goal-continuation:".length),
          text: "原目标续跑",
        },
        { workId: row.goal_id, intentRevision: counter.intent_revision, attempt: counter.serial },
      );
    }
  }
  async handle(row: DotsDelegation, original?: AgentPromptRequest): Promise<DotsFollowupDecision> {
    const decision = await this.decide(row, original);
    if (!["ask", "deliver", "progress"].includes(decision.kind) || !this.hooks.allowed(row.taskId)) return decision;
    const versionKey = (f: DotsDelegation["artifacts"][number]) => JSON.stringify([f.id, f.version ?? null]);
    const files = new Map(row.artifacts.map((f) => [versionKey(f), f]));
    const initialSize = files.size;
    let parent = this.get(row.id)?.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const receipt = this.db
        .prepare(
          "SELECT files FROM dots_delegations WHERE operation_id=? AND task_id=? AND source_message_id=? AND status='completed'",
        )
        .get(parent, row.taskId, row.sourceMessageId) as { files: string } | undefined;
      if (!receipt) break;
      for (const file of JSON.parse(receipt.files) as DotsDelegation["artifacts"]) {
        if (!files.has(versionKey(file))) files.set(versionKey(file), file);
      }
      parent = this.get(parent)?.parent;
    }
    return files.size > initialSize || initialSize < row.artifacts.length
      ? { ...decision, artifacts: [...files.values()] }
      : decision;
  }

  private async decide(row: DotsDelegation, original?: AgentPromptRequest): Promise<DotsFollowupDecision> {
    const text = row.text.trim();
    if (text === DOTS_NO_CHANGE || row.status === "pending" || row.status === "superseded")
      return quiet;
    const nextId = "dots-input-auto-" + digest(JSON.stringify([row.taskId, row.id]));
    if (!this.current(row.id, row.taskId, nextId)) {
      if (row.status !== "failed") return quiet;
      const held = this.db.prepare("SELECT 1 FROM dots_target_controls WHERE task_id=?").get(row.taskId);
      const replaced = this.db
        .prepare(
          `SELECT 1 FROM dots_delegations d JOIN dots_delegations n
        ON n.task_id=d.task_id AND n.seq>d.seq WHERE d.operation_id=? AND n.operation_id<>?`,
        )
        .get(row.id, nextId);
      if (held || replaced) return quiet;
      const exists = this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(row.taskId);
      const why = exists ? "原任务或工作空间已经变化，本次无法按原授权继续。" : "原任务已删除，本次工作没有完成。";
      return { kind: "ask", text: why + (text ? "\n" + text : "") + "\n要在哪个工作空间接着办理？" };
    }
    let plan = this.get(row.id);
    if (row.status === "running") {
      const checkpoint = readDotsWorkerOutcome(text);
      return checkpoint?.dotsState === "progress" && checkpoint.result.trim()
        ? { kind: "progress", text: checkpoint.result, artifacts: [] }
        : quiet;
    }
    if (row.status === "blocked") {
      const pending = this.db
        .prepare("SELECT title FROM conversation_interactions WHERE id=? AND task_id=? AND status='pending'")
        .get(row.interactionId ?? "", row.taskId) as { title: string } | undefined;
      if (!pending) return quiet;
      return { kind: "ask", text: [plan?.lastProgress, text || pending.title].filter(Boolean).join("\n\n") };
    }
    if (!plan && original?.userMessageId === row.id && original.taskId === row.taskId) {
      this.remember(original, row.sourceMessageId, original.displayText ?? original.text);
      plan = this.get(row.id);
    }
    const outcome = row.status === "completed" ? readDotsWorkerOutcome(text) : undefined;
    const progress = outcome?.dotsState === "progress" ? outcome : undefined;
    const summary = outcome?.result ?? "";
    const payload = outcome !== undefined && Boolean(summary.trim() || row.artifacts.length);
    const remaining = plan?.steps[plan.step + 1];
    const repair = row.status === "failed" || !payload;
    const stopped = (reason: string, question: string): DotsFollowupDecision => ({
      kind: "ask",
      text: [(!repair ? summary : plan?.lastProgress) || "", reason, question].filter(Boolean).join("\n\n"),
    });
    const unresolved = () => {
      const failed = row.status === "failed";
      const reason = failed ? "原任务执行失败：" + humanFailure(text) : "原任务没有报告可确认的交付结果或进展。";
      if (failed && /不在当前 Pi enabledModels 范围内|主对话默认模型/.test(text))
        return stopped(reason, "调整好模型设置后，要继续这个原任务吗？");
      if (failed && /\b(?:401|403)\b|permission|forbidden|unauthori|权限|凭据/i.test(text))
        return stopped(reason, "要改用哪个已授权的数据源或工作空间？");
      if (failed && /^(?:HTTP\s*)?4\d\d\b/i.test(text) && !transientFailure(text))
        return stopped(reason, "要调整本次提交的哪项要求再继续？");
      if (plan?.retry) return stopped(reason + "已尝试补救一次。", "要在原任务中重新尝试这一步吗？");
      return stopped(reason + "无法确认重复执行是否会产生额外影响。", "是否允许在原任务中再试这一步？");
    };
    if (row.goalId) {
      const g = this.hooks.goal(row.taskId, row.goalId);
      if (!g || g.status === "cancelled" || g.status === "paused") return quiet;
      if (g.status === "achieved") {
        const closed = this.db.prepare(`SELECT closure_summary AS summary FROM works
          WHERE work_id=? AND close_operation_id=? AND lifecycle='closed' AND closure_conclusion='succeeded'`)
          .get(row.goalId, `dots-goal-close:${row.id}`) as { summary?: string } | undefined;
        return closed && (closed.summary || row.artifacts.length)
          ? { kind: "deliver", text: closed.summary ?? "" }
          : quiet;
      }
      if (g.status === "blocked" || g.continuation?.state === "exhausted" || g.continuation?.state === "deferred") {
        const outstanding = g.criteria.find((c) => c.status === "pending" || c.status === "not_met");
        return stopped(
          "原目标尚未完成。" + (g.progressSummary ?? ""),
          outstanding
            ? "关于「" + outstanding.text + "」，当前可以提供哪项缺少的信息？"
            : "要如何处理原目标当前的阻碍？",
        );
      }
      if (row.status === "failed") return unresolved();
      return payload ? { kind: "progress", text: summary } : quiet;
    }
    if (!repair && !progress && !remaining) return { kind: "deliver", text: summary };
    if (!plan) return unresolved();
    if (progress && (!progress.remainingQuote || !plan.goal.includes(progress.remainingQuote)))
      return stopped("原任务提出的下一步超出这次交办可以确认的范围。", "接下来具体要办理哪一项？");
    const fingerprint = digest(JSON.stringify([summary, row.artifacts.map((f) => [f.id, f.version])]));
    if (!repair && (plan.previous.includes(fingerprint) || plan.previous.length >= 8))
      return stopped("本次续办没有出现新的实质进展，或已用完续办次数。", "下一步应优先处理原交办的哪一项？");
    if (repair && plan.retry) return unresolved();
    const child = this.get(nextId);
    if (
      child &&
      this.db
        .prepare("SELECT 1 FROM dots_delegations WHERE operation_id=? AND status IN ('failed','superseded')")
        .get(nextId)
    )
      return quiet;
    if (child && (await this.hooks.receipt(row.taskId, nextId)) !== undefined) return { kind: "continued" };
    const receipt = await this.hooks.receipt(row.taskId, row.id);
    if (receipt === undefined) {
      if (row.status === "failed") {
        const reason = "原任务没有接收本次执行。" + humanFailure(text);
        if (/主对话默认模型/.test(text)) return stopped(reason, "调整好模型设置后，要继续这个原任务吗？");
        const question = /permission|forbidden|unauthori|权限|凭据/i.test(text)
          ? "要改用哪个已授权的数据源或工作空间？"
          : "要在当前任务中重新提交这一步吗？";
        return stopped(reason, question);
      }
      return stopped("无法确认原任务是否接受过这一步。", "是否允许重新提交这一步？");
    }
    const version = await this.hooks.version(row.taskId);
    if (JSON.parse(version)[1] !== receipt || !this.current(row.id, row.taskId, nextId)) return quiet;
    if (row.status === "failed" && /cancel|abort|取消|停止|暂停|授权|permission|unauthori|forbidden/i.test(text))
      return unresolved();
    if (row.status === "failed" && !transientFailure(text)) return unresolved();
    if (repair && !(await this.safeToRetry(row.taskId, row.id, version))) return unresolved();
    if (!this.hooks.proactive(row.taskId))
      return row.status === "failed" ? unresolved() : { kind: "deferred", text: summary.trim() || undefined };
    const nextStep = repair ? plan.step : remaining ? plan.step + 1 : plan.step;
    const instruction = plan.steps[nextStep];
    const next = instruction ?? plan.goal;
    const persisted = child?.request ?? {
      taskId: row.taskId,
      spaceId: plan.request.spaceId,
      userMessageId: nextId,
      assistantMessageId: "dots-reply-" + nextId,
      dotsMemoryRefs: plan.request.dotsMemoryRefs,
      dotsSteerInputVersion: version,
      streamingBehavior: "followUp" as const,
      displayText: repair ? "继续原任务：补回本轮缺失结果" : "继续原任务：" + next,
      text:
        "原交办及限制：" +
        plan.goal +
        "\n本普通任务的交办范围：" +
        (plan.assignment ?? plan.goal) +
        "\n在同一任务内" +
        (repair
          ? "根据原记录报告实际取得的结果和仍未完成的事项"
          : instruction
            ? "依照原交办的次序推进当前步骤：" + instruction
            : "继续完成上面的完整交办，所有原有限制仍然适用") +
        "。保留已经完成的操作，不重复执行。不得扩大目标、收件人或权限。\n" +
        followupInstructions,
    };
    if (!this.current(row.id, row.taskId, nextId)) return quiet;
    if (!this.hooks.proactive(row.taskId))
      return row.status === "failed" ? unresolved() : { kind: "deferred", text: summary.trim() || undefined };
    this.put(persisted, {
      ...plan,
      parent: row.id,
      request: persisted,
      step: nextStep,
      lastProgress: repair ? plan.lastProgress : summary.slice(0, 1200),
      previous: repair ? plan.previous : [...plan.previous, fingerprint],
      retry: repair || plan.retry,
    });
    return (await this.hooks.send(persisted, plan.source)) ? { kind: "continued" } : quiet;
  }
}
