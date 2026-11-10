import { createInterface } from "node:readline";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { reviewWork } from "../src/main/agent/work/WorkReviewControl";
import { LOCAL_USER_ID, DEFAULT_BOT_ID, type WorkActor } from "../src/shared/bot-work";
const db = new AppDatabase(process.argv[2]); const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
const works = new WorkService(db.connection, { bots });
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
if (!works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length) {
  for (const title of ["已完成的文档", "执行失败的查询", "正在执行的任务"]) {
    const result = works.createWork(actor, { operationId: title, title, criteria: [{ id: "done", text: "任务完成" }], inputSnapshotId: "archive-fixture", authorization: DESKTOP_USER_GRANTS });
    if (!result.ok) throw Error(result.message);
    const work = result.work;
    if (title === "已完成的文档") works.repo.updateWork({ ...work, lifecycle: "closed", closureConclusion: "succeeded" });
    else {
      const dispatch = works.dispatchExecution(actor, { operationId: "dispatch:" + title, workId: work.workId, botId: DEFAULT_BOT_ID, taskId: "task:" + title, durableStoreKey: "store:" + title, conversationId: "conversation:" + title, workspaceBinding: process.argv[3] });
      if (!dispatch.ok) throw Error(dispatch.message);
      if (title === "执行失败的查询") works.reconcileExecution(actor, { bindingId: dispatch.work.activeExecutionIds.at(-1)!, outcome: "failed" });
    }
  }
}
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, request } = JSON.parse(line);
  try { const result = method === "list" ? works.listProjections(LOCAL_USER_ID, { includeClosed: true }) : reviewWork(works, actor, request);
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id, error: String(error) }) + "\n"); }
});
