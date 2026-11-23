import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { dotsInputVersion } from "../../dots/DotsNativeIntent";
import { nativeExecutionSucceeded, readNativeExecutionReceipt, type NativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import { resolvedPathKey } from "../../platform/paths";
import { collectRuntimeMaterialEvidence } from "../RuntimeMaterialEvidence";
import type { GoalCompletionObservation } from "../work/WorkClosureMutations";
import { currentDurableInvocation } from "./DurableExecutionContext";
import { durableArtifactRegistrationSchema, DURABLE_ARTIFACT_ENTRY_KIND } from "./DurableArtifactRegistration";
import { durableDotsReplySources } from "./DurableDotsResult";
import { collectReplyCitations } from "../../../shared/chat-reply-sources";
import { authoredFiles } from "../pstack/PstackAuthoredSkills";
import { runSettings, WorkflowFiles, WorkflowState } from "../pstack/PstackState";
import { currentVerificationEvidence, pstackCheckIdentitySchema } from "../pstack/PstackVerificationEvidence";
import { measureWorkspace, verificationCheckout } from "../pstack/PstackWorkspace";

export interface GoalObservationQuote {
  criterionId?: string;
  quote: string;
  toolCallId?: string;
}

const controlTools = new Set(["request_user_input", "dots_action"]);
const acknowledgment = /^(?:我(?:已经|已)?|本轮|任务|目标|事项|工作)?(?:已(?:经)?|都|全部)?\s*(?:做好了|做完了|已完成|完成了?|通过了?|满足了?|已结项|已交付|已核对|核对完成|确认|收到|没问题|done|completed|successfully completed)[。.!！\s]*$/iu;

type ReadObservation = { target: string; hash: string };
type Candidate = { observation: GoalCompletionObservation; read?: ReadObservation };

/** Resolve quotes from retained native result entries and reject copied inputs. */
export async function readGoalObservations(origin: string, operation: string, quotes: GoalObservationQuote[], lineage: readonly string[], delivery: string) {
  const active = currentDurableInvocation();
  const conversationId = active?.presentationConversationId;
  if (!active || conversationId === undefined || !quotes.length)
    throw new Error("请引用本次交办的实际文字成果或成功工具结果");
  const requested = quotes.map(item => ({ ...item, quote: item.quote.trim() }));
  if (requested.some(item => !item.quote || acknowledgment.test(item.quote))) throw new Error("请引用可交付内容或观测事实");
  const proof = await active.native.commit(async tx => {
    const current = await tx.submissionByRequest(conversationId, operation);
    const [, latest] = JSON.parse(await dotsInputVersion(tx, conversationId)) as [number, number];
    if (current?.type !== "input" || !current.entry || current.id !== latest) throw new Error("原执行已收到更新要求，请按最新意图核对");
    const assignment = await tx.submissionByRequest(conversationId, origin);
    if (assignment?.type !== "input" || !assignment.entry) throw new Error("原交办的执行回执不可用");

    const matches = requested.map(() => [] as Candidate[]);
    const userInputs: Array<{ type: string; text?: string }> = [];
    const readCalls = new Map<string, unknown>();
    const latestReadHashes = new Map<string, string>();
    const inputIds = new Set<number>([current.id, assignment.id]);
    const inputEntries = new Set<number>([current.entry, assignment.entry]);
    for (const requestId of lineage) {
      const input = await tx.submissionByRequest(conversationId, requestId);
      if (input?.type === "input" && input.entry) {
        inputIds.add(input.id);
        inputEntries.add(input.entry);
      }
    }
    const registered = new Map<string, {
      entryId: number;
      file: import("./DurableArtifactRegistration").DurableArtifactRegistration;
    }>();
    const latestRegistrationDigests = new Map<string, string>();
    const sources: ReturnType<typeof durableDotsReplySources> = [];
    let inLineage = true;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId, minEntryId: assignment.entry, order: "ascending" }, 100, cursor);
      for (const entry of page.items) {
        if (entry.kind === "pi.user" || entry.kind === "mybuddy.user") inLineage = inputEntries.has(entry.id);
        if (inLineage) sources.push(...durableDotsReplySources(entry, inputEntries.has(entry.id)));
        if (entry.kind === DURABLE_ARTIFACT_ENTRY_KIND) {
          const file = durableArtifactRegistrationSchema.safeParse(entry.data);
          if (file.success && file.data.inputIds.some(input => inputIds.has(input))) {
            const key = resolvedPathKey(file.data.path);
            latestRegistrationDigests.set(key, file.data.digest);
            if (file.data.explicitlyRegistered) registered.set(key, { entryId: entry.id, file: file.data });
          }
        }
        for (const message of entry.model ?? []) {
          if (message.role === "user") {
            userInputs.push(...(typeof message.content === "string" ? [{type:"text",text:message.content}] : message.content));
            continue;
          }
          if (!inLineage || message.role === "system") continue;
          let read: ReadObservation | undefined;
          let executionReceipt: NativeExecutionReceipt | undefined;
          let checkIdentity: GoalCompletionObservation["checkIdentity"];
          if (message.role === "toolResult") {
            if (controlTools.has(message.toolName) || message.toolName.startsWith("conversation_goal_") ||
              !nativeExecutionSucceeded(message, { taskId: active.execution.taskId, conversationId,
                toolTaskId: entry.byTaskId, callId: message.toolCallId, toolName: message.toolName })) continue;
            executionReceipt = readNativeExecutionReceipt(message.details);
            if (executionReceipt && entry.byTaskId === undefined) continue;
            if (message.toolName === "pstack_workflow") {
              const { details } = message;
              if (details && typeof details === "object" && "checkIdentity" in details && Object.hasOwn(details, "checkIdentity")) {
                checkIdentity = pstackCheckIdentitySchema.safeParse(details.checkIdentity).data;
                if (!checkIdentity || entry.byTaskId !== checkIdentity.operationTaskId) continue;
              } else if (executionReceipt) {
                // Status and other workflow controls do not attest a check.
                continue;
              }
            }
          }
          if (message.role === "assistant") {
            for (const block of message.content) {
              if (block.type === "toolCall" && block.name === "read") readCalls.set(block.id, block.arguments);
            }
          } else if (message.toolName === "read") {
            const args = readCalls.get(message.toolCallId);
            readCalls.delete(message.toolCallId);
            const [receipt] = collectRuntimeMaterialEvidence({
              toolCallId: message.toolCallId, toolName: message.toolName, args, result: message, isError: message.isError,
            }, message.timestamp);
            if (receipt && !receipt.images && receipt.returnedChars) {
              // Different read windows can be pieces of one file. Only compare
              // successful reads of the same path and requested line window.
              const path = resolvedPathKey(executionReceipt?.fileRead?.target ?? resolve(active.cwd, receipt.target.replace(/^@/, "")));
              const target = JSON.stringify([path, receipt.offset ?? 1, receipt.limit ?? null]);
              read = { target, hash: receipt.outputHash };
              latestReadHashes.set(target, read.hash);
            }
          }
          for (const [index, item] of requested.entries()) {
            if (item.toolCallId && (message.role !== "toolResult" || message.toolCallId !== item.toolCallId)) continue;
            if (!message.content.some(block => block.type === "text" && block.text.includes(item.quote))) continue;
            matches[index].push({ read, observation: {
              criterionId: item.criterionId,
              sourceRef: `durable:${active.execution.taskId}:${conversationId}:${entry.id}`,
              detail: item.quote,
              kind: message.role === "toolResult" ? "tool_receipt" : "inspection",
              ...(executionReceipt && { executionReceipt }),
              ...(checkIdentity && { checkIdentity }),
              ...(read && { readVersion: { target: read.target, outputHash: read.hash } }),
            } });
          }
        }
      }
      cursor = page.next;
    } while (cursor);

    const observations = matches.map((candidates, index) => {
      const { quote } = requested[index];
      const suppliedByUser = userInputs.some(block => block.type === "text" && block.text?.includes(quote));
      const receipts = candidates.filter(item => item.observation.kind === "tool_receipt").reverse();
      const receipt = receipts.find(({ read }) => !read || latestReadHashes.get(read.target) === read.hash);
      if (!receipt && receipts.length) throw new Error("同一文件已有更新的读取结果，请引用最新观测重新核对");
      const recorded = receipt ?? (suppliedByUser ? undefined : candidates.at(-1));
      if (!recorded) throw new Error("有验收依据未在本次交办的原生结果中找到。请从真实结果中逐字引用一段原文");
      return recorded.observation;
    });
    for (const [key, { file }] of registered)
      if (latestRegistrationDigests.get(key) !== file.digest) throw new Error("交付文件已更新，请重新登记最新版：" + basename(file.path));
    return {
      observations,
      native: { conversationId, submissionId: current.id, entryId: current.entry,
        toolConversationId: active.native.conversationId, toolTaskId: active.native.taskId, callId: active.native.callId },
      artifacts: [...registered.values()].map(({ file }) => {
        const name = basename(file.path);
        return { id: "saved:" + file.snapshotPath, name,
          saved: { name, snapshotPath: file.snapshotPath, manifestPath: file.previewManifestPath } };
      }),
      registrations: [...registered.values()].map(({ entryId, file }) => ({ entryId, digest: file.digest })),
      citations: collectReplyCitations(delivery, sources),
    };
  }, active.context);
  const checkIdentities = proof.observations.flatMap(item => item.checkIdentity ? [item.checkIdentity] : []);
  if (checkIdentities.length) {
    const { native, context } = active;
    const run = (await native.snapshot(WorkflowState, conversationId, context))?.run;
    const baseline = (await native.snapshot(WorkflowFiles, conversationId, context))?.base;
    const stale = "引用的 Pstack 校验不适用于当前工作区版本，请重新校验并引用最新结果";
    if (!run || run.task !== active.execution.taskId || !baseline || checkIdentities.some(check => check.workflowRun !== run.run))
      throw new Error(stale);
    const history = await native.commit(async tx => {
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId, minEntryId: run.first, order: "ascending" }, 100, cursor);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return entries;
    }, context);
    const scoped = await authoredFiles({ conversationId, snapshot: native.snapshot.bind(native) }, context, run, history);
    const measured = await measureWorkspace(baseline, runSettings(run).thermos.fileLines, context.abortSignal, scoped);
    const checkoutSha = await verificationCheckout(baseline, context.abortSignal);
    const verified = measured.coverageComplete ? currentVerificationEvidence(run, measured.fingerprint, history, checkoutSha, Infinity) : [];
    if (checkIdentities.some(identity => !verified.some(check => check.passed &&
      isDeepStrictEqual(pstackCheckIdentitySchema.safeParse(check.checkIdentity).data, identity))))
      throw new Error(stale);
    await native.commit(async tx => {
      const liveRun = (await tx.doc(WorkflowState, conversationId)).run;
      const [, latest] = JSON.parse(await dotsInputVersion(tx, conversationId)) as [number, number];
      if (liveRun?.run !== run.run || liveRun.revision !== run.revision || latest !== proof.native.submissionId)
        throw new Error(stale);
    }, context);
  }
  return proof;
}
