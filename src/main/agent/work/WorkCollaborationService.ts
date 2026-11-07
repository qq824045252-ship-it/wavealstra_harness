import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkActor, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { workCollaborationInputSchema, type WorkCollaborationInput, type WorkCollaborationMessage } from "../../../shared/bot-work-collaboration";
import type { BotRegistry } from "./BotRegistry";
import type { WorkService } from "./WorkService";

export function ensureWorkCollaborationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_collaboration_messages (
      message_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id),
      sender_bot_id TEXT, sender_kind TEXT NOT NULL CHECK(sender_kind IN ('user','bot','worker')),
      user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('delegate','accepted','question','result','blocked','change','cancel','handoff')),
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_collaboration_order ON work_collaboration_messages(work_id,created_at,message_id);
    CREATE TABLE IF NOT EXISTS work_handoff_preparations (
      preparation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), target_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      state_version INTEGER NOT NULL, owner_epoch INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_delegation_adoptions (
      binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), owner_epoch INTEGER NOT NULL,
      adopted_by_bot_id TEXT NOT NULL REFERENCES bots(bot_id), intent_revision INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL, delegated_scope_json TEXT NOT NULL CHECK(json_valid(delegated_scope_json)),
      operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(binding_id,owner_epoch)
    );
    CREATE TABLE IF NOT EXISTS work_notification_identity (
      notification_id TEXT PRIMARY KEY REFERENCES work_notifications(notification_id), input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL, sender_bot_id TEXT NOT NULL,
      semantic_validity TEXT NOT NULL DEFAULT 'active' CHECK(semantic_validity IN ('active','superseded','cancelled'))
    );
    CREATE TABLE IF NOT EXISTS work_notification_attempts (
      attempt_id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES work_notifications(notification_id),
      ordinal INTEGER NOT NULL CHECK(ordinal>0), channel TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), status TEXT NOT NULL CHECK(status IN ('unknown','sent','missing','failed')),
      claimed_at INTEGER NOT NULL, settled_at INTEGER, receipt TEXT, UNIQUE(notification_id,ordinal)
    );
    CREATE TRIGGER IF NOT EXISTS work_notification_snapshot AFTER INSERT ON work_notifications BEGIN
      INSERT INTO work_notification_identity(notification_id,input_snapshot_id,owner_epoch,sender_bot_id)
        SELECT NEW.notification_id,input_snapshot_id,owner_epoch,owner_bot_id FROM works WHERE work_id=NEW.work_id;
    END;
  `);
}

const storedMessageSchema = z.object({ payload_json: z.string(), sender_bot_id: z.string().nullable(),
  sender_kind: z.enum(["user", "bot", "worker"]), user_id: z.string(), intent_revision: z.number(),
  input_snapshot_id: z.string(), owner_epoch: z.number(), created_at: z.number(), payload_hash: z.string() });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const currentDelegation = (binding: WorkExecutionBindingDto, work: WorkDto) => binding.workId === work.workId
  && binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId
  && binding.invalidatedAt === undefined && binding.status !== "invalidated" && binding.ownerEpoch <= work.ownerEpoch;
type Options = { isAuthority?: () => boolean; now?: () => number };
type Sender = { kind: "user" | "bot" | "worker"; botId: string | null; userId: string; binding?: WorkExecutionBindingDto };

/** Messages carry requests and evidence. All business controls remain in WorkService. */
export class WorkCollaborationService {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly bots: BotRegistry, private readonly options: Options = {}) {
    ensureWorkCollaborationTables(db);
  }

  send(actor: WorkActor, input: WorkCollaborationInput): { replayed: boolean; message: WorkCollaborationMessage } {
    const parsed = workCollaborationInputSchema.parse(input);
    return this.works.transaction(() => {
      this.assertAuthority();
      const work = this.requireWork(parsed.workId);
      const sender = this.sender(actor, work);
      const hash = digest([parsed, sender.kind, sender.botId, sender.userId]);
      const stored = storedMessageSchema.optional().parse(this.db.prepare("SELECT * FROM work_collaboration_messages WHERE message_id=?").get(parsed.messageId));
      if (stored) {
        if (stored.payload_hash !== hash) throw new Error("idempotency_conflict: 协作消息标识已用于另一请求");
        return { replayed: true, message: this.decode(stored) };
      }
      if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= (this.options.now?.() ?? Date.now())) throw new Error("事项授权已过期，不能接纳新的协作决定");
      if (parsed.versionGuard.expectedOwnerEpoch !== work.ownerEpoch) throw new Error("epoch_mismatch: 协作决定来自旧负责人代次");
      if (parsed.versionGuard.expectedStateVersion !== work.stateVersion || parsed.versionGuard.expectedIntentRevision !== work.intentRevision) {
        throw new Error("version_conflict: 协作决定必须重新读取当前事项");
      }
      if (work.lifecycle !== "active" && !["result", "blocked", "question", "accepted"].includes(parsed.kind)) throw new Error("事项当前不接纳新的协作动作");
      const owner = sender.kind === "user" || sender.botId === work.ownerBotId && sender.kind === "bot";
      if (["delegate", "change", "cancel", "handoff"].includes(parsed.kind) && !owner) throw new Error("只有当前负责人或用户可以提出团队控制请求");
      if (parsed.kind === "delegate" && (!work.authorization.allowRedelegation || sender.kind === "worker")) throw new Error("当前授权不允许转委派");
      const allowed = new Set([work.ownerBotId, ...work.participants.map(item => item.botId)]);
      for (const botId of parsed.recipientBotIds) {
        const recipient = this.bots.getBot(botId);
        if (!recipient || recipient.userId !== work.userId || recipient.status !== "active" || !allowed.has(botId)) throw new Error("消息接收者不属于当前事项的合法参与范围");
      }
      for (const root of [parsed.causalMessageId, parsed.replyToMessageId]) {
        let depth = 0;
        let cause = root;
        const visited = new Set<string>([parsed.messageId]);
        while (cause) {
          if (visited.has(cause) || ++depth > 32) throw new Error("协作因果链超过上限或形成循环");
          visited.add(cause);
          const previous = storedMessageSchema.optional().parse(this.db.prepare("SELECT * FROM work_collaboration_messages WHERE message_id=? AND work_id=?").get(cause, work.workId));
          if (!previous) throw new Error("回复或因果消息不属于当前事项");
          const decoded = this.decode(previous);
          if (sender.kind !== "user" && decoded.senderBotId !== sender.botId && !decoded.recipientBotIds.includes(sender.botId ?? "")) throw new Error("不能引用调用者不可见的协作消息");
          cause = decoded.causalMessageId ?? decoded.replyToMessageId;
        }
      }
      if (["result", "blocked"].includes(parsed.kind) && !parsed.executionRefs.length) throw new Error("执行结果必须引用实际生产者");
      for (const ref of parsed.executionRefs) {
        const binding = this.works.repo.getBinding(ref.bindingId);
        if (!binding || binding.workId !== work.workId || binding.taskId !== ref.taskId || binding.durableStoreKey !== ref.durableStoreKey
          || binding.conversationId !== ref.conversationId || binding.workspaceBinding !== ref.workspaceBinding) throw new Error("协作引用的执行命名空间不匹配");
        if (!owner && binding.botId !== sender.botId || sender.binding && sender.binding.bindingId !== binding.bindingId) throw new Error("只能上报本人有效委派的执行事实");
        if (binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId || binding.invalidatedAt) throw new Error("执行引用已不适用于当前输入");
        if (!this.isDelegationAdopted(binding, work)) throw new Error("原委派尚未被当前负责人接管");
      }
      if (parsed.artifactRefs.some(path => !this.works.repo.listDeliverables(work.workId).some(item =>
        parsed.executionRefs.some(ref => ref.bindingId === item.executionId) && item.artifactRefs.includes(path)))) throw new Error("成果引用缺少对应生产者事实");
      const message: WorkCollaborationMessage = { ...parsed, senderBotId: sender.botId, senderKind: sender.kind,
        userId: work.userId, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
        ownerEpoch: work.ownerEpoch, createdAt: this.options.now?.() ?? Date.now() };
      this.db.prepare(`INSERT INTO work_collaboration_messages(message_id,work_id,sender_bot_id,sender_kind,user_id,kind,payload_hash,
        payload_json,intent_revision,input_snapshot_id,owner_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(parsed.messageId, work.workId, sender.botId, sender.kind, work.userId, parsed.kind, hash, JSON.stringify(parsed),
          work.intentRevision, work.inputSnapshotId, work.ownerEpoch, message.createdAt);
      this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: message.createdAt });
      this.works.emitCurrentProjection(work.workId);
      return { replayed: false, message };
    });
  }

  list(actor: WorkActor, workId: string): WorkCollaborationMessage[] {
    const sender = this.sender(actor, this.requireWork(workId));
    return this.history(workId).filter(item => sender.kind === "user" || item.senderBotId === sender.botId || item.recipientBotIds.includes(sender.botId ?? ""));
  }

  /** Trusted projection only; user-facing callers must pass through list(). */
  history(workId: string): WorkCollaborationMessage[] {
    return this.db.prepare("SELECT * FROM work_collaboration_messages WHERE work_id=? ORDER BY created_at,message_id").all(workId)
      .map(row => this.decode(storedMessageSchema.parse(row)));
  }

  prepareHandoff(actor: WorkActor, workId: string, targetBotId: string): { preparationId: string; work: WorkDto; bindingIds: string[] } {
    return this.works.transaction(() => {
      this.assertAuthority();
      const work = this.requireWork(workId);
      const sender = this.sender(actor, work);
      if (sender.kind !== "user" && (sender.kind !== "bot" || sender.botId !== work.ownerBotId)) throw new Error("只有负责人或用户可以准备交接");
      const error = this.handoffError(work, targetBotId);
      if (error) throw new Error(error);
      const bindingIds = this.works.repo.listBindings(workId).filter(binding => currentDelegation(binding, work)).map(binding => binding.bindingId);
      const preparationId = digest([workId, targetBotId, work.stateVersion, work.ownerEpoch]);
      this.db.prepare(`INSERT OR IGNORE INTO work_handoff_preparations(preparation_id,work_id,target_bot_id,state_version,
        owner_epoch,input_snapshot_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(preparationId, workId, targetBotId, work.stateVersion, work.ownerEpoch, work.inputSnapshotId,
          JSON.stringify({ work, bindingIds, deliverableIds: work.acceptedDeliverableIds }), this.options.now?.() ?? Date.now());
      return { preparationId, work, bindingIds };
    });
  }

  handoffError(work: WorkDto, targetBotId: string, delegatedScope = work.authorization.allowedScopes): string | undefined {
    const target = this.bots.getBot(targetBotId);
    if (!target || target.userId !== work.userId || target.status !== "active") return "目标负责人不可用或不属于该事项用户";
    if (targetBotId === work.ownerBotId) return "新负责人必须与当前负责人不同";
    if (!work.authorization.allowRedelegation) return "事项授权不允许交接";
    if (delegatedScope.some(scope => !work.authorization.allowedScopes.includes(scope)
      || !target.authorization.allowedScopes.includes(scope))) return "交接范围超出当前事项或目标 Bot 的授权";
    return undefined;
  }

  preparationError(preparationId: string, work: WorkDto, targetBotId: string): string | undefined {
    const row = z.object({ state_version: z.number(), owner_epoch: z.number(), input_snapshot_id: z.string(), target_bot_id: z.string() })
      .optional().parse(this.db.prepare("SELECT * FROM work_handoff_preparations WHERE preparation_id=? AND work_id=?").get(preparationId, work.workId));
    if (!row || row.target_bot_id !== targetBotId) return "找不到对应交接准备快照";
    if (row.state_version !== work.stateVersion || row.owner_epoch !== work.ownerEpoch || row.input_snapshot_id !== work.inputSnapshotId) return "交接准备快照已过期，需要重新读取当前事项";
    return undefined;
  }

  /** Called in handoffOwner's existing immediate control transaction, after its Work update. */
  commitHandoffFacts(before: WorkDto, next: WorkDto, operationId: string, now: number): void {
    this.assertAuthority();
    if (!this.db.inTransaction || next.ownerEpoch !== before.ownerEpoch + 1 || next.intentRevision !== before.intentRevision
      || next.inputSnapshotId !== before.inputSnapshotId) throw new Error("交接必须与单一负责人 CAS 原子提交");
    const error = this.handoffError(before, next.ownerBotId);
    if (error) throw new Error(error);
    for (const binding of this.works.repo.listBindings(before.workId)) {
      if (!currentDelegation(binding, next)) continue;
      const scope = binding.delegatedScope.filter(item => next.authorization.allowedScopes.includes(item));
      this.db.prepare(`INSERT INTO work_delegation_adoptions(binding_id,owner_epoch,adopted_by_bot_id,intent_revision,
        input_snapshot_id,delegated_scope_json,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(binding.bindingId, next.ownerEpoch, next.ownerBotId, next.intentRevision, next.inputSnapshotId, JSON.stringify(scope), operationId, now);
    }
    // Old unsubmitted decisions do not acquire new-owner authority by changing ownerBotId.
    // Existing bindings keep their native recovery namespace and explicit adoption above.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_dispatch_requests'").get()) {
      this.db.prepare(`UPDATE work_dispatch_requests SET state='cancelled',error='等待新负责人重新核对派发计划'
        WHERE work_id=? AND bot_id=? AND state IN ('pending','blocked') AND NOT EXISTS (
          SELECT 1 FROM work_execution_bindings b WHERE b.work_id=work_dispatch_requests.work_id
          AND b.operation_id='dispatch:' || work_dispatch_requests.operation_id)`)
        .run(before.workId, before.ownerBotId);
    }
    this.db.prepare("DELETE FROM work_participants WHERE work_id=? AND bot_id=?").run(before.workId, before.ownerBotId);
    const input = { messageId: `handoff:${next.workId}:${operationId}`, workId: next.workId, kind: "handoff" as const,
      recipientBotIds: [next.ownerBotId], body: `负责人由 ${this.bots.getBot(before.ownerBotId)?.displayName ?? "原负责人"} 交接为 ${this.bots.getBot(next.ownerBotId)?.displayName ?? "新负责人"}，沿用当前要求、输入、成果和预算`,
      artifactRefs: [], executionRefs: this.works.repo.listBindings(next.workId).filter(binding => this.isDelegationAdopted(binding, next)).map(binding => ({
        bindingId: binding.bindingId, taskId: binding.taskId, durableStoreKey: binding.durableStoreKey,
        conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding })),
      versionGuard: { expectedStateVersion: before.stateVersion, expectedIntentRevision: before.intentRevision, expectedOwnerEpoch: before.ownerEpoch } };
    this.db.prepare(`INSERT INTO work_collaboration_messages(message_id,work_id,sender_bot_id,sender_kind,user_id,kind,payload_hash,
      payload_json,intent_revision,input_snapshot_id,owner_epoch,created_at) VALUES (?,?,?,'bot',?,'handoff',?,?,?,?,?,?)`)
      .run(input.messageId, next.workId, before.ownerBotId, next.userId, digest(input), JSON.stringify(input), next.intentRevision, next.inputSnapshotId, next.ownerEpoch, now);
    // Ordinary handoff has no post-commit adoption gap. If a previously retained
    // receipt was waiting for adoption, replay it in this same control transaction.
    this.works.nativeResults.consume(next.workId);
  }

  isDelegationAdopted(binding: WorkExecutionBindingDto, work: WorkDto): boolean {
    if (!currentDelegation(binding, work)) return false;
    if (binding.ownerEpoch === work.ownerEpoch) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM work_delegation_adoptions WHERE binding_id=? AND owner_epoch=?
      AND adopted_by_bot_id=? AND intent_revision=? AND input_snapshot_id=?`).get(binding.bindingId, work.ownerEpoch,
      work.ownerBotId, work.intentRevision, work.inputSnapshotId));
  }

  /** Missing adoption delays publication, never invalidates otherwise current native facts. */
  isDelegationPending(binding: WorkExecutionBindingDto, work: WorkDto): boolean {
    return currentDelegation(binding, work) && binding.ownerEpoch < work.ownerEpoch && !this.isDelegationAdopted(binding, work);
  }

  private requireWork(workId: string): WorkDto {
    const work = this.works.getWork(workId);
    if (!work) throw new Error("找不到 Work");
    return work;
  }
  private assertAuthority(): void { if (this.options.isAuthority && !this.options.isAuthority()) throw new Error("当前宿主不是协作权威"); }
  private sender(actor: WorkActor, work: WorkDto): Sender {
    if (actor.kind === "system") throw new Error("协作消息必须来自已认证的用户、Bot 或执行者");
    if (actor.kind === "worker") {
      const binding = this.works.repo.getBinding(actor.bindingId);
      if (!binding || binding.botId !== actor.botId || binding.workId !== work.workId) throw new Error("执行者身份与事项不匹配");
      return { kind: "worker", userId: work.userId, botId: binding.botId, binding };
    }
    if (actor.userId !== work.userId) throw new Error("找不到 Work");
    if (actor.kind === "user") return { kind: "user", userId: actor.userId, botId: null };
    const bot = this.bots.getBot(actor.botId);
    if (!bot || bot.userId !== work.userId || bot.status !== "active" || ![work.ownerBotId, ...work.participants.map(item => item.botId)].includes(bot.botId)) throw new Error("Bot 没有此事项的当前参与权限");
    return { kind: "bot", userId: work.userId, botId: bot.botId };
  }
  private decode(row: z.infer<typeof storedMessageSchema>): WorkCollaborationMessage {
    return { ...workCollaborationInputSchema.parse(JSON.parse(row.payload_json)), senderBotId: row.sender_bot_id,
      senderKind: row.sender_kind, userId: row.user_id, intentRevision: row.intent_revision,
      inputSnapshotId: row.input_snapshot_id, ownerEpoch: row.owner_epoch, createdAt: row.created_at };
  }
}
