import { basename, isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { matchingNativeExecutionReceipt } from "../../shared/native-execution-receipt";
import { WEB_ACCESS_TOOL_NAMES } from "../../shared/native-tools";
import { OFFICE_USE_TOOLS } from "../../shared/office-use";
import { durableRegisteredArtifact } from "../agent/durable/DurableArtifactReceipt";
import { PROJECT_CHECK_NAME_PATTERN, PROJECT_VERIFY_TOOL } from "../agent/durable/DurableProjectVerification";
import { openDurablePassiveStorage } from "../agent/durable/DurableStorage";

export type DotsRecoveryKind = "continue" | "local" | "report-only" | "unknown" | "unavailable";
export type DotsRecoveryToolScope = { kind: "report-only" } | { kind: "local-files"; files: string[] }
  | { kind: "local-repair"; files: string[]; checks: string[]; edits: string[] };
export type DotsRecoveryInspection = { kind: DotsRecoveryKind; retainedFiles: string[]; editableFiles?: string[] };

const readTools = new Set(["read", "find", "glob", "grep", "ls"]);
const webReads = new Set<string>(WEB_ACCESS_TOOL_NAMES);
const reportTool = "dots_task_end";
const localMutationTools = new Set(["write", "edit"]);
const namedProjectCheck = new RegExp(PROJECT_CHECK_NAME_PATTERN, "u");

export function dotsRecoveryAllowsTool(scope: DotsRecoveryToolScope, name: string): boolean {
  if (name === reportTool) return true;
  if (scope.kind === "report-only") return false;
  if (readTools.has(name) || webReads.has(name) || name === "request_user_input") return true;
  if (name === "write" || name === OFFICE_USE_TOOLS.documentCreate) return scope.files.length > 0;
  return scope.kind === "local-repair" && (name === PROJECT_VERIFY_TOOL && scope.checks.length > 0 || name === "edit" && scope.edits.length > 0);
}

export function dotsRecoveryAllowsVerify(scope: DotsRecoveryToolScope, params: unknown): boolean {
  if (scope.kind !== "local-repair" || !params || typeof params !== "object" || Array.isArray(params) ||
    Object.keys(params).some(key => key !== "script" && key !== "args" && key !== "manager")) return false;
  const { script, args, manager } = params as { script?: unknown; args?: unknown; manager?: unknown };
  return typeof script === "string" && namedProjectCheck.test(script) &&
    (manager === undefined || manager === "npm" || manager === "pnpm") &&
    (args === undefined || Array.isArray(args) && args.length === 0) &&
    (scope.checks.includes(script) || scope.checks.includes("test:*") && (script === "test" || script.startsWith("test:")));
}

export function validDotsRecoveryFilename(name: string): boolean {
  return /^[\p{L}\p{N}_-][\p{L}\p{N} ._-]*\.[\p{L}\p{N}]+$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(name.split(".")[0]!.trimEnd());
}

export function dotsRecoveryFileKey(name: string, snapshotPath: string): string {
  return JSON.stringify([name, snapshotPath]);
}

/** A settled tool call can be printed by the model but only the host attaches its native receipt.
 * Generic transport success is not evidence that an external mutation succeeded. */
function toolRecovery(result: ToolResultMessage, receipt: ReturnType<typeof matchingNativeExecutionReceipt>): Exclude<DotsRecoveryKind, "unavailable"> {
  const name = result.toolName;
  if (receipt?.transport === "not_started" && receipt.settlement === "released") return "continue";
  if (receipt?.status !== "passed" || receipt.settlement !== "consumed") return "unknown";
  if (webReads.has(name) && receipt.verifierId === "durable-tool-result" && receipt.transport === "returned" && !result.isError) return "continue";
  if (name === PROJECT_VERIFY_TOOL && receipt.transport === "returned" && result.content.length === 1 && result.content[0]?.type === "text") {
    try {
      const check = JSON.parse(result.content[0].text);
      // project_verify persists and reuses this verified workspace stamp, so a later step can use its result.
      if (check?.outcome === "passed" && /^[a-f\d]{64}$/u.test(check.fingerprint) && typeof check.executionId === "string" && check.executionId)
        return "continue";
    } catch { /* No verified check result. */ }
  }
  if (receipt.verifierId === "durable-business-receipt") return "report-only";
  if ((localMutationTools.has(name) || name === OFFICE_USE_TOOLS.documentCreate) &&
    receipt.verifierId === "durable-file-content" && receipt.fileChange?.checkedRange ||
    name === "register_artifact" && receipt.transport === "returned") return "local";
  return "unknown";
}

export async function inspectDotsRecovery(directory: string, taskId: string, operationId: string, version: string,
  namedFiles: readonly string[]): Promise<DotsRecoveryInspection> {
  const retainedFiles = new Set<string>();
  const editableFiles = new Set<string>();
  const finish = (kind: DotsRecoveryKind): DotsRecoveryInspection => ({ kind, retainedFiles: [...retainedFiles],
    ...(editableFiles.size && { editableFiles: [...editableFiles] }) });
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) return finish("unavailable");
  try {
    const [conversationId, receiptId] = JSON.parse(version) as [ConversationId, number];
    const input = await storage.submissionByRequest(conversationId, operationId, ctx);
    if (input?.type !== "input" || input.id !== receiptId || input.entry === undefined ||
      !(input.status === "done" || input.status === "unanswered")) return finish("unavailable");

    const pending = new Map<string, string>();
    let cursor: Cursor | undefined;
    let saved = false;
    let local = false;
    let reportOnly = false;
    untilNextInput: do {
      const page = await storage.scanEntries({
        conversationId, minEntryId: input.entry, maxEntryId: input.answer, order: "ascending",
      }, 80, cursor, ctx);
      for (const entry of page.items) {
        if (entry.id === input.entry) saved = true;
        if (entry.id > input.entry && (entry.kind === "mybuddy.user" || entry.kind === "pi.user")) {
          // An answered input sharing another user's turn cannot prove its own effect boundary.
          if (input.status === "done") return finish("unavailable");
          break untilNextInput;
        }
        const file = durableRegisteredArtifact(entry, input.id, undefined, directory);
        if (file) {
          local = true;
          const name = basename(file.path);
          if (file.explicitlyRegistered || namedFiles.includes(name)) retainedFiles.add(dotsRecoveryFileKey(name, file.snapshotPath));
        }
        for (const message of entry.model ?? []) {
          if (message.role === "assistant") for (const call of message.content) {
            if (call.type !== "toolCall" || readTools.has(call.name) || call.name === reportTool) continue;
            if (pending.has(call.id)) return finish("unknown");
            pending.set(call.id, call.name);
          }
          if (message.role !== "toolResult" || readTools.has(message.toolName) || message.toolName === reportTool) continue;
          const call = pending.get(message.toolCallId);
          if (!call || call !== message.toolName || entry.byTaskId === undefined) return finish("unknown");
          pending.delete(message.toolCallId);
          const receipt = matchingNativeExecutionReceipt(message, { taskId, conversationId, toolTaskId: entry.byTaskId,
            toolName: call, callId: message.toolCallId });
          const kind = toolRecovery(message, receipt);
          if (kind === "unknown") return finish("unknown");
          if (kind === "local") {
            local = true;
            const target = receipt?.fileChange?.target;
            if (localMutationTools.has(call) && target && isAbsolute(target)) editableFiles.add(target);
          }
          if (kind === "report-only") reportOnly = true;
        }
      }
      cursor = page.next;
    } while (cursor);
    if (!saved) return finish("unavailable");
    if (pending.size) return finish("unknown");
    return finish(reportOnly ? "report-only" : local ? "local" : "continue");
  } finally { await storage.close(ctx); }
}
