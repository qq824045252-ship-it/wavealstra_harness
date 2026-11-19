import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { z } from "zod";
import { workspaceDocumentPath } from "../../../shared/pstack/paths";
import { candidateReceipt, publicSubmissions } from "./PstackContest";
import { digest, guardedWorkspaceTarget } from "./PstackDecisionFile";
import { checked, owner, state, type Api, type WorkflowRun, type WorkflowOptions } from "./PstackState";
import { readPlanFile } from "./PstackWorkspace";

export type EvalExport = { directory: string; files: { label:string; path:string; sha256:string }[] };
const toolName = "pstack_eval_save";
const memo = "pstack-eval-files";
const intent = z.object({run:z.number(),files:z.array(z.object({path:z.string(),sha256:z.string()}))});
const inspect = (path:string) => lstat(path).catch(e=>{
  if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw e;
});

export function requestedEvalFiles(text:string) {
  return text.replace(/^\s*>[^\n]*/gm,"").split(/[\n。；;!?！？]/).some(clause =>
    !/\b(?:do not|don't|never|without|avoid)\b[^.]{0,80}\b(?:save|saving|write|writing|export|persist)|(?:不要|无需|不用|不必|禁止|别).{0,30}(?:保存|导出|写入|落盘)/i.test(clause) &&
    /\b(?:save|write|persist|export)\b.{0,100}(?:rubric\.json|anonymi[sz]ed (?:outputs?|documents?|files?))|(?:保存|落盘|导出|写入).{0,100}(?:rubric\.json|评分表|匿名(?:结果|产物|输出|文件))/i.test(clause));
}

export async function checkEvalExport(cwd:string, report:EvalExport) {
  for (const file of report.files) {
    await guardedWorkspaceTarget(cwd, workspaceDocumentPath(file.path,"匿名产物"));
    if ((await readPlanFile(cwd,file.path)).digest !== file.sha256)
      throw Error("Saved evaluation artifact changed: " + file.path + ". Re-export to a new directory before delivery.");
  }
}

export async function saveEvalDocument(cwd:string, safe:string, content:string, token:string, check:()=>void|Promise<void>) {
  const parts=safe.split("/"), temporaryName="."+parts.pop()+"."+token+".tmp", relativeTemporary=[...parts,temporaryName].join("/");
  // Only ancestors are shared. The temporary basename is an operation-specific,
  // durable nonce so a retry can identify its own interrupted publication.
  const guard=await guardedWorkspaceTarget(cwd,[...parts,".directory-"+token].join("/"),true);
  const target=join(dirname(guard.path),basename(safe)), pending=join(dirname(guard.path),temporaryName);
  const [before,staged]=await Promise.all([inspect(target),inspect(pending)]);
  const bytes=Buffer.from(content);
  if (staged) {
    if (!staged.isFile() || !staged.ino || staged.size>bytes.length) throw Error("Unrecognized temporary export file was preserved.");
    if (before && before.ino===staged.ino && before.dev===staged.dev && before.nlink===2 && staged.nlink===2) {
      if ((await readPlanFile(cwd,relativeTemporary)).digest!==digest(content)) throw Error("Linked export bytes changed before recovery.");
      await unlink(pending);
    } else if (staged.nlink!==1 || before) throw Error("Temporary export file no longer belongs to this publication.");
  }
  if (!before) {
    const flags=constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (staged ? 0 : constants.O_CREAT | constants.O_EXCL);
    const handle=await open(pending,flags,0o600);
    try {
      try {
        if (staged) {
          const actual=await handle.stat();
          if (actual.ino!==staged.ino || actual.dev!==staged.dev || actual.nlink!==1) throw Error("Temporary export identity changed.");
          const prior=Buffer.alloc(actual.size);
          const {bytesRead}=await handle.read(prior,0,prior.length,0);
          if (bytesRead!==prior.length || !bytes.subarray(0,prior.length).equals(prior)) throw Error("Temporary export contains unrelated data.");
        }
        await handle.writeFile(bytes); await handle.sync();
      } finally { await handle.close(); }
      await check();
      await guardedWorkspaceTarget(cwd,[...parts,".directory-"+token].join("/"));
      try { await link(pending,target); } catch (error) { if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error; }
    } finally {
      // Failed verification of a pre-existing staging file preserves its bytes.
      if (!staged || (await readPlanFile(cwd,relativeTemporary)).digest===digest(content)) await unlink(pending);
    }
  }
  await guardedWorkspaceTarget(cwd,safe);
  if ((await readPlanFile(cwd,safe)).digest!==digest(content)) throw Error("Existing file was preserved: " + safe + ". Choose a fresh export directory.");
}

/** The only writer of these artifacts prepares complete bytes off-path and
 * publishes with an exclusive hard link. Existing unrelated files survive. */
export function createEvalSave(options:WorkflowOptions):ToolRegistration {
  return defineTool({name:toolName,callers:["tools"],replay:"safe",executionMode:"sequential",
    description:"Save a frozen anonymous document for its owning evaluation.",
    parameters:Type.Object({path:Type.String(),content:Type.String()}),async execute({path,content},api,ctx) {
      await owner(api,ctx);
      const task=await api.getTask(api.taskId,ctx), parent=task?.owner && await api.getTask(task.owner,ctx);
      const plan=intent.parse(parent?.memos?.[memo]), run=await state(api,ctx);
      if (!z.object({kind:z.literal("nested")}).safeParse(task?.input).success || !run || run.task!==options.taskId || run.run!==plan.run || run.playbook!=="eval" || run.phase!=="running"
        || !plan.files.some(f=>f.path===path && f.sha256===digest(content))) throw Error("The export does not match the owning evaluation.");
      checked(options,ctx);
      const token=await api.memo<string>("publication-id",ctx) ?? await api.memo("publication-id",randomUUID(),ctx);
      await saveEvalDocument(options.cwd,workspaceDocumentPath(path,"匿名产物"),content,token,async()=>{
        checked(options,ctx);
        const current=await state(api,ctx);
        if (current?.run!==plan.run || current.task!==options.taskId || current.phase!=="running")
          throw Error("The owning evaluation changed before publication.");
        checked(options,ctx);
      });
      return {output:[{type:"text",text:path}]};
    }});
}

export async function exportEval(options:WorkflowOptions,run:WorkflowRun,directory:string,api:Api,ctx:Context):Promise<EvalExport> {
  const contest=run.contests?.eval;
  if (!contest || run.playbook!=="eval" || !run.delegates.some(r=>r.stageId==="judge" && r.role==="arena-cross-judge")) throw Error("A sealed comparison with a completed judge is required.");
  const prefix=directory === "." ? "" : workspaceDocumentPath(directory,"导出目录")+"/";
  const scale=contest.scale ?? {min:1,max:5};
  const documents=[{label:"Rubric",path:prefix+"rubric.json",content:JSON.stringify({criteria:contest.criteria,scale},null,2)+"\n"},
    ...publicSubmissions(candidateReceipt(run,"eval")).map((s,i)=>({label:s.label,path:prefix+"Document-"+(i+1)+".md",content:s.text}))];
  const priorIntent=intent.safeParse(await api.memo(memo,ctx));
  // A pre-existing rubric may contain extra metadata. Keep it only when its
  // actual criteria and numeric scale describe exactly what the judge used.
  for (const doc of documents) {
    if (priorIntent.success) {
      const expected=priorIntent.data.files.find(f=>f.path===doc.path);
      if (priorIntent.data.run!==run.run || !expected) throw Error("Export scope changed during recovery.");
      if (digest(doc.content)!==expected.sha256) {
        const saved=await readPlanFile(options.cwd,doc.path);
        if (saved.digest!==expected.sha256) throw Error("The saved rubric changed during recovery.");
        doc.content=saved.text;
      }
      continue;
    }
    const target=await guardedWorkspaceTarget(options.cwd,doc.path);
    if (!target.info) continue;
    const actual=await readPlanFile(options.cwd,doc.path);
    if (actual.text===doc.content) continue;
    if (doc.label==="Rubric") {
      let parsed;
      try { parsed=JSON.parse(actual.text); } catch {}
      const prior=parsed?.scale, keys=prior && Object.keys(prior).filter(k=>/^-?\d+$/.test(k)).map(Number);
      const min=prior?.min ?? (keys?.length ? Math.min(...keys):1), max=prior?.max ?? (keys?.length ? Math.max(...keys):5);
      if ((prior===undefined || keys?.length>1 || Number.isInteger(prior?.min) && Number.isInteger(prior?.max)) &&
        JSON.stringify(parsed?.criteria ?? parsed)===JSON.stringify(contest.criteria) && min===scale.min && max===scale.max) { doc.content=actual.text; continue; }
    }
    throw Error("Existing file was preserved: "+doc.path+". Supply artifactDirectory naming a fresh workspace directory for the canonical set.");
  }
  const report={directory,files:documents.map(d=>({label:d.label,path:d.path,sha256:digest(d.content)}))};
  await api.memo(memo,{run:run.run,files:report.files},ctx);
  for (const doc of documents) {
    const saved=await api.executeTool(toolName,{path:doc.path,content:doc.content},ctx,{key:"save-"+doc.label});
    if (saved.isError) throw Error("Cannot export "+doc.path+": "+JSON.stringify(saved.diagnostics));
  }
  await checkEvalExport(options.cwd,report);
  return report;
}
