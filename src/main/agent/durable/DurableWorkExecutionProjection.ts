import { z } from "zod";
import { isAbsolute,resolve } from "node:path";
import type { Cursor, EntryRecord, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import type { WorkExecutionObservation } from "../work/WorkExecutionAdapter";
import { DurableHistoryProjection, durableContentText } from "./DurableHistoryProjection";
import type { WorkSubitemResult } from "../../../shared/bot-work-phase3";

/**
 * Read the accepted input-to-answer span from its original persisted conversation.
 * Pi may settle several steered inputs with one answer; this span is shared run
 * evidence, not exclusive causal attribution to an input. The Work admission
 * gate rejects new business operation IDs on a bound execution task.
 */
export async function readDurableWorkExecution(
  tx: Pick<Tx, "scanEntries">,
  record: SubmissionRecord,
  workspaceBinding?:string,
): Promise<WorkExecutionObservation> {
  if (record.status === "queued" || record.status === "placed") return { status: "running" };
  if (record.status === "unanswered") {
    const partial = new DurableHistoryProjection();
    let usageTokens = 0;
    let cursor: Cursor | undefined;
    let reported = false;
    let nextInput = false;
    if (record.type === "input" && record.entry !== undefined) do {
      const page = await tx.scanEntries({ conversationId: record.conversationId, minEntryId: record.entry, order: "ascending" }, 200, cursor);
      partial.merge(page.items, new Map(), {});
      for (const entry of page.items) {
        if (entry.id !== record.entry && entry.model?.some(message => message.role === "user")) { nextInput = true; break; }
        for (const message of entry.model ?? []) if (message.role === "assistant") {
          reported = true; usageTokens += message.usage.totalTokens;
        }
      }
      cursor = page.next;
    } while (cursor && !nextInput);
    const subitems=partial.messages.flatMap(message => (message.tools ?? []).flatMap(tool => tool.detail ? readNativeSubitems(tool.id,tool.detail) : []));
    return { status: record.reason === "aborted" ? "stopped" : "failed",
      summary: typeof record.detail === "string" ? record.detail : record.reason, hasWriteConflicts: false, artifactRefs: [],
      // An interrupted provider may have unreported spend. Never call that zero.
      usageTokens: reported && record.reason !== "aborted" ? usageTokens : undefined,
      ...(subitems.length ? {subitems} : {}) };
  }
  if (record.type !== "input" || record.status !== "done" || record.answer === undefined) {
    throw new Error("原生回执不是已结束的业务输入");
  }
  const projection = new DurableHistoryProjection();
  let answerEntry: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  let usageTokens = 0;
  const fileCalls=new Map<string,{name:string;path:string}>(),successfulReads=new Set<string>(),producedArtifacts=new Set<string>();
  do {
    const page = await tx.scanEntries({ conversationId: record.conversationId,
      minEntryId: record.entry, maxEntryId: record.answer, order: "ascending" }, 200, cursor);
    projection.merge(page.items, new Map(), {});
    for(const entry of page.items)for(const message of entry.model ?? []) {
      if(message.role==="assistant")for(const block of message.content) {
        if(block.type==="toolCall" && ["read","write","edit"].includes(block.name) && typeof block.arguments.path==="string" && (workspaceBinding || isAbsolute(block.arguments.path)))
          fileCalls.set(block.id,{name:block.name,path:resolve(workspaceBinding ?? "",block.arguments.path)});
      }
      if(message.role==="toolResult") {
        const call=fileCalls.get(message.toolCallId);
        if(call && message.toolName===call.name && !message.isError) {
          if(call.name==="read")successfulReads.add(call.path);else producedArtifacts.add(call.path);
        }
        if(!message.isError) {
          const artifacts=z.object({artifactRefs:z.array(z.string())}).safeParse(message.details);
          if(artifacts.success)for(const path of artifacts.data.artifactRefs)producedArtifacts.add(workspaceBinding?resolve(workspaceBinding,path):path);
        }
        fileCalls.delete(message.toolCallId);
      }
    }
    usageTokens += page.items.reduce((sum, entry) => sum + (entry.model ?? []).reduce((tokens, message) =>
      tokens + (message.role === "assistant" ? message.usage.totalTokens : 0), 0), 0);
    answerEntry ??= page.items.find(entry => entry.id === record.answer);
    cursor = page.next;
  } while (cursor);
  const answer = answerEntry?.model?.find(message => message.role === "assistant");
  const subitems=projection.messages.flatMap(message => (message.tools ?? []).flatMap(tool => tool.detail ? readNativeSubitems(tool.id, tool.detail) : []));
  const readPaths=[...successfulReads];
  return {
    sourceEntryId: record.answer,
    usageTokens,
    status: !answer || ["error", "length"].includes(answer.stopReason) ? "failed" : answer.stopReason === "aborted" ? "stopped" : "completed",
    summary: answer ? durableContentText(answer.content) : "原生输入未产生可核对的成果",
    hasWriteConflicts: projection.messages.some(message => message.tools?.some(tool => nativeWriteConflicts(tool.detail))),
    artifactRefs: [...new Set([...producedArtifacts,...projection.messages.flatMap(message => (message.artifacts ?? [])
      .flatMap(artifact => artifact.path ? [artifact.path] : []))])],
    ...(subitems.length ? {subitems} : {}),
    ...(readPaths.length?{readPaths}:{}),
  };
}

const nativePlanSchema = z.object({ itemId: z.string(), task: z.string(), required: z.boolean().optional(), dependencies: z.array(z.string()).optional(),
  criterionIds: z.array(z.string()).optional(), isolation: z.enum(["shared","worktree"]).nullable().optional() });
const nativeResultSchema = z.object({ subagentId: z.string(), status: z.string(), exitCode: z.number(), task: z.string().optional(), rejected: z.boolean().optional(),
  writeConflicts: z.array(z.string()).optional(), errorMessage: z.string().optional(), stderr: z.string().optional(), stopReason: z.string().optional(),
  nativeConversationId: z.union([z.string(),z.number()]).optional(), artifactRefs: z.array(z.string()).optional(),
  workspace: z.object({ cwd:z.string(), kind:z.enum(["shared","worktree"]) }).optional(),
  messages: z.array(z.object({ role:z.string(), content:z.array(z.object({ type:z.string(),text:z.string().optional() }).passthrough()) }).passthrough()).optional() });

/** Read structured native plan/results, including rejected and chain items never started. */
export function readNativeSubitems(toolId: string, detail: string): WorkSubitemResult[] {
  let value: z.infer<ReturnType<typeof z.json>>;
  try { value = z.json().parse(JSON.parse(detail)); } catch { return []; }
  const output: WorkSubitemResult[] = [];
  const visit = (node: typeof value, path: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((item,index) => visit(item,`${path}/${index}`)); return; }
    const results = Array.isArray(node.results) ? node.results.flatMap(item => { const result=nativeResultSchema.safeParse(item); return result.success?[result.data]:[]; }) : [];
    const plans = Array.isArray(node.plan) ? node.plan.flatMap(item => { const plan=nativePlanSchema.safeParse(item); return plan.success?[plan.data]:[]; }) : [];
    if (plans.length || results.length) {
      const items = plans.length ? plans : results.map(result => ({ itemId:result.subagentId,task:result.task ?? "",required:true,dependencies:[],criterionIds:[],isolation:result.workspace?.kind }));
      for (const plan of items) {
        const result = results.find(result => result.subagentId===plan.itemId);
        const conflicts = result?.writeConflicts ?? [];
        const outcome: WorkSubitemResult["outcome"] = !result ? "not_started" : result.rejected ? "rejected" : ["cancelled","interrupted","timedout"].includes(result.status) || result.stopReason==="aborted" ? "stopped"
          : result.status==="running" ? "unknown" : result.exitCode!==0 || result.stopReason==="error" ? "failed" : conflicts.length ? "blocked" : "completed";
        const prefix = `${toolId}${path}:`;
        output.push({ itemId:`${prefix}${plan.itemId}`,task:plan.task,required:plan.required ?? true,
          dependencies:(plan.dependencies ?? []).map(id => `${prefix}${id}`),criterionIds:plan.criterionIds ?? [],nativeStatus:result?.status ?? "not_started",outcome,
          childId:result?.rejected?undefined:result?.subagentId,childConversationId:result?.nativeConversationId===undefined?undefined:String(result.nativeConversationId),
          workspaceBinding:result?.workspace?.cwd,artifactRefs:result ? nativeArtifacts(result) : [],writeConflicts:conflicts,
          summary:result?.errorMessage || result?.messages?.filter(message => message.role==="assistant").at(-1)?.content.flatMap(block => block.type==="text"&&block.text?[block.text]:[]).join("\n") || result?.stderr || plan.task,
          isolation:result?.workspace?.kind ?? plan.isolation ?? undefined });
      }
      return;
    }
    for (const [key,child] of Object.entries(node)) visit(child,`${path}/${key}`);
  };
  visit(value,"");
  return output;
}

