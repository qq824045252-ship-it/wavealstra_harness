import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type Cursor } from "@earendil-works/pi-durable";
import type Database from "better-sqlite3";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { hasNativeExecutionReceipt } from "../../shared/native-execution-receipt";
import { ActiveDurableConversation } from "../agent/durable/DurableConversationBranch";
import { openDurablePassiveStorage } from "../agent/durable/DurableStorage";
import { durableText } from "../agent/durable/DurableTurnProjection";
import { durableRegisteredArtifact } from "../agent/durable/DurableArtifactRegistration";

export interface NativeResultHit {
  source: "native"; taskId: string; title: string; link: string; status: "completed";
  conversationId: number; submissionId: number; answerEntryId: number; text: string;
  textTruncated?: true;
  artifacts: { id: string; name: string; path: string; link: string }[];
}

export function dotsResultExcerpt(text: string, limit: number, start = 0): { text: string; textTruncated?: true } {
  const end = start + limit;
  return { text: text.slice(start, end), ...(start > 0 || end < text.length ? { textTruncated: true } : {}) };
}

function fileLink(name: string, path: string) {
  const href = pathToFileURL(path).href.replaceAll("(", "%28").replaceAll(")", "%29");
  return "[" + name.replace(/[\\[\]]/g, "\\$&") + "](" + href + ")";
}

/** Search accepted answers and host-registered files in the selected conversation's read snapshot. */
export async function nativeResultHits(task: {id: string; title: string; link: string}, directory: string,
  query: string, delegated: Set<string>, limit: number, db: Database.Database) {
  const hits: NativeResultHit[] = [];
  const storage = await openDurablePassiveStorage(directory, context);
  if (!storage) return hits;
  try {
    const branch = await storage.findDocument({kind: ActiveDurableConversation.definition.kind, scope: {kind:"session"}}, "current", context);
    const active = branch && (await storage.document(branch.id, "current", context))?.value;
    const conversationId = (active?.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId;
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({conversationId, status:"done", order:"descending"}, 64, cursor, context);
      for (const input of page.items) {
        if (input.type !== "input" || input.status !== "done" || (input.requestId && delegated.has(input.requestId))) continue;
        const answer = (await storage.entry(input.answer, context))?.entry;
        const message = answer?.model?.find(m => m.role === "assistant" && m.stopReason === "stop");
        if (!message || message.role !== "assistant" || answer?.conversationId !== conversationId) continue;
        const text = durableText(message.content);
        const files = new Map<string, NativeResultHit["artifacts"][number]>();
        const messageIds = new Set([`durable-${input.answer}`]);
        const receiptedCalls = new Set<string>();
        let entries: Cursor | undefined;
        do {
          const chunk = await storage.scanEntries({conversationId, minEntryId:input.entry, maxEntryId:input.answer, order:"descending"}, 80, entries, context);
          for (const entry of chunk.items) {
            for (const item of entry.model ?? []) {
              if (item.role === "toolResult" && hasNativeExecutionReceipt(item.details)) receiptedCalls.add(item.toolCallId);
            }
            if (answer.byTaskId !== undefined && entry.byTaskId === answer.byTaskId && entry.model?.some(item => item.role === "assistant"))
              messageIds.add(`durable-${entry.id}`);
            const file = durableRegisteredArtifact(entry, input.id, undefined, directory);
            if (!file || files.has(file.path)) continue;
            const name = basename(file.path);
            files.set(file.path, {id: "saved:" + file.snapshotPath, name, path:file.path,
              link:fileLink(name,file.snapshotPath)});
          }
          entries = chunk.next;
        } while (entries);
        // Historical results without native receipts may have only an artifact index link.
        // For receipted calls the registered snapshot carries the verified file version.
        const indexed = db.prepare(`SELECT DISTINCT a.id,a.entry_file,r.tool_call_id FROM artifact_message_refs r
          JOIN artifacts a ON a.id=r.artifact_id AND a.task_id=r.task_id
          WHERE r.task_id=? AND r.message_id IN (SELECT value FROM json_each(?)) AND r.tool_call_id IS NOT NULL
            AND a.source_type='workspace-file' AND a.entry_file IS NOT NULL`)
          .all(task.id,JSON.stringify([...messageIds])) as {id:string;entry_file:string;tool_call_id:string}[];
        for (const row of indexed) {
          if (receiptedCalls.has(row.tool_call_id) || files.has(row.entry_file)) continue;
          const name = basename(row.entry_file);
          files.set(row.entry_file, {id:row.id, name, path:row.entry_file, link:fileLink(name,row.entry_file)});
        }
        const artifacts = [...files.values()];
        const matched = artifacts.filter(file => file.name.toLowerCase().includes(query));
        const position = text.toLowerCase().indexOf(query);
        if (position < 0 && !matched.length && !task.title.toLowerCase().includes(query)) continue;
        const start = Math.max(0,position - 150);
        hits.push({source:"native", taskId:task.id, title:task.title, link:task.link, status:"completed", conversationId,
          submissionId:input.id, answerEntryId:input.answer, ...dotsResultExcerpt(text,1200,start), artifacts:(matched.length ? matched : artifacts).slice(0,10)});
        if (hits.length >= limit) return hits;
      }
      cursor = page.next;
    } while (cursor);
    return hits;
  } finally { await storage.close(context); }
}
