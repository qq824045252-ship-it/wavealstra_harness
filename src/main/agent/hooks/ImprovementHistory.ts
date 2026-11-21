import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { ImprovementChild, ImprovementKind, ObservationSource } from "../../../shared/native-improvement";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { DurableSubagentIdentity } from "../durable/DurableSubagentIdentity";
import { DurableConsultIdentity } from "../durable/DurableConsultSession";
import { STEER_ENTRY_KIND } from "../durable/DurableSteerReceipts";
import { deliveryCorrection, parseDeliveryContract, type DeliveryContract } from "./DeliveryContract";
import { readImprovementChild } from "./ImprovementChildHistory";
import { missingFile, readMapping } from "./ReadRecoveryHints";
import { asksHandoff, asksProgress, claimsDelivery, fingerprint, messageText, nestedReadbackTools, reportsBlocker, requestFeatures, requirementTopics, sameRead, scopeCorrection, type ReadResult } from "./ImprovementDecisions";

const analysisVersion = 2;
interface ToolObservation extends ReadResult { tool: string; entry: number; elapsed: number }

export interface HistoryState {
  analysisVersion?: number;
  last: number; input: number; features: ReturnType<typeof requestFeatures>; hasPriorAnswer: boolean; project?: string; workspace?: string;
  requirements?: string[]; baseline?: number;
  lastAction?: number;
  answer?: { id: number; handoff: boolean; generation: number; claimed?: boolean; blocked?: boolean }; count: number;
  cwd?: string; call?: { id: string; args: string; path?: string; tool: string; target: boolean; entry: number; at: number };
  read?: ReadResult & { entry: number; missing?: string }; readback: "none" | "written" | "verified"; write?: number;
  delivery?: { contract: DeliveryContract; input: number; wrote: boolean };
  progress?: { entry: number; at: number };
  success?: boolean;
  tools?: ToolObservation[];
}
export const freshHistory = (): HistoryState => ({ analysisVersion, last: 0, input: 0, features: requestFeatures(""),
  hasPriorAnswer: false, count: 0, readback: "none", delivery: undefined, progress: undefined, success: false, tools: [] });
