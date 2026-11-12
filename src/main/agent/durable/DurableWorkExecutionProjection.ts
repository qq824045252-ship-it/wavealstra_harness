import { collectRuntimeMaterialEvidence } from "../RuntimeMaterialEvidence";
import { durableRegisteredArtifact } from "./DurableArtifactRegistration";
import type { GeneratedArtifact } from "../../../shared/bot-work-phase3";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, SubmissionRecord, TaskId } from "@earendil-works/pi-durable";
import { recoverMissingSubitems, type DurableWorkReadTx } from "./DurableMissingSubitems";
import type { WorkExecutionObservation } from "../work/WorkExecutionAdapter";
import { DurableHistoryProjection, durableContentText } from "./DurableHistoryProjection";
import type { WorkSubitemResult } from "../../../shared/bot-work-phase3";

/** Read only this input's persisted evidence, before the next user input. */
export async function readDurableWorkExecution(
  tx: DurableWorkReadTx,
  record: SubmissionRecord,
  workspaceBinding?: string,
  durableStoreKey?: string,
): Promise<WorkExecutionObservation> {
  if (record.type !== "input") throw new Error("原生回执不是已结束的业务输入");
  const evidence = await scanExecutionEvidence(tx, record, workspaceBinding, durableStoreKey);
  if (record.status === "queued" || record.status === "placed") {
    const subitems = inFlightSubitems(evidence.projection);
    return { status: "running",
      ...(evidence.generatedArtifacts.length ? { generatedArtifacts: evidence.generatedArtifacts } : {}),
      ...(subitems.length ? { subitems } : {}) };
  }
  const answer = evidence.answer;
  const status = record.status === "unanswered" ? record.reason === "aborted" ? "stopped" : "failed"
    : !answer || ["error", "length"].includes(answer.stopReason) ? "failed"
      : answer.stopReason === "aborted" ? "stopped" : "completed";
  const failureReason = status === "completed" ? undefined : record.status === "unanswered"
    ? (typeof record.detail === "string" && record.detail.trim() ? record.detail : record.reason)
    : answer?.errorMessage || (answer?.stopReason === "length" ? "原生输出达到长度限制"
      : answer?.stopReason === "aborted" ? "原生执行已停止" : "原生输入未产生可核对的成果");
  // Provider errors and tool-use narration are not deliverables. Retain actual
  // response content independently, even if a later generation failed or stopped.
  const summary = evidence.responses.filter(response => response.text !== failureReason).at(-1)?.text ?? "";
  const subitems: WorkSubitemResult[] = [];
  for (const message of evidence.projection.messages) for (const tool of message.tools ?? []) if (tool.detail) {
    subitems.push(...await recoverMissingSubitems(tx, record.conversationId, evidence.toolOwners.get(tool.id),
      tool.id, readNativeSubitems(tool.id, tool.detail)));
  }
  return {
    status, summary, ...(evidence.generatedArtifacts.length ? { generatedArtifacts: evidence.generatedArtifacts } : {}),
    ...(failureReason ? { failureReason } : {}),
    sourceEntryId: record.status === "done" && answer ? record.answer : evidence.lastEntryId,
    // An interrupted provider may have unreported spend. Never call that zero.
    usageTokens: record.status === "unanswered" && (!evidence.reported || record.reason === "aborted") ? undefined : evidence.usageTokens,
    hasWriteConflicts: evidence.projection.messages.some(message => message.tools?.some(tool => nativeWriteConflicts(tool.detail))),
    artifactRefs: [...new Set([...evidence.artifacts, ...subitems.flatMap(item => item.artifactRefs)])],
    ...(subitems.length ? { subitems } : {}),
    ...(evidence.readEvidence.length ? { readEvidence: evidence.readEvidence } : {}),
    ...(evidence.readPaths.size ? { readPaths: [...evidence.readPaths] } : {}),
  };
}

const TERMINAL_SUBITEM_OUTCOMES: ReadonlySet<WorkSubitemResult["outcome"]> = new Set(["completed", "failed", "rejected", "blocked", "stopped"]);
const IN_FLIGHT_SUBITEM_LIMIT = 40;

/** Bounded in-flight progress for still-queued inputs. Stable itemIds make a
 * repeated poll the same fact instead of a new milestone. Candidate details are
 * pre-filtered so polling re-parses only plan/result payloads, not every tool. */
function inFlightSubitems(projection: DurableHistoryProjection): WorkSubitemResult[] {
  const latest = new Map<string, WorkSubitemResult>();
  for (const message of projection.messages) for (const tool of message.tools ?? []) {
    if (!tool.detail || !tool.detail.includes('"plan"') && !tool.detail.includes('"results"')) continue;
    for (const item of readNativeSubitems(tool.id, tool.detail)) {
      if (TERMINAL_SUBITEM_OUTCOMES.has(item.outcome)) latest.set(item.itemId, item);
    }
  }
  // Keep the newest window: older items were already persisted by an earlier poll,
  // while a fixed leading window would starve later completions of a long plan.
  return [...latest.values()].slice(-IN_FLIGHT_SUBITEM_LIMIT);
}

