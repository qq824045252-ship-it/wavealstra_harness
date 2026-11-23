import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readLiveCompletion } from "./pstack-live-lineage.mjs";

// Read native SQLite without opening an agent or changing its lease. This
// also recovers observations if a test process exits before exporting JSON.
const batch = resolve(process.argv[2]);
const all = process.argv.includes("--save");
function inspect(path) {
  const meta = JSON.parse(readFileSync(join(path, "run.json"), "utf8"));
  const { result: end, evidenceError } = readLiveCompletion(path, meta);
  if (evidenceError) return { route: meta.route, arm: meta.arm, directory: path, status: "evidence-mismatch", messages: 0, error: evidenceError };
  const interruption = join(path, "interrupted.json");
  if (!end && existsSync(interruption)) return JSON.parse(readFileSync(interruption, "utf8"));
  const dbFile = join(meta.root, ".mybuddy/durable", createHash("sha256").update("work-item").digest("hex"), "durable.sqlite");
  if (!existsSync(dbFile)) return { route: meta.route, arm: meta.arm, status: "initializing" };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const doc = db.prepare("SELECT r.content FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=? AND r.kind='base' ORDER BY r.seq DESC LIMIT 1").get(JSON.stringify("mybuddy.pstack-run"));
    const workflow = end ? end.workflow : doc && JSON.parse(doc.content).run;
    const entries = end ? end.records.slice().sort((a,b) => a.entry-b.entry).map(r => ({
      ...r, errorMessage:r.error, stopReason:r.stop, isError:r.failed, toolName:r.tool,
      content: [...(r.text ? [{type:"text",text:r.text}] : []), ...r.calls.map(c=>({type:"toolCall",name:c.name,arguments:c.args}))],
    })) : db.prepare("SELECT record, conversation_id, id FROM entries ORDER BY id").all().flatMap(row => (JSON.parse(row.record).model ?? [])
      .map(m => ({ ...m, conversation: row.conversation_id, entry: row.id })));
    const rootId = db.prepare("SELECT MIN(id) AS id FROM conversations").get().id;
    const primary = entries.filter(e => e.conversation === rootId);
    const texts = message => Array.isArray(message?.content) ? message.content.filter(x => x.type === "text").map(x => x.text).join("\n") : "";
    const last = primary.filter(e => e.role === "assistant").at(-1);
    const changes = execFileSync("git", ["--no-optional-locks", "-C", meta.cwd, "status", "--short"], { encoding: "utf8", windowsHide: true }).trimEnd();
    const realTools = primary.filter(e => e.role === "toolResult");
    const reasons = realTools.filter(e => e.toolName === "pstack_workflow" && !e.isError).flatMap(e => {
      try { const obj = JSON.parse(texts(e)); return Array.isArray(obj.reasons) ? [obj.reasons] : []; } catch { return []; }
    });
    const stop = last?.stopReason;
    const reached = !end ? "in-flight" : end.operatorRequired ? "operator-required" : end.expired ? "timed-out" : end.error || stop === "error" ? "error"
      : workflow?.phase ?? (stop === "stop" ? "original-returned" : "unfinished");
    return { route: meta.route, arm: meta.arm, directory: path, status: reached,
      start: meta.start, end: end?.end, referenceMode: meta.referenceMode ?? (meta.arm === "original" ? "installed-preset-with-original-text" : "compiled-tools"),
      request: meta.request, rootStop: stop, operatorRequired: end?.operatorRequired, controls: meta.controls,
      stage: workflow?.stage, block: workflow?.block, model: meta.modelId, sourceHash: meta.sourceHash, messages: entries.length,
      observedModels: [...new Set(entries.filter(e => e.role === "assistant" && !e.errorMessage).map(m => m.provider + "/" + m.model))],
      rootTools: Object.fromEntries([...new Set(realTools.map(e => e.toolName))].map(n => [n, realTools.filter(x => x.toolName === n && !x.isError).length])),
      delegates: workflow?.delegates?.map(r => ({ role: r.role, models: r.models, stage: r.stageId })),
      review: workflow?.review && { pass: workflow.review.passed, models: workflow.review.receipt.models, fingerprint: workflow.review.fingerprint,
        reasons: workflow.review.reasons, inspected: workflow.review.inspections, repairs: workflow.review.repairs },
      thermosOutcome: workflow?.thermosOutcome, prBody: workflow?.prBody, publishedPr: workflow?.publishedPr, evalExport: workflow?.evalExport,
      reasons, verification: workflow?.verification, watch: workflow?.watch, plan: workflow?.plan, attention: workflow?.attention,
      changes, last: texts(last).slice(0, 3000), error: end?.error || last?.errorMessage || "",
      lastToolErrors: realTools.filter(e => e.isError).slice(-4).map(e => [e.toolName, texts(e).slice(0, 350)]),
      toolCalls: primary.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === "toolCall").map(c => ({
        id: m.entry, tool: c.name, action: c.arguments.action, role: c.arguments.role, purpose: c.arguments.purpose, stage: c.arguments.stage })) : []) };
  } finally { db.close(); }
}
const results = [];
function visit(dir) {
  if (existsSync(join(dir, "run.json"))) {
    results.push(inspect(dir));
    return;
  }
  for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) visit(join(dir, item.name));
}
visit(batch);
if (all) writeFileSync(join(batch, "observations.json"), JSON.stringify(results, null, 2));
for (const r of results) console.log([r.arm, r.route, r.status, "stage=" + (r.stage ?? "-"), "messages=" + r.messages,
  r.review ? "thermos=" + r.review.pass : "", r.error?.slice(0, 80) || r.block?.slice(0, 70)].filter(Boolean).join(" "));