export interface Observation { kind: ImprovementKind; source: ObservationSource; replay: Record<string, boolean | string>; priorGeneration?: number; project?: string; workspace?: string }
export type HistoryIdentity = Omit<ObservationSource, "entry" | "trigger" | "input" | "at" | "baseline">;
export interface ImprovementInput { entry: number; at: number; contract: boolean; project?:string;workspace?:string }
function object(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

const mechanicalRead = new Set(["read", "list", "grep", "glob", "ls", "find"]);

function toolPattern(tools: ToolObservation[]): { kind: "oscillation" | "sequence"; first: ToolObservation; pattern: string } | undefined {
  if (tools.length === 4) {
    const [a, b, c, d] = tools;
    if (a.tool === b.tool && b.tool === c.tool && c.tool === d.tool && a.args !== b.args
      && a.error && b.error && sameRead(a, c) && sameRead(b, d)) {
      return { kind: "oscillation", first: a, pattern: fingerprint([a.tool, [a.result, b.result].sort()]) };
    }
  }
  const recent = tools.slice(-3);
  if (recent.length === 3 && recent.every(item => !item.error && mechanicalRead.has(item.tool))
    && new Set(recent.map(item => item.tool)).size > 1 && recent.reduce((total, item) => total + item.elapsed, 0) >= 2_000) {
    return { kind: "sequence", first: recent[0], pattern: fingerprint(recent.map(item => item.tool)) };
  }
}

function consume(state: HistoryState, entry: EntryRecord, identity: HistoryIdentity, submitted: Set<number>,
  observations: Observation[], inputs: ImprovementInput[]) {
  const data = object(entry.data);
  if (data.mybuddyImported || data.inherited || String(entry.conversationId) !== identity.conversationId) return;
  const metadata = object(data.mybuddyInput);
  const emit = (kind: ImprovementKind, trigger: number, at: number, replay: Observation["replay"] = {}, priorGeneration?: number,
    input = state.input, baseline = kind === "scope" ? state.baseline : undefined) =>
    observations.push({ kind, source: { ...identity, entry: entry.id, trigger, input, at,
      ...(baseline ? { baseline } : {}) }, replay, priorGeneration, project: state.project, workspace: state.workspace });
  if (entry.kind === "pi.reset") { Object.assign(state, freshHistory(), { answer: undefined, read: undefined, call: undefined, lastAction:undefined }); return; }
  for (const m of entry.model ?? []) {
    if (m.role === "user") {
      if (entry.kind !== "mybuddy.user" && !submitted.has(entry.id)) continue;
      const userMessage = entry.kind === "mybuddy.user" && typeof metadata.text === "string" && !metadata.botRequestId && !metadata.goalContinuation;
      const human = userMessage || (entry.kind === STEER_ENTRY_KIND && data.origin === "user" && identity.actor === "subagent");
      const assignment = identity.actor === "subagent" && entry.kind === "pi.user" && submitted.has(entry.id);
      const text = userMessage ? String(metadata.text)
        : identity.actor === "subagent" && submitted.has(entry.id) ? messageText(m.content) : "";
      const contract = parseDeliveryContract(text);
      if ((human || assignment) && text.trim() && Number.isFinite(m.timestamp)) {
        const context=object(object(metadata.audit).recommendation);
        inputs.push({ entry:entry.id,at:m.timestamp,contract:Boolean(contract),project:typeof context.projectId==="string"?context.projectId:undefined,
          workspace:typeof context.workspaceId==="string"?context.workspaceId:undefined });
      }
      const old = state.answer;
      const explicitCorrection = /^(?:你(?:漏了|漏掉|弄错|搞错)|这不是我(?:要求|要)的|你理解错了)/.test(text);
      const progress = human && asksProgress(text) ? { entry: entry.id, at: m.timestamp } : undefined;
      if (progress && state.progress && state.input && !state.success && !old?.blocked && !old?.claimed) {
        emit("progress", old?.id ?? state.lastAction ?? state.progress.entry, m.timestamp,
          { repairMs: String(Math.max(0, m.timestamp - state.progress.at)) }, old?.generation);
      } else if (human && old && state.input) {
        if (state.features.scopeChange && state.hasPriorAnswer && scopeCorrection(text) && state.requirements?.some(topic => text.includes(topic)))
          emit("scope", old.id, m.timestamp, { scopeChange: true, hasPriorAnswer: true }, old.generation);
        else if (old.handoff && /(?:你自己执行|不要再问|直接执行|自己继续|go ahead and do it)/i.test(text))
          emit("handoff", old.id, m.timestamp);
        else if (old.claimed && state.delivery?.wrote && deliveryCorrection(text, state.delivery.contract))
          emit("deliveryContract", old.id, m.timestamp, { contract: JSON.stringify(state.delivery.contract) },
            old.generation, state.delivery.input);
        else if (explicitCorrection)
          emit("correction", old.id, m.timestamp, { pattern: fingerprint([state.requirements ?? [], text.trim().replace(/\s+/g, " ").slice(0, 400)]) });
      } else if (human && entry.kind === STEER_ENTRY_KIND && state.input && state.lastAction && explicitCorrection)
        emit("correction",state.lastAction,m.timestamp);
      const hasPriorAnswer = Boolean(old);
      const recommendation = object(object(metadata.audit).recommendation);
      const features = requestFeatures(text);
      const requirements = [...new Set([...(features.scopeChange ? state.requirements ?? [] : []), ...requirementTopics(text)])];
      const baseline = features.scopeChange ? state.baseline : requirements.length ? entry.id : undefined;
      const delivery = contract ? { contract, input: entry.id, wrote: false } : progress ? state.delivery : undefined;
      Object.assign(state, freshHistory(), { last: state.last, input: text ? entry.id : 0, features, requirements, baseline,
        cwd: typeof object(metadata.audit).cwd === "string" ? String(object(metadata.audit).cwd) : undefined,
        project: typeof recommendation.projectId === "string" ? recommendation.projectId : undefined,
        workspace: typeof recommendation.workspaceId === "string" ? recommendation.workspaceId : undefined,
        hasPriorAnswer, answer: undefined, read: undefined, call: undefined, write: undefined, lastAction:undefined,
        delivery, progress });
      continue;
    }
    if (!state.input) continue;
    if (m.role === "assistant" || m.role === "toolResult") state.lastAction=entry.id;
    if (m.role === "assistant") {
      const calls = m.content.filter(p => p.type === "toolCall");
      if (calls.length) {
        const call = calls[0];
        state.call = calls.length === 1 ? { id: call.id, args: fingerprint(call.arguments), tool: call.name,
          path: typeof call.arguments.path === "string" ? call.arguments.path.slice(0,512) : undefined,
          target: typeof call.arguments.path === "string" && call.arguments.path === state.features.target, entry: entry.id, at: m.timestamp } : undefined;
        if (!state.call) state.tools = [];
        if (!state.call || call.name !== "read") { state.read = undefined; state.count = 0; }
        continue;
      }
      if (m.stopReason !== "stop") continue;
      const answer = messageText(m.content);
      if (answer.startsWith("[Hook ·")) continue;
      if (state.readback === "written" && !reportsBlocker(answer) && state.write)
        emit("readback", state.write, m.timestamp, { readback: "written", reportedBlocker: false, historyTruncated: false }, entry.byTaskId);
      state.answer = { id: entry.id, handoff: asksHandoff(answer), generation: Number(entry.byTaskId ?? 0),
        claimed: claimsDelivery(answer), blocked: reportsBlocker(answer) };
      state.read = undefined; state.count = 0;
      state.tools = [];
    } else if (m.role === "toolResult") {
      const call = state.call;
      state.call = undefined;
      if (!call || call.id !== m.toolCallId || call.tool !== m.toolName) { state.read = undefined; state.count = 0; state.tools = []; continue; }
      if (!m.isError) {
        state.success = true;
        if (state.delivery && call.path === state.delivery.contract.document && (call.tool === "write" || call.tool === "edit")) {
          state.delivery.wrote = true;
        }
      }
      if (call.tool === "codemode") for (const inner of nestedReadbackTools(m.details)) {
        if (state.delivery && inner.path === state.delivery.contract.document && (inner.tool === "write" || inner.tool === "edit")) {
          state.delivery.wrote = true;
        }
        if (!state.features.target || inner.path !== state.features.target) continue;
        if (inner.tool === "read") { if (state.readback === "written") state.readback = "verified"; }
        else { state.readback = "written"; state.write = entry.id; }
      }
      if (call.target && !m.isError) {
        if (call.tool === "write" || call.tool === "edit") { state.readback = "written"; state.write = entry.id; }
        if (call.tool === "read" && state.readback === "written") state.readback = "verified";
      }
      const receipt = { tool: call.tool, args: call.args, result: fingerprint(m.content), error: m.isError === true,
        entry: entry.id, elapsed: Math.max(0, m.timestamp - call.at) };
      state.tools = [...(state.tools ?? []), receipt].slice(-4);
      const candidate = !state.features.explicitRetry && toolPattern(state.tools);
      if (candidate) {
        emit(candidate.kind, candidate.first.entry, m.timestamp, { pattern: candidate.pattern,
          repairMs:String(state.tools.filter(item=>item.entry>=candidate.first.entry).reduce((sum,item)=>sum+item.elapsed,0)) });
        state.tools = [];
      }
      if (call.tool !== "read") continue;
      const current = { args: call.args, result: fingerprint(m.content), error: m.isError === true, entry: entry.id,
        missing: m.isError && missingFile(messageText(m.content)) ? call.path : undefined };
      state.count = sameRead(state.read, current) ? state.count + 1 : 1;
      if (state.read && state.count === 2 && current.error && !state.features.explicitRetry)
        emit("retry", state.read.entry, m.timestamp, { repeatedReadFailure: true, explicitRetry: false });
      if (state.read && !state.features.explicitRetry && !current.error && state.count === 3) emit("redundant", state.read.entry, m.timestamp);
      if (state.read?.error && !current.error && current.args !== state.read.args) {
        const mapping = identity.actor === "main" && readMapping(state.read.missing,call.path,state.cwd);
        if (mapping) emit("readPath",state.read.entry,m.timestamp,mapping);
        else emit("recovery", state.read.entry, m.timestamp);
      }
      state.read = current;
    }
  }
}
async function doc(storage: Storage, conversationId: ConversationId, kind: string) {
  const row = await storage.findDocument({ kind, scope: { kind: "conversation", conversationId } }, "current", ctx);
  return row && (await storage.document(row.id, "current", ctx))?.value;
}
export async function scanImprovementHistory(taskId: string, directory: string, checkpoint: (identity: HistoryIdentity) => HistoryState,
  save: (identity: HistoryIdentity, state: HistoryState, found: Observation[], scanned: number) => void, stopping: () => boolean,
  childIndex?: { needsRead(conversation: number, childId: string): boolean; save(child: ImprovementChild, immutable: boolean): void },
  onInputs?: (identity: HistoryIdentity, inputs: ImprovementInput[]) => void) {
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) throw new Error("缺少原生会话存储");
  let scanned = 0;
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanConversations({}, 64, cursor, ctx);
      for (const c of page.items) {
        if (stopping()) throw new Error("复盘已中断");
        const child = object((await doc(storage, c.id, DurableSubagentIdentity.definition.kind))?.value);
        if (c.owner && child.taskId !== taskId || (await doc(storage, c.id, DurableConsultIdentity.definition.kind))?.key) continue;
        const identity: HistoryIdentity = { taskId, conversationId: String(c.id), actor: child.taskId === taskId ? "subagent" : "main",
          ...(c.owner ? { parent: String(c.owner.conversationId) } : {}) };
        const saved = checkpoint(identity);
        const state = saved.analysisVersion === analysisVersion ? saved : freshHistory();
        if (identity.actor === "subagent" && childIndex?.needsRead(c.id,String(object(child.item).id))) {
          const evidence = await readImprovementChild(storage,taskId,c,false);
          if (!evidence) throw new Error("无法核实原生子代理身份，子会话 " + c.id);
          const assignment = evidence.submissions.at(-1);
          if (assignment) {
            const found: Observation[] = [];
            const add = (kind: "childDelivery" | "childSteer", receipt: number) => found.push({ kind, replay: {}, source: {
              ...identity, entry: receipt, trigger: evidence.child.ownerTask, input: assignment.entry ?? assignment.id,
              at: evidence.child.startedAt + (evidence.child.durationMs ?? 0), childReceipt: kind === "childDelivery" ? "assignment" : "steer" } });
            if (["failed","timedout","blocked"].includes(evidence.child.status)) add("childDelivery", assignment.id);
            for (const steer of evidence.steers) if (steer.status === "unprocessed" || steer.status === "unanswered") add("childSteer",steer.submissionId);
            if (found.length) save(identity,state,found,0);
          }
          childIndex.save(evidence.child, evidence.parentReturnEntry !== undefined && evidence.child.status !== "unknown"
            && evidence.steers.every(s => s.nativeStatus === "done" || s.nativeStatus === "unanswered"));
        }
        const submitted = new Set<number>();
        let next: Cursor | undefined;
        do {
          const entries = await storage.scanEntries({ conversationId: c.id, minEntryId: (state.last + 1) as EntryId, order: "ascending" }, 128, undefined, ctx);
          if (!entries.items.length) break;
          if (stopping()) throw new Error("复盘已中断");
          if (entries.items.some(e => e.kind === "pi.user" || e.kind === STEER_ENTRY_KIND) && !submitted.size) {
            do {
              const inputs = await storage.scanSubmissions({ conversationId: c.id }, 128, next, ctx);
              for (const s of inputs.items) if (s.type === "input" && s.entry !== undefined) submitted.add(s.entry);
              next = inputs.next;
            } while (next);
          }
          const found: Observation[] = [];
          const inputs: ImprovementInput[] = [];
          for (const e of entries.items) {
            consume(state, e, identity, submitted, found, inputs);
            state.last = e.id;
          }
          scanned += entries.items.length;
          // Persist idempotent input keys before advancing the cursor so a crash cannot drop denominators.
          if (inputs.length) onInputs?.(identity, inputs);
          save(identity, state, found, entries.items.length);
          if (!entries.next) break;
          await new Promise<void>(resolve => setImmediate(resolve));
        } while (true);
      }
      cursor = page.next;
    } while (cursor);
    return scanned;
  } finally { await storage.close(ctx); }
}
