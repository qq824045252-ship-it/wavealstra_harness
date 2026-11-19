import { defineDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { z } from "zod";
import { pstackDecisionLogPath } from "../../../shared/pstack/paths";
import { pathKey } from "../../platform/paths";
import { checked, owner, runSettings, state, transcript, WorkflowState, type Api, type WorkflowOptions, type WorkflowRun } from "./PstackState";
import { appendTrailBytes, digest, header, scanTrail, trailTarget, type TrailIntent } from "./PstackDecisionFile";

const cell = Type.String({ minLength: 1 });
export const decisionParameters = Type.Object({ phase: cell, decision: cell, why: cell, evidence: cell, result: cell,
  id: Type.Optional(Type.String({ minLength: 1, description: "Stable ID for retries; use a new ID for a deliberately repeated decision." })) });
type Decision = Static<typeof decisionParameters>;
const receiptMemo = "mybuddy.pstack-decision-intent";
const nestedKey = "append-decision";
const name = "pstack_decision_append";
type Receipt = { task: string; run: number; path: string; row: string; line: number; decisionKey: string; operation: number; toolTaskId: number };
export const PstackTrailReceipts = defineDoc({ kind: "mybuddy.pstack-decisions", version: 1, scope: "conversation",
  history: "rewindable", fork: "initial", checkpointWhen: () => true,
  initial: (): { rows: Receipt[]; writing?: { run: number; operation: number } } => ({ rows: [] }) });

const locks = new Map<string, Promise<void>>();
async function forPath<T>(path: string, execute: () => Promise<T>): Promise<T> {
  const key = pathKey(path);
  const previous = locks.get(key);
  let release!: () => void;
  const current = new Promise<void>(done => { release = done; });
  locks.set(key, current);
  try { await previous; return await execute(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

function clean(text: string) {
  const value = text.replace(/[\r\n\t]/g, " ").trim();
  if (!value || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("Decision cells must contain readable text.");
  return /^[=+@-]/.test(value) ? "'" + value : value;
}
function currentPath(run: WorkflowRun) {
  const cfg = runSettings(run).skills["show-me-your-work"];
  if (!cfg?.enabled) throw new Error("show-me-your-work is disabled.");
  return pstackDecisionLogPath(cfg.parameters.logPath);
}
async function checkRun(options: WorkflowOptions, run: Pick<WorkflowRun, "task" | "run">, api: Api, ctx: Context) {
  checked(options, ctx);
  const active = await state(api, ctx);
  if (active?.task !== options.taskId || run.task !== active.task || run.run !== active.run || active.phase !== "running")
    throw new Error("Decision trail needs the active owning workflow.");
  checked(options, ctx);
}

async function readLog(options: WorkflowOptions, path: string, api: Api, ctx: Context, key: string, scan: Parameters<typeof scanTrail>[2]) {
  const target = await trailTarget(options.cwd, path);
  const read = await api.executeTool("read", { path, offset: 1, limit: 1 }, ctx, { key });
  if (read.isError) {
    const absent = !target.info && read.diagnostics.some(d => d.code === "tool_error" && /ENOENT|not.found|no such file/i.test(d.message));
    if (!absent) throw new Error("Decision log read was not authorized or failed: " + JSON.stringify(read.diagnostics));
  }
  checked(options, ctx);
  const result = await scanTrail(options.cwd, path, { ...scan, signal: ctx.abortSignal });
  if (!target.info && result.size) throw new Error("Decision log appeared before read. Retry.");
  return { existed: !!target.info, ...result };
}

const parseIntent = z.object({ task: z.string(), run: z.number(), path: z.string(), decisionKey: z.string(), beforeHash: z.string(), beforeBytes: z.number(),
  append: z.string(), expectedSha256: z.string(), expectedBytes: z.number(), rows: z.array(z.string()).min(1), line: z.number(), existed: z.boolean() });

/** Only a parent with a committed intent can use this leaf. The write policy and resource lease apply to it. */
export function createPstackDecisionAppend(options: WorkflowOptions): ToolRegistration {
  return defineTool({ name, callers: ["tools"], replay: "safe", executionMode: "sequential",
    description: "Internal guarded append of a decision already prepared by the owning workflow.",
    parameters: Type.Object({ path: cell, content: cell, expectedSha256: cell, expectedBytes: Type.Integer({ minimum: 1 }) }),
    async execute(args, api, ctx) {
      const task = await api.getTask(api.taskId, ctx);
      const input = z.object({ kind: z.literal("nested"), key: z.literal(nestedKey) }).safeParse(task?.input);
      if (!input.success || !task?.owner) throw new Error("Decision append requires its owning workflow operation.");
      const parent = await api.getTask(task.owner, ctx);
      const intent = parseIntent.parse(parent?.memos?.[receiptMemo]);
      await owner(api, ctx);
      await checkRun(options, intent, api, ctx);
      if (args.path !== intent.path || args.content !== intent.append || args.expectedSha256 !== intent.expectedSha256 ||
        args.expectedBytes !== intent.expectedBytes) throw new Error("Decision append does not match its durable intent.");
      await api.commit(async tx => {
        const workflow = (await tx.doc(WorkflowState, api.conversationId)).run;
        const doc = await tx.doc(PstackTrailReceipts, api.conversationId);
        checked(options, ctx);
        if (workflow?.task !== intent.task || workflow.run !== intent.run || workflow.phase !== "running") throw new Error("Workflow no longer owns the append.");
        if (doc.writing?.operation === api.taskId) return;
        if (doc.writing) throw new Error("Another decision append is still pending.");
        doc.writing = { run: intent.run, operation: Number(api.taskId) };
        workflow.revision++;
      }, ctx);
      const rows = intent.rows.map((row, i) => ({ path: intent.path, row, line: intent.line + i, run: intent.run, task: intent.task,
        operation: Number(task.owner), toolTaskId: Number(api.taskId), decisionKey: intent.decisionKey }));
      try {
        await appendTrailBytes(options.cwd, intent, () => checked(options, ctx), ctx.abortSignal);
        const bytes = await scanTrail(options.cwd, intent.path, { prefixBytes: intent.expectedBytes, signal: ctx.abortSignal });
        if (bytes.prefixHash !== intent.expectedSha256) throw new Error("Decision append did not match its expected bytes.");
        await api.commit(async tx => {
          const doc = await tx.doc(PstackTrailReceipts, api.conversationId);
          if (!doc.rows.some(r => r.operation === task.owner && r.run === intent.run)) doc.rows.push(...rows);
          delete doc.writing;
        }, withoutAbortSignal(ctx));
      } catch (error) {
        await api.commit(async tx => {
          const doc = await tx.doc(PstackTrailReceipts, api.conversationId);
          if (doc.writing?.operation === api.taskId) delete doc.writing;
        }, withoutAbortSignal(ctx));
        throw error;
      }
      return { output: [{ type: "text", text: "Decision bytes appended." }] };
    },
  });
}

async function receipts(api: Api, ctx: Context) {
  return (await api.snapshot(PstackTrailReceipts, api.conversationId, ctx))?.rows ?? [];
}

export async function appendPstackDecision(options: WorkflowOptions, run: WorkflowRun, decision: Decision | undefined, api: Api, ctx: Context) {
  const requests = (await transcript(api, ctx, run.first)).flatMap(e => e.kind === "pi.user" || e.kind === "mybuddy.user" ? (e.model ?? []).flatMap(m =>
    m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n")] : []) : [])
    .filter(t => !t.startsWith("[MyBuddy pstack "));
  const readOnly = /(?:read[- ]only\s+task|leave\s+(?:all\s+)?(?:(?:project|workspace|repo(?:sitory)?)\s+)?files\s+unchanged|(?:do\s+not|don't|never)\s+(?:write|create|edit|modify|change)\s+(?:(?:any|the)\s+)?(?:(?:project|workspace|repo(?:sitory)?)\s+)?files\b|(?:本次|这次|仅限|全程)只读|(?:不要|不得|禁止)(?:新建|改动|写入|修改)(?:任何|任何的)?(?:项目|工作区|仓库)?(?:的)?文件)/i;
  if (run.playbook === "investigation" || requests.some(t => readOnly.test(t)))
    throw new Error("This read-only task cannot append a workspace decision log. Retain your observations in the current conversation and continue the stage.");
  if (!decision) throw new Error("Pass decision with phase, decision, why, evidence and result.");
  const fields = [decision.phase, decision.decision, decision.why, decision.evidence, decision.result].map(clean);
  if (fields[0].toLowerCase() === "start") throw new Error("The host writes start rows for changes of session ownership.");
  const path = currentPath(run);
  const decisionKey = decision.id ? "id:" + decision.id : "auto:" + digest(JSON.stringify([run.stage, fields]));
  return forPath((await trailTarget(options.cwd, path)).path, async () => {
    await checkRun(options, run, api, ctx);
    const history = (await receipts(api, ctx)).filter(r => r.task === run.task && r.path === path);
    const recorded = history.filter(r => r.run === run.run && (r.operation === api.taskId || r.decisionKey === decisionKey)).at(-1);
    if (recorded) {
      let match = false;
      await readLog(options, path, api, ctx, "confirm-existing-decision", { visit: (line, row) => { if (line === recorded.line) match = row === recorded.row; } });
      if (recorded.row.split("\t").slice(1).join("\t") !== fields.join("\t")) throw new Error("Decision ID already belongs to a different entry.");
      if (!match) throw new Error("Recorded decision was rewritten.");
      return recorded;
    }
    let intent = await api.memo<TrailIntent>(receiptMemo, ctx);
    if (!intent) {
      const lastOwn = history.at(-1);
      let intact = !lastOwn, from = "";
      const old = await readLog(options, path, api, ctx, "inspect-decision-log", { visit: (line, row) => {
        if (line === lastOwn?.line) intact = row === lastOwn.row;
        if (line === (lastOwn?.line ?? 1) + 1) from = row.split("\t", 1)[0];
      } });
      if (!intact) throw new Error("An earlier decision was rewritten. Inspect the canonical log.");
      const rows: string[] = [], stamp = new Date().toISOString();
      if (old.count > 1 && (!lastOwn || lastOwn.line !== old.count)) {
        const to = old.last.split("\t", 1)[0];
        rows.push([stamp, "start", `接续 ${from} 至 ${to} 的已有记录`, "区分其他会话的记录", clean(`mybuddy:${run.task}/${api.conversationId}`), "open"].join("\t"));
      }
      rows.push([stamp, ...fields].join("\t"));
      const append = (old.needsTerminator ? old.newline : "") + [...(old.count ? [] : [header]), ...rows].join(old.newline) + old.newline;
      const beforeHash = old.hash.copy().digest("hex"), expectedSha256 = old.hash.update(append).digest("hex");
      intent = await api.memo(receiptMemo, { task: run.task, run: run.run, path, decisionKey, beforeHash, beforeBytes: old.size,
        append, expectedSha256, expectedBytes: old.size + Buffer.byteLength(append), rows, line: Math.max(old.count, 1) + 1, existed: old.existed }, ctx);
    }
    await checkRun(options, run, api, ctx);
    const child = await api.executeTool(name, { path, content: intent.append, expectedSha256: intent.expectedSha256, expectedBytes: intent.expectedBytes }, ctx, { key: nestedKey });
    if (child.isError) throw new Error("Decision append failed: " + JSON.stringify(child.diagnostics) + " " + String(child.structuredOutput ?? ""));
    const verify = await readLog(options, path, api, ctx, "read-appended-decision", { prefixBytes: intent.expectedBytes });
    if (verify.prefixHash !== intent.expectedSha256) throw new Error("Decision bytes were not confirmed.");
    const confirmed = (await receipts(api, ctx)).filter(r => r.operation === api.taskId && r.toolTaskId === child.taskId).at(-1);
    if (!confirmed) throw new Error("Missing durable decision receipt.");
    return confirmed;
  });
}

export async function hasPstackDecisions(run: WorkflowRun, api: Api, ctx: Context) {
  const doc = await api.snapshot(PstackTrailReceipts, api.conversationId, ctx);
  return doc?.writing?.run === run.run || !!doc?.rows.some(r => r.task === run.task && r.run === run.run);
}

export async function auditPstackDecisions(options: WorkflowOptions, run: WorkflowRun, api: Api, ctx: Context) {
  await checkRun(options, run, api, ctx);
  const path = currentPath(run);
  const doc = await api.snapshot(PstackTrailReceipts, api.conversationId, ctx);
  if (doc?.writing?.run === run.run) throw new Error("Wait for the pending decision append before auditing.");
  const recorded = (doc?.rows ?? []).filter(r => r.task === run.task && r.run === run.run && r.path === path);
  if (!recorded.length) throw new Error("No native decision rows have been recorded for this workflow.");
  const byLine = new Map(recorded.map(r => [r.line, r]));
  const rows: Array<Receipt | { line: number; row: string; provenance: "unconfirmed" }> = [];
  let owned = false;
  const actual = await readLog(options, path, api, ctx, "audit-decision-rows", { visit: (line, row) => {
    const entry = byLine.get(line);
    if (entry) {
      if (entry.row !== row) throw new Error("Recorded evidence differs at decision log line " + line);
      rows.push(entry); owned = true;
    } else if (row.split("\t", 2)[1] === "start") owned = false;
    else if (owned) rows.push({ line, row, provenance: "unconfirmed" });
  } });
  if (actual.count < recorded.at(-1)!.line) throw new Error("Decision log is shorter than its recorded receipts.");
  return { path, rows, fingerprint: digest(JSON.stringify(rows)) };
}
