import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Inspect the real participant inputs omitted from the general live-run report.
// Only the disposable workflow path named by the caller is opened.
const directory = process.argv[2], evidence = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
if (evidence.route !== "eval") throw Error("Select a live eval case.");
const sha = value => createHash("sha256").update(value).digest("hex");
const db = new DatabaseSync(join(evidence.root,".mybuddy","durable",sha("work-item"),"durable.sqlite"),{readOnly:true});
try {
  db.exec("BEGIN");
  const rows = db.prepare("SELECT conversation_id,record FROM entries ORDER BY id").all(), chats = new Map();
  for (const row of rows) {
    const messages = chats.get(row.conversation_id) ?? [];
    messages.push(...JSON.parse(row.record).model ?? []); chats.set(row.conversation_id,messages);
  }
  const text = m => typeof m.content === "string" ? m.content : m.content.filter(p=>p.type==="text").map(p=>p.text).join("\n");
  const status = existsSync(join(directory,"evidence.json")) ? JSON.parse(readFileSync(join(directory,"evidence.json"),"utf8")) : null;
  const latest = !status && db.prepare("SELECT r.content FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=? AND r.kind='base' ORDER BY r.seq DESC LIMIT 1").get(JSON.stringify("mybuddy.pstack-run"));
  const workflow = status?.workflow ?? (latest && JSON.parse(latest.content).run);
  const saved = workflow?.contests?.eval;
  const actors = [...chats].filter(([id])=>id!==Math.min(...chats.keys())).map(([id,messages]) => {
    const user = messages.filter(m=>m.role==="user").map(text);
    const model = messages.filter(m=>m.role==="assistant" && !m.errorMessage).at(-1);
    let scale;
    try { scale = JSON.parse(user[0].split("\n")[1]); } catch {}
    const range=scale?.submissions && /integer from (-?\d+) to (-?\d+)/.exec(user[0]);
    let ratings;
    if (scale?.submissions && model) try { ratings=JSON.parse(text(model).trim().replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/,"")).scores; } catch {}
    return { id, model: model && model.provider+"/"+model.model, received: user, hashes: user.map(sha), ordinaryMatchesFrozen: saved && user.every(u=>u===saved.prompt),
      judgeCriteria: scale?.criteria?.length, judgeLabels: scale?.submissions?.map(s=>s.label), outputs: scale?.submissions?.map(s=>sha(s.text)),
      ...(range && {judgeRange:[Number(range[1]),Number(range[2])],judgeCriteriaText:scale.criteria}),
      ...(ratings && {ratings:ratings.map(r=>({label:r.label,ratings:r.ratings}))}),
      ...(evidence.arm==="original" && { reply: model && text(model),
        accessed:messages.flatMap(m=>m.role==="assistant" && Array.isArray(m.content)
          ? m.content.filter(p=>p.type==="toolCall").map(p=>({tool:p.name,path:p.arguments?.path ?? p.arguments?.name ?? p.arguments?.file,command:p.arguments?.command}))
          : []) }),
      tools: messages.filter(m=>m.role==="toolResult").map(m=>({name:m.toolName,failed:!!m.isError})) };
  });
  const judged=actors.find(a=>a.judgeLabels);
  const exported=workflow?.evalExport?.files.map(file=>{
    const path=resolve(evidence.cwd,file.path), rel=relative(evidence.cwd,path);
    if (!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)) throw Error("Out-of-scope export path.");
    const bytes=existsSync(path) ? readFileSync(path) : null, hash=bytes && sha(bytes);
    const index=judged?.judgeLabels.indexOf(file.label) ?? -1;
    let matchesCriteria, matchesScale;
    if (file.label==="Rubric" && bytes && judged) {
      const rubric=JSON.parse(bytes), numericKeys=Object.keys(rubric.scale ?? {}).filter(k=>/^-?\d+$/.test(k)).map(Number);
      const range=rubric.scale?.min!==undefined ? [rubric.scale.min,rubric.scale.max] : numericKeys.length ? [Math.min(...numericKeys),Math.max(...numericKeys)] : [1,5];
      matchesCriteria=JSON.stringify(rubric.criteria ?? rubric)===JSON.stringify(judged.judgeCriteriaText);
      matchesScale=JSON.stringify(range)===JSON.stringify(judged.judgeRange);
    }
    return {label:file.label,path:file.path,hash,receiptMatches:hash===file.sha256,matchesCriteria,matchesScale,...(index>=0 && {equalsJudgedDocument:judged.outputs[index]===hash})};
  });
  console.log(JSON.stringify({directory, arm:evidence.arm, referenceRoles:Object.keys(evidence.roleDefinitions ?? {}), state:workflow?.phase ?? "no checkpoint", expired:status?.expired, error:status?.error,
    rubricCount:evidence.controls?.route?.rubricCount, submissions:workflow?.delegates?.map(r=>({role:r.role,models:r.models,participants:r.participants})), exported, actors },null,2));
} finally { db.close(); }
