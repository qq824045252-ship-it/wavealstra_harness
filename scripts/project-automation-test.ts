/**
 * 项目配置自动化：按项目过滤任务 / 运行记录 / 保存时绑定。
 */
import assert from "node:assert/strict";
import type { CronJobDto, CronRunDto } from "../src/shared/agent-ipc";
import {
  jobsForProject,
  resolveJobProjectId,
  runsForJobs,
} from "../src/renderer/src/lib/projectAutomation";

function job(id: string, projectId?: string): CronJobDto {
  return {
    id,
    name: id,
    prompt: "do",
    scheduleType: "cron",
    scheduleExpr: "0 0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    projectId,
  };
}

function run(id: string, jobId: string): CronRunDto {
  return { id, jobId, startedAt: 1, status: "success" };
}

{
  const jobs = [job("g1"), job("p1", "proj-a"), job("p2", "proj-b"), job("p3", "proj-a")];
  assert.deepEqual(
    jobsForProject(jobs).map((item) => item.id),
    ["g1", "p1", "p2", "p3"],
    "no scope → all jobs",
  );
  assert.deepEqual(
    jobsForProject(jobs, "proj-a").map((item) => item.id),
    ["p1", "p3"],
    "project scope filters by projectId",
  );
  assert.deepEqual(jobsForProject(jobs, "missing").map((item) => item.id), [], "unknown project → empty");
}

{
  const jobs = [job("p1", "proj-a"), job("g1")];
  const runs = [run("r1", "p1"), run("r2", "g1"), run("r3", "gone")];
  assert.deepEqual(
    runsForJobs(runs, jobsForProject(jobs, "proj-a")).map((item) => item.id),
    ["r1"],
    "project history only includes that project's jobs",
  );
}

{
  assert.equal(resolveJobProjectId({ scopeProjectId: "proj-a" }), "proj-a", "new job in project modal binds");
  assert.equal(resolveJobProjectId({}), undefined, "new job on global page stays unbound");
  assert.equal(
    resolveJobProjectId({ existingProjectId: "proj-a", scopeProjectId: "proj-b" }),
    "proj-a",
    "edit keeps original binding",
  );
}

console.log("project-automation-test: PASS");
