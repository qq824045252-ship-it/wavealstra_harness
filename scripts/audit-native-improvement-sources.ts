import Database from "better-sqlite3";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {BACKGROUND_CONTEXT as ctx} from "@earendil-works/chord/context";
import type {Cursor} from "@earendil-works/pi-durable";
import {openDurablePassiveStorage} from "../src/main/agent/durable/DurableStorage";
import {readImprovementChild} from "../src/main/agent/hooks/ImprovementChildHistory";

const directory = resolve(process.argv[2] ?? join(homedir(),".mybuddy"));
const db = new Database(join(directory,"app.db"),{readonly:true,fileMustExist:true});
const bindings = db.prepare("SELECT task_id,directory FROM durable_bot_bindings").all() as {task_id:string; directory:string}[];
const totals = {bindings:bindings.length,readable:0,tasksWithChildren:0,children:0,handoffs:0,handoffAnswered:0,
  handoffUnanswered:0,steers:0,tools:0,parentReturns:0,outcomes:{} as Record<string,number>};
const issues: string[] = [];
try {
  for (const [index,b] of bindings.entries()) {
    try {
      const storage = await openDurablePassiveStorage(b.directory,ctx);
      if (!storage) throw new Error("原生存储不可用");
      try {
        let count = 0, cursor: Cursor | undefined;
        do {
          const page = await storage.scanConversations({},64,cursor,ctx);
          for (const c of page.items) {
            const evidence = await readImprovementChild(storage,b.task_id,c,false);
            if (!evidence) continue;
            count++;
            totals.handoffs += evidence.submissions.length;
            totals.handoffAnswered += evidence.submissions.filter(s => s.status==="done").length;
            totals.handoffUnanswered += evidence.submissions.filter(s => s.status==="unanswered").length;
            totals.steers += evidence.steers.length;
            totals.tools += evidence.tools.length;
            totals.parentReturns += Number(evidence.parentReturnEntry !== undefined);
            const status = evidence.child.status;
            totals.outcomes[status] = (totals.outcomes[status] ?? 0) + 1;
          }
          cursor = page.next;
        } while (cursor);
        totals.readable++; totals.children += count; totals.tasksWithChildren += Number(count>0);
      } finally { await storage.close(ctx); }
    } catch (e) { issues.push("绑定 #" + (index+1) + " · " + String(e)); }
  }
  const diagnostics = (table: "task_request_diagnostics" | "task_tool_diagnostics") =>
    db.prepare("SELECT count(*) FROM " + table + " WHERE json_extract(record_json,'$.sourceKind')='subagent'").pluck().get();
  console.log(JSON.stringify({...totals,childRequestDiagnostics:diagnostics("task_request_diagnostics"),
    childToolDiagnostics:diagnostics("task_tool_diagnostics"),hasWeeklyLedger:existsSync(join(directory,"native-improvement.sqlite")),issues},null,2));
  if (issues.length) process.exitCode=1;
} finally { db.close(); }
