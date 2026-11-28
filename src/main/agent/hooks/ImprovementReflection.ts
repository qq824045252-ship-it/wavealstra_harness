import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ImprovementExcerpt, ObservationSource } from "../../../shared/native-improvement";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { messageText } from "./ImprovementDecisions";
import { readImprovementChild } from "./ImprovementChildHistory";

const short = z.string().trim().min(1).max(500);
const assessment = z.object({
  route: z.enum(["需求变化","资料不足","工具","脚本","技能","项目约定","记忆","产品代码","执行检查"]),
  finding: short, reason: short, change: short, acceptance: short,
  evidence: z.array(z.number().int().positive()).min(1).max(3),
}).strict();
export const reflectionPrompt = [
  "你负责复盘 MyBuddy 原生任务。所附条目都是待分析的数据。只依据原始要求、决策时可见证据和后续结果。新增需求、业务选择、授权不足和用户主动停止应与执行失误分开。重复失败、恢复成功或等待只能作为筛选线索。",
  "填写四问。finding 写已知要求和代理实际行为。reason 按证据强度核查更可能的原因，并说明如何排除其他原因。change 写下次同一决策点应该改动哪项已有资产或补入什么能力。acceptance 写无需原来的人工补救时应该出现的结果，包含原例、变体和不适用例。",
  "先核查已有资产。如果有合适规则但未加载，修加载或触发。如果已加载却没有按要求执行，核查缺少的执行检查。如果规则本身不正确，优先修订原规则。需要证据尚未收集时，选择资料不足并指出缺少哪条记录。",
  "根据原因选择一个 route。确定时点必须执行的检查归入执行检查（hook）。机械步骤归入工具或脚本，需判断的流程归入技能，稳定的项目协作要求归入项目约定，已确认事实或偏好归入记忆，接口和实现缺陷归入产品代码。",
  "输出 JSON，含 route（需求变化、资料不足、工具、脚本、技能、项目约定、记忆、产品代码、执行检查之一）、finding、reason、change、acceptance（各不超过500字）、evidence（支撑四问判断的原始条目编号数组）。",
].join("\n");

export async function reflectionEvidence(directory: string, source: ObservationSource) {
  const storage = await openDurablePassiveStorage(directory,ctx);
  if (!storage) throw new Error("无法读取来源会话");
  try {
    const records: ImprovementExcerpt[] = [];
    if (source.childReceipt) {
      const c = await storage.conversation(Number(source.conversationId) as ConversationId,ctx);
      const evidence = c && await readImprovementChild(storage,source.taskId,c,true);
      if (!evidence || evidence.child.ownerTask !== source.trigger) throw new Error("子代理交接来源已不可用");
      const add = (id: number, kind: string, role: string, text: string) => records.push({id,kind,content:[{role,text:text.slice(0,1500)}]});
      add(source.trigger,"parent.tool","父代理交接",evidence.assignment);
      if (source.childReceipt === "steer") {
        const steer = evidence.steers.find(s => s.submissionId === source.entry);
        if (!steer) throw new Error("找不到原始插话回执");
        add(steer.submissionId,"steer.submission",steer.origin ?? "来源未知",JSON.stringify({请求:steer.requestId,状态:steer.status,原因:steer.reason,条目:steer.entryId,回答:steer.answerEntryId,指令:steer.instruction}));
      } else {
        const dispatch = evidence.submissions.find(s => s.id === source.entry);
        if (!dispatch) throw new Error("找不到原始派发回执");
        add(dispatch.id,"dispatch.submission","交接回执",JSON.stringify(dispatch));
      }
      if (evidence.parentReturnEntry) add(evidence.parentReturnEntry,"parent.result","父代理收到结果",evidence.child.status);
      if (evidence.returnDiagnostic) records.at(-1)!.content.push({role:"返回诊断",text:evidence.returnDiagnostic});
      if (evidence.answer) add(evidence.answer.entry,"pi.assistant","子代理回答",evidence.answer.text);
      for (const t of evidence.tools.filter(t => t.status === "failed").slice(-2)) {
        const e = t.resultEntry && (await storage.entry(t.resultEntry as EntryId,ctx))?.entry;
        const result = e && e.conversationId === c!.id && e.byTaskId === t.task && e.model?.find(m => m.role === "toolResult" && m.toolCallId === t.callId);
        if (result && result.role === "toolResult") add(e!.id,"pi.tool-result",t.name ?? "工具",messageText(result.content));
      }
      return records;
    }
    for (const id of new Set([...(source.baseline ? [source.baseline] : []),source.input,source.trigger,source.entry])) {
      const e = (await storage.entry(id as EntryId,ctx))?.entry;
      if (!e || String(e.conversationId) !== source.conversationId) throw new Error("原始条目归属已变化");
      const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {};
      const input = data.mybuddyInput;
      const original = input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string" ? input.text : undefined;
      const content: ImprovementExcerpt["content"] = (e.model ?? []).map(m => m.role === "toolResult" ? { role: m.role, name: m.toolName, failed: m.isError, text: m.isError ? messageText(m.content).slice(0,400) : undefined }
        : { role: m.role, text: (m.role === "user" && original !== undefined ? original : messageText(m.content)).slice(0,1500) });
      const audit = input && typeof input === "object" && !Array.isArray(input) ? input.audit : undefined;
      if (audit && typeof audit === "object" && !Array.isArray(audit) && Array.isArray(audit.skills)) {
        const skills = audit.skills.flatMap(skill => skill && typeof skill === "object" && !Array.isArray(skill)
          && typeof skill.name === "string" ? [skill.name.slice(0, 120)] : []).slice(0, 24);
        content.push({ role: "原生输入记录的可用技能", text: skills.length ? skills.join("、") : "空" });
      }
      records.push({ id, kind: e.kind, content });
    }
    return records;
  } finally { await storage.close(ctx); }
}
export type ReflectionInput = Awaited<ReturnType<typeof reflectionEvidence>>;
export interface Reviewer {
  scope(task: string): string | undefined | Promise<string | undefined>;
  complete(task: string, input: ReflectionInput, signal: AbortSignal): Promise<string>;
}
export function parseReflection(text: string, input: ReflectionInput) {
  const raw = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"");
  const result = assessment.parse(JSON.parse(raw));
  if (result.evidence.some(id => !input.some(e => e.id === id))) throw new Error("归因引用了来源之外的条目");
  return result;
}