function nativeArtifacts(result:z.infer<typeof nativeResultSchema>):string[] {
  const artifacts=[...result.artifactRefs ?? []];
  for(const message of result.messages ?? []) {
    if(message.role!=="toolResult" || message.isError===true) continue;
    const details=z.object({artifactRefs:z.array(z.string())}).safeParse(message.details);
    if(details.success) artifacts.push(...details.data.artifactRefs);
  }
  const successful=new Set((result.messages ?? []).flatMap(message => message.role==="toolResult" && message.isError!==true && typeof message.toolCallId==="string"?[message.toolCallId]:[]));
  for(const message of result.messages ?? []) for(const block of message.content) {
    if(block.type!=="toolCall" || !["write","edit"].includes(typeof block.name==="string"?block.name:"") || typeof block.id!=="string" || !successful.has(block.id)) continue;
    const args=z.object({path:z.string()}).safeParse(block.arguments);
    if(args.success && result.workspace?.cwd) artifacts.push(resolve(result.workspace.cwd,args.data.path));
  }
  return [...new Set(artifacts)];
}

function nativeWriteConflicts(detail: string | undefined): boolean {
  if (!detail) return false;
  try {
    const value = z.json().parse(JSON.parse(detail));
    const contains = (item: typeof value): boolean => {
      if (!item || typeof item !== "object") return false;
      if (Array.isArray(item)) return item.some(contains);
      if (Array.isArray(item.writeConflicts) && item.writeConflicts.length > 0) return true;
      return Object.values(item).some(contains);
    };
    return contains(value);
  } catch { return false; }
}
