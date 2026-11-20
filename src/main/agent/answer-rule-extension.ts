import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnswerRule, AnswerRuleMemoryReview, AnswerRuleReviewInput } from "../../shared/answer-routing";
import type { AnswerRoutingService } from "./AnswerRoutingService";

const text = Type.String({ minLength: 1, maxLength: 2000 });
const terms = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 24 });
const version = Type.Object({ id: Type.String(), revision: Type.Integer({ minimum: 1 }) });
const scope = Type.Union([Type.Literal("project"), Type.Literal("global")]);
const draft = Type.Object({ title: Type.String({ maxLength: 90 }), instruction: text, include: terms, exclude: terms });

function describe(rule: AnswerRule) {
  return { id: rule.id, revision: rule.revision, title: rule.title, scope: rule.projectId ? "project" : "global",
    enabled: rule.enabled, include: rule.include, exclude: rule.exclude, instruction: rule.instruction,
    evidenceFile: rule.evidenceFile, evidenceLibraryItemId: rule.evidenceLibraryItemId,
    evidenceFailure: rule.evidenceFailure, linkedMemory: !!rule.sourceMemoryId };
}

async function result(run: () => unknown) {
  try {
    const value = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: error }], details: { error }, isError: true };
  }
}

export function createAnswerRuleExtension(taskId: string, service: AnswerRoutingService,
  review: (input: AnswerRuleReviewInput, taskId: string) => Promise<AnswerRuleMemoryReview>): ExtensionFactory {
  const preview = (question: string) => {
    const hit = service.preview(question, service.taskScope(taskId), taskId);
    return hit ? { id: hit.rule.id, revision: hit.rule.revision, title: hit.rule.title, matchedPhrase: hit.phrase } : null;
  };
  return pi => {
    pi.registerTool({
      name: "answer_rule_list", label: "查看回答规则",
      description: "查找当前项目和全局可用的回答调度规则（含停用规则）。修改或停用前读取当前 id 和 revision；查不到时可省略 query 分页查看。",
      parameters: Type.Object({ query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (_id, { query, offset = 0 }) => result(() => {
        const needle = query?.trim().toLowerCase();
        const rules = service.rulesForTask(taskId).filter(rule => !needle || [rule.title, rule.instruction, ...rule.include, ...rule.exclude]
          .some(str => str.toLowerCase().includes(needle)));
        return { rules: rules.slice(offset, offset + 12).map(describe), total: rules.length,
          nextOffset: offset + 12 < rules.length ? offset + 12 : null };
      }),
    });
    pi.registerTool({
      name: "answer_rule_save", label: "保存回答规则",
      description: "用户要求创建、修改、启用或停用回答调度规则时调用。新建传 title、instruction、include。修改传 version 和需改的字段。项目对话默认只改本项目，全局修改显式传 global。采用提炼稿时传 independent:true。testQuestion 可在保存后验证实际命中的规则。",
      parameters: Type.Object({ version: Type.Optional(version), scope: Type.Optional(scope), testQuestion: Type.Optional(text),
        independent: Type.Optional(Type.Literal(true)),
        changes: Type.Partial(Type.Object({ ...draft.properties, enabled: Type.Boolean(),
          evidenceFile: Type.String(), evidenceLibraryItemId: Type.Union([Type.String(), Type.Null()]),
          evidenceFailure: Type.Union([Type.Literal("mark-unverified"), Type.Literal("verify")]) })) }),
      execute: async (_id, { testQuestion, ...input }) => result(() => {
        const saved = describe(service.saveForTask(taskId, input));
        return { saved, ...(testQuestion ? { question: testQuestion, matched: preview(testQuestion) } : {}) };
      }),
    });
    pi.registerTool({
      name: "answer_rule_test", label: "测试规则匹配",
      description: "测试一句普通问法在当前项目实际会命中哪条已保存规则。仅执行匹配，不读取资料或生成回答。",
      parameters: Type.Object({ question: text }),
      execute: async (_id, { question }) => result(() => ({ question, matched: preview(question) })),
    });
    pi.registerTool({
      name: "answer_rule_distill", label: "回答规则 · AI 去重并提炼",
      description: "用户要求去重、合并或提炼回答调度时，传已保存规则的 ruleId 或完整 draft，二选一。综合草稿和相关全局记忆，返回一份提炼稿、采用来源与分歧。此步骤只预览；用户要求保存时再调用 answer_rule_save，仅采用相容内容。",
      parameters: Type.Object({ ruleId: Type.Optional(Type.String()), draft: Type.Optional(draft) }),
      execute: async (_id, params) => result(async () => {
        if (!!params.ruleId === !!params.draft) throw new Error("请选择一条已保存规则，或提供一份草稿。");
        const project = service.taskScope(taskId);
        const current = params.ruleId ? service.rulesForTask(taskId).find(rule => rule.id === params.ruleId) : undefined;
        const input = current ?? params.draft;
        if (!input) throw new Error("当前对话找不到这条规则。");
        const reviewed = await review(input, taskId);
        if (service.taskScope(taskId) !== project || (current && !service.rulesForTask(taskId)
          .some(rule => rule.id === current.id && rule.revision === current.revision))) throw new Error("提炼期间规则或项目已变化，请重试。");
        if (!reviewed.distillation) throw new Error("模型未生成提炼稿，请重新提炼。");
        return { version: current && { id: current.id, revision: current.revision }, checked: reviewed.checked,
          proposal: reviewed.distillation, saved: false };
      }),
    });
  };
}