/** All terminal paths share the same crop, successful-tool checks and pagination. */
async function scanExecutionEvidence(tx: DurableWorkReadTx,
  record: Extract<SubmissionRecord, { type: "input" }>, workspaceBinding?: string, durableStoreKey?: string) {
  const projection = new DurableHistoryProjection();
  const readCalls = new Map<string, { name: string; args: unknown }>();
  const readEvidence: Array<{ toolCallId: string; toolName: string; at: number; kind: string; target: string; outputHash: string; partial: boolean; outputText?: string }> = [];
  const fileCalls = new Map<string, { name: string; path: string }>();
  const readPaths = new Set<string>(), artifacts = new Set<string>();
  const responses: Array<{ text: string }> = [];
  const generatedArtifacts: GeneratedArtifact[] = [];
  const toolOwners = new Map<string, TaskId>();
  let answer: AssistantMessage | undefined;
  let lastEntryId: number | undefined;
  let usageTokens = 0, reported = false;
  let cursor: Cursor | undefined;
  if (record.entry !== undefined) do {
    const page = await tx.scanEntries({ conversationId: record.conversationId, minEntryId: record.entry,
      ...(record.status === "done" ? { maxEntryId: record.answer } : {}), order: "ascending" }, 200, cursor);
    const nextInput = page.items.findIndex(entry => entry.id !== record.entry && entry.model?.some(message => message.role === "user"));
    // Crop BEFORE merging or extracting anything, including subitems and conflicts.
    const entries = nextInput < 0 ? page.items : page.items.slice(0, nextInput);
    projection.merge(entries, new Map(), {});
    for (const entry of entries) {
      const registered = durableRegisteredArtifact(entry, record.id, workspaceBinding, durableStoreKey);
      if (registered) {
        artifacts.add(registered.snapshotPath ?? registered.path);
        generatedArtifacts.push({ path: registered.path, digest: registered.digest, sizeBytes: registered.sizeBytes,
          registeredAt: registered.registeredAt, sourceEntryId: entry.id, ...(registered.snapshotPath ? { snapshotPath: registered.snapshotPath } : {}) });
      }
    }
    for (const entry of entries) for (const message of entry.model ?? []) {
      lastEntryId = entry.id;
      if (message.role === "assistant") {
        reported = true;
        usageTokens += message.usage.totalTokens;
        if (record.status === "done" && entry.id === record.answer) answer = message;
        const text = durableContentText(message.content).trim();
        if (text && message.stopReason !== "toolUse" && text !== message.errorMessage?.trim()) responses.push({ text });
        for (const block of message.content) {
          if (block.type === "toolCall" && ["read", "project_knowledge_read", "fetch_content"].includes(block.name))
            readCalls.set(block.id, { name: block.name, args: block.arguments });
          if (block.type === "toolCall" && ["read", "write", "edit"].includes(block.name)
            && typeof block.arguments.path === "string" && (workspaceBinding || isAbsolute(block.arguments.path)))
            fileCalls.set(block.id, { name: block.name, path: resolve(workspaceBinding ?? "", block.arguments.path) });
        }
      }
      if (message.role === "toolResult") {
        if (message.toolName === "subagent" && entry.byTaskId !== undefined) toolOwners.set(message.toolCallId, entry.byTaskId);
        const readCall = readCalls.get(message.toolCallId);
        if (readCall) {
          const materials = readCall.name === message.toolName ? collectRuntimeMaterialEvidence({
            toolCallId: message.toolCallId, toolName: message.toolName, args: readCall.args,
            result: message, isError: message.isError }, message.timestamp) : [];
          for (const item of materials) {
            const { toolCallId, toolName, at, kind, target, outputHash, partial } = item;
            const text = durableContentText(message.content);
            readEvidence.push({ toolCallId, toolName, at, kind, target, outputHash, partial,
              ...(text.length <= 16000 ? { outputText: text } : {}) });
          }
          // A later failed/empty/malformed read invalidates an earlier successful
          // read of the same source. Do not erase the last attempt from evidence.
          if (!materials.length) {
            const args = readCall.args as Record<string, unknown>;
            const target = args && (readCall.name === "read" ? args.path : readCall.name === "fetch_content" ? (args.url ?? (Array.isArray(args.urls) && args.urls.length === 1 ? args.urls[0] : undefined)) : args.id);
            if (typeof target === "string" && target) readEvidence.push({ toolCallId: message.toolCallId,
              toolName: readCall.name, at: message.timestamp, kind: readCall.name === "read" ? "file-content" : readCall.name === "fetch_content" ? "web-content" : "knowledge-content",
              target, outputHash: "", partial: true });
          }
        }
        readCalls.delete(message.toolCallId);
        const call = fileCalls.get(message.toolCallId);
        if (call && message.toolName === call.name && !message.isError) {
          if (call.name === "read") readPaths.add(call.path); else artifacts.add(call.path);
        }
        if (!message.isError) {
          const details = z.object({ artifactRefs: z.array(z.string()).optional(), imagePaths: z.array(z.string()).optional() }).safeParse(message.details);
          if (details.success) {
            for (const path of details.data.artifactRefs ?? []) artifacts.add(workspaceBinding ? resolve(workspaceBinding, path) : path);
            for (const path of details.data.imagePaths ?? []) artifacts.add(path);
          }
        }
        fileCalls.delete(message.toolCallId);
      }
    }
    if (nextInput >= 0) break;
    cursor = page.next;
  } while (cursor);
  // A registered immutable version replaces the mutable source path in delivery.
  for (const artifact of generatedArtifacts) if (artifact.snapshotPath) artifacts.delete(artifact.path);
  return { projection, readEvidence, readPaths, artifacts, generatedArtifacts, responses, answer, lastEntryId, usageTokens, reported, toolOwners };
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
