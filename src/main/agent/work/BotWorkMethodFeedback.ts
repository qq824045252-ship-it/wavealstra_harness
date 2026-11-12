import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { MemoryService } from "../../memory/MemoryService";
import type { MemorySkillEffectivenessService } from "../../memory/MemorySkillEffectivenessService";
import type { MemorySkillRevisionService } from "../../memory/MemorySkillRevisionService";
import type { SkillsService } from "../../skills/SkillsService";
import { botMemoryTextEligible, botWorkHasSharedOrigin, botPeerMemoryInput } from "../../memory/BotMemorySource";
import type { WorkDto } from "../../../shared/bot-work";
import type { BotMessageReceipt } from "./BotConversationRepository";
import { MEMORY_CONTENT_MAX_CHARS } from "../../../shared/memory-kernel";
import type { WorkService } from "./WorkService";
import { workDeliveryResults } from "./WorkDeliveryArtifacts";

const bindingSchema = z.object({ bot_id: z.string(), task_id: z.string(), binding_id: z.string(), status: z.enum(["completed", "failed"]) });
const invocationSchema = z.object({ id: z.string(), skill_id: z.string(), candidate_id: z.string().nullable() });

/** Explicit feedback reuses the Work's real execution and original Skill/Procedure lineage. */
export class BotWorkMethodFeedback {
  constructor(private readonly options: { db: AppDatabase; works: WorkService; userId: string; memory: MemoryService;
    skills: SkillsService; effectiveness: MemorySkillEffectivenessService; revisions: MemorySkillRevisionService }) {
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS bot_work_method_feedback (
      user_message_id TEXT NOT NULL, work_id TEXT NOT NULL, executor_bot_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      PRIMARY KEY(user_message_id,work_id)
    )`);
  }

  record(source: BotMessageReceipt, work: WorkDto): unknown {
    const { db, userId, memory, skills, effectiveness, revisions } = this.options;
    if (botPeerMemoryInput(db, source.user_message_id)) return { status: "peer_source", recorded: false };
    const current = z.object({ text: z.string() }).optional().parse(db.connection.prepare(`SELECT u.text FROM bot_send_receipts r
      JOIN bot_messages u ON u.message_id=r.user_message_id AND u.role='user'
      JOIN bot_messages a ON a.message_id=r.assistant_message_id AND a.role='assistant'
      JOIN bot_conversations c ON c.conversation_id=r.conversation_id AND c.user_id=r.user_id
      WHERE r.user_id=? AND r.bot_id=? AND r.request_id=? AND r.conversation_id=?
        AND r.user_message_id=? AND r.assistant_message_id=? AND a.status IN ('queued','running','unknown')`)
      .get(userId, source.bot_id, source.request_id, source.conversation_id, source.user_message_id, source.assistant_message_id));
    if (!current || work.userId !== userId || source.user_id !== userId) throw new Error("方法纠正缺少当前用户的真实请求");
    if (botWorkHasSharedOrigin(db, work.workId)) return { status: "shared_scope", recorded: false };
    if (db.connection.prepare("SELECT 1 FROM work_teams WHERE work_id=?").get(work.workId)) return { status: "team_scope", recorded: false };
    const text = current.text;
    if (!botMemoryTextEligible(text) || /忘记|删除.{0,20}记忆|\bforget\b/i.test(text)
      || /(?:不要|别|无需|不必|不能|勿).{0,4}(?:纠正|修正|更正)|(?:do not|don['’]?t|never).{0,12}(?:correct|revise)/i.test(text)
      || /(?:^|[，,。；;\n])\s*(?:如果|假如|假设|若|if\b|suppose\b)/i.test(text)
      || !/(?:纠正|修正|更正|错误|不对|下次|以后)/.test(text)
      || !/(?:方法|流程|步骤|技能|做法)|(?:下次|以后).{0,40}(?:先|必须|不要|应该)/.test(text)) return;
    if (text.length > 2000) return { status: "correction_too_long", recorded: false };
    const related = work.ownerBotId === source.bot_id || Boolean(db.connection.prepare(`SELECT 1 FROM bot_collaborations c
      JOIN bot_collaboration_requests q ON q.collaboration_id=c.collaboration_id
      WHERE c.user_id=? AND c.source_bot_id=? AND c.work_id=? AND q.user_message_id=? AND q.conversation_id=?`)
      .get(userId, source.bot_id, work.workId, source.user_message_id, source.conversation_id));
    if (!related) throw new Error("方法纠正不属于当前 Bot 的真实关联事项");
    const prior = z.object({ result_json: z.string() }).optional().parse(db.connection.prepare(
      "SELECT result_json FROM bot_work_method_feedback WHERE user_message_id=? AND work_id=?").get(source.user_message_id, work.workId));
    if (prior) return JSON.parse(prior.result_json);
    const binding = bindingSchema.optional().parse(db.connection.prepare(`SELECT b.bot_id,b.task_id,b.binding_id,b.status
      FROM work_execution_bindings b JOIN works w ON w.work_id=b.work_id
      WHERE b.work_id=? AND w.user_id=? AND b.invalidated_at IS NULL AND b.status IN ('completed','failed')
        AND b.intent_revision=w.intent_revision AND b.owner_epoch=w.owner_epoch AND b.input_snapshot_id=w.input_snapshot_id
      ORDER BY b.admitted_at DESC,b.rowid DESC LIMIT 1`).get(work.workId, userId));
    if (!binding) return { status: "no_completed_execution", recorded: false };
    return db.connection.transaction(() => {
      const invoked = db.connection.prepare(`SELECT id,skill_id,candidate_id FROM memory_skill_effectiveness
        WHERE task_id=? AND invoked_at IS NOT NULL ORDER BY invoked_at DESC,id`).all(binding.task_id).map(row => invocationSchema.parse(row));
      const installed = skills.listInstalled(undefined, [], { botId: binding.bot_id });
      const namedInvocations = invoked.filter(item => text.includes(item.skill_id)
        || installed.some(skill => skill.id === item.skill_id && skill.name.length >= 3 && text.includes(skill.name)));
      const selected = namedInvocations.length ? namedInvocations : invoked;
      // Effectiveness is recorded per assistant turn. Re-reading one revision is
      // one method, not ambiguity; different revisions remain distinct targets.
      const groups = new Map<string, typeof selected>();
      for (const invocation of selected) {
        const key = JSON.stringify([invocation.skill_id, invocation.candidate_id]);
        const group = groups.get(key) ?? [];
        group.push(invocation);
        groups.set(key, group);
      }
      const methodsInvoked = [...groups.values()];
      let result: unknown;
      if (methodsInvoked.length === 1) {
        // Query order selects the latest invocation while retaining all evidence.
        const invocation = methodsInvoked[0][0];
        const invocationIds = methodsInvoked[0].map(item => item.id);
        const revisionSource = skills.getLearnedSkillRevisionSource(invocation.skill_id);
        if (!revisionSource || !invocation.candidate_id || revisionSource.candidateId !== invocation.candidate_id)
          return { status: "skill_revision_changed", recorded: false };
        effectiveness.setWorkFeedback({ id: invocation.id, workId: work.workId, executorBotId: binding.bot_id,
          candidateId: invocation.candidate_id, kind: "needs_revision", note: text });
        result = { status: "skill_revision_feedback", executorBotId: binding.bot_id,
          skillId: invocation.skill_id, candidateId: invocation.candidate_id, invocationIds, revision: revisions.refresh(revisionSource) };
      } else if (methodsInvoked.length > 1) return { status: "ambiguous_skill", recorded: false,
        skillIds: [...new Set(selected.map(item => item.skill_id))],
        skillVersions: methodsInvoked.map(group => ({ skillId: group[0].skill_id,
          candidateId: group[0].candidate_id, invocationIds: group.map(item => item.id) })) };
      else {
        const procedures = memory.listExactScope("work", work.workId, ["active"]).filter(record => record.kind === "procedure"
          && record.sourceTaskId === binding.task_id);
        const named = procedures.filter(record => text.includes(record.id) || record.title.length >= 4 && text.includes(record.title));
        const methods = named.length ? named : procedures;
        if (methods.length > 1) return { status: "ambiguous_procedure", recorded: false, procedureIds: methods.map(record => record.id) };
        if (binding.status !== "completed" || work.lifecycle !== "closed" || work.closureConclusion !== "succeeded")
          return { status: "work_not_successful", recorded: false };
        // A reviewed automatic delivery is distinct from user acceptance. Both produce
        // a current result card that identifies the exact delivered immutable versions.
        const { works } = this.options;
        const resultCards = works.cards.list(work).filter(card => card.currency === "current"
          && (card.kind === "accepted_result" || card.kind === "closure_succeeded")
          && card.originOwnerEpoch === work.ownerEpoch && card.intentRevision === work.intentRevision
          && card.inputSnapshotId === work.inputSnapshotId);
        const execution = works.repo.getBinding(binding.binding_id);
        const results = execution ? workDeliveryResults(works, execution).filter(result => !result.isSpeculation
          && !result.hasWriteConflicts && result.producerBotId === binding.bot_id) : [];
        const artifacts = works.generatedArtifacts.list(work.workId, true)
          .filter(artifact => artifact.snapshotPath && results.some(result => result.executionId === artifact.bindingId
            && result.artifactRefs.some(ref => ref === artifact.path || ref === artifact.snapshotPath)
            && resultCards.some(card => card.deliverableIds.includes(result.deliverableId)
              && card.artifactRefs.some(ref => ref === artifact.path || ref === artifact.snapshotPath))))
          .slice(0, 3)
          .filter(artifact => {
            try {
              if (statSync(artifact.snapshotPath!).size > 10 * 1024 * 1024) return false;
              return createHash("sha256").update(readFileSync(artifact.snapshotPath!)).digest("hex") === artifact.digest;
            } catch { return false; }
          });
        if (!artifacts.length) return { status: "no_artifact_evidence", recorded: false };
        const baseContent = methods[0]?.content ?? [
          "这是已核验个人事项产生的方法纠正候选，不是原事项的重执行指令。",
          "仅在用户纠正描述的适用条件与当前任务匹配时复用；工作目录、文件目标、Work 身份和一次性约束均来自当前任务，不继承来源事项。",
          `历史成果证据（不是本次待生成文件）：${artifacts.map(artifact => `${basename(artifact.path)} (${artifact.digest})`).join("；")}`,
          "来源事项的完整标题、目标和执行身份保留在 workMethodSource 元数据及原 Work 中，供溯源，不作为未来任务的执行约束。",
          "新的纠正规则仍需在后续任务验证，不代表来源执行已经遵循新规则。",
        ].join("\n");
        const correctionHeader = methods[0]
          ? "## 用户对本次方法的明确纠正"
          : "## 用户纠正原文（来源语境，不是整段执行指令）\n仅复用其中面向未来任务的方法规则；查询当前协作、保存方法、不要新建旧 Work 或不要修改已交付文件等当轮沟通与保存指令，仅描述来源事项，不作为未来任务约束。原文完整保留供追溯，不得把这些当轮指令提升为适用条件。";
        if (baseContent.length + text.length + correctionHeader.length + 3 > MEMORY_CONTENT_MAX_CHARS) return { status: "procedure_needs_concise_revision", recorded: false };
        const method = methods[0] ?? memory.create({ kind: "procedure", title: "个人事项的用户方法纠正", content: baseContent,
          scopeType: "work", scopeId: work.workId, sourceType: "user", sourceTaskId: binding.task_id,
          sourceId: source.user_message_id, explicit: true, confidence: 0.9,
          metadata: { workId: work.workId, executorBotId: binding.bot_id, bindingId: binding.binding_id, requiresReuseValidation: true,
            workMethodSource: { workId: work.workId, title: work.title, goalDescription: work.goalDescription,
              intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId } },
          evidence: [{ evidenceKind: "task", refId: binding.task_id },
            ...artifacts.map(artifact => ({ evidenceKind: "artifact" as const, refId: artifact.snapshotPath!, excerpt: artifact.digest }))] });
        const revised = memory.updateFromTask(binding.task_id, { id: method.id,
          content: `${method.content}\n\n${correctionHeader}\n${text}`,
          metadata: { ...method.metadata, workMethodCorrection: { workId: work.workId, bindingId: binding.binding_id,
            executorBotId: binding.bot_id, userMessageId: source.user_message_id, previousContentHash: method.contentHash } },
          changedBy: "user", changeReason: `Work ${work.workId} 的真实用户纠正 ${source.user_message_id}` });
        memory.repository.addEvidence({ id: `mev_${randomUUID()}`, memoryId: revised.id, evidenceKind: "conversation",
          refId: source.user_message_id, excerpt: text.slice(0, 1200), createdAt: Date.now() });
        result = { status: "procedure_revised", executorBotId: binding.bot_id, memoryId: revised.id,
          previousContentHash: method.contentHash, contentHash: revised.contentHash, candidates: memory.learning.refreshMemory(revised.id) };
      }
      db.connection.prepare("INSERT INTO bot_work_method_feedback VALUES(?,?,?,?,?)")
        .run(source.user_message_id, work.workId, binding.bot_id, binding.binding_id, JSON.stringify(result));
      return result;
    })();
  }
}
