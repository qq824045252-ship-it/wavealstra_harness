import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, ToolHookCall } from "@earendil-works/pi-durable";

const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const receiptContractSchema = z.object({
  version: z.literal(1), idempotencyArgument: field, receiptTool: z.string().min(1), receiptArgument: field,
  operationIdField: field, statusField: field,
  completedValues: z.array(z.string().min(1)).min(1), failedValues: z.array(z.string().min(1)).default([]),
});
const fileIntentSchema = z.object({ kind: z.literal("file"), path: z.string(), canonicalPath: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() });
const receiptIntentSchema = z.object({ kind: z.literal("receipt"), server: z.string(), serverIdentity: z.string(), tool: z.string(), operationId: z.string(), contract: receiptContractSchema });
export const effectIntentSchema = z.discriminatedUnion("kind", [fileIntentSchema, receiptIntentSchema]);
export type EffectIntent = z.infer<typeof effectIntentSchema>;
export type ReceiptIntent = z.infer<typeof receiptIntentSchema>;
export type EffectEvidence = {
  status: "passed" | "failed" | "inconclusive";
  verifierId: "durable-file-content" | "durable-business-receipt";
  canonicalTarget: string;
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  checkedAt: number;
};
export interface ExternalEffectRecovery {
  prepare(name: string, args: JsonObject, operationId: string, context: Context, origin?: { server: string; tool: string }): Promise<{ arguments: JsonObject; intent: ReceiptIntent } | undefined>;
  verify(intent: ReceiptIntent, context: Context): Promise<EffectEvidence>;
}

const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
export const effectOperationId = (executionId: string, callId: string) => `mybuddy-${hash(JSON.stringify([executionId, callId]))}`;

async function canonicalTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalTarget(parent), basename(path));
  }
}

/** Exact edit verification deliberately declines fuzzy matching rather than guessing the resulting bytes. */
async function editedContent(args: Record<string, unknown>, path: string): Promise<string | undefined> {
  if ((await stat(path)).size > 16 * 1024 * 1024) return undefined;
  const parsed = z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1).safeParse(args.edits);
  if (!parsed.success) return undefined;
  const original = await readFile(path, "utf8");
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = original.slice(bom.length);
  const firstLf = raw.indexOf("\n");
  const newline = firstLf > 0 && raw[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
  const base = normalize(raw);
  const edits = parsed.data.map(edit => ({ old: normalize(edit.oldText), replacement: normalize(edit.newText) }))
    .map(edit => ({ ...edit, at: base.indexOf(edit.old) })).sort((a, b) => a.at - b.at);
  if (edits.some((edit, index) => edit.at < 0 || base.indexOf(edit.old, edit.at + 1) !== -1
    || index > 0 && edits[index - 1].at + edits[index - 1].old.length > edit.at)) return undefined;
  let expected = base;
  for (const edit of [...edits].reverse()) expected = expected.slice(0, edit.at) + edit.replacement + expected.slice(edit.at + edit.old.length);
  return bom + (newline === "\r\n" ? expected.replace(/\n/g, "\r\n") : expected);
}

export async function prepareFileEffect(call: ToolHookCall, cwd: string): Promise<EffectIntent | undefined> {
  if (!["write", "edit"].includes(call.name) || typeof call.arguments.path !== "string") return undefined;
  const path = resolve(cwd, call.arguments.path);
  try {
    const content = call.name === "write" && typeof call.arguments.content === "string" ? call.arguments.content
      : call.name === "edit" ? await editedContent(call.arguments, path) : undefined;
    if (content === undefined) return undefined;
    return { kind: "file", path, canonicalPath: await canonicalTarget(path), sha256: hash(content), bytes: Buffer.byteLength(content) };
  } catch { return undefined; } // A nonexistent source or unknown edit has no trustworthy expected result.
}

export async function verifyFileEffect(intent: Extract<EffectIntent, { kind: "file" }>, signal?: AbortSignal): Promise<EffectEvidence> {
  const evidence: EffectEvidence = { status: "inconclusive", verifierId: "durable-file-content", canonicalTarget: intent.canonicalPath,
    expected: { sha256: intent.sha256, bytes: intent.bytes }, observed: {}, checkedAt: Date.now() };
  try {
    const canonicalPath = await canonicalTarget(intent.path);
    if (canonicalPath !== intent.canonicalPath) return { ...evidence, observed: { canonicalPath, reason: "target-changed" } };
    // A changed file or device must not turn recovery into an unbounded read.
    const before = await stat(intent.path);
    if (!before.isFile() || before.size !== intent.bytes) return { ...evidence, observed: { reason: "not-a-regular-file-or-size-mismatch", bytes: before.size } };
    const verificationSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
    verificationSignal.throwIfAborted();
    const file = await open(intent.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size !== intent.bytes || opened.dev !== before.dev || opened.ino !== before.ino) {
        return { ...evidence, observed: { reason: "target-changed-before-read" } };
      }
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: intent.bytes, signal: verificationSignal })) {
        bytes += chunk.length;
        if (bytes > intent.bytes) return { ...evidence, observed: { reason: "target-grew-during-read", bytes } };
        digest.update(chunk);
      }
      const sha256 = digest.digest("hex");
      const after = await stat(intent.path);
      const unchanged = after.dev === opened.dev && after.ino === opened.ino && after.size === intent.bytes && after.mtimeMs === opened.mtimeMs
        && await canonicalTarget(intent.path) === intent.canonicalPath;
      return { ...evidence, checkedAt: Date.now(), status: unchanged && sha256 === intent.sha256 && bytes === intent.bytes ? "passed" : "inconclusive", observed: { sha256, bytes, unchanged } };
    } finally { await file.close(); }
  } catch (error) { return { ...evidence, observed: { error: error instanceof Error ? error.message : String(error) } }; }
}
