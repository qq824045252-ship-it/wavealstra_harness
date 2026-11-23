/**
 * Dots 委派的失败路径回归：可预期失败不得留下挂在「排队中」的空壳任务。
 *
 * 现场（修复前）：派发先 upsertTask 落库，模型可用性校验在 AgentService.prepareDurableTask
 * 里才发生（prompt 内），异常直接向上抛，任务记录既没有终态也没有归档，
 * 看板 taskLane 把 status 为 pending/NULL 的行都算进 pending 栏，于是一条从未开始的任务
 * 永久显示为「排队中」。
 *
 * 本用例覆盖两个层次：
 * 1) 前置校验前移：默认模型在该工作空间不可用时，execute 直接失败，一条任务记录都不建；
 * 2) 残余兜底：预检通过后仍然失败时（A：关联阶段空间目录消失；B：受理阶段模型失效），
 *    委派写入失败原因，任务立刻进入 failed 终态并离开 pending 栏，看板卡片能读到失败原因。
 * 同时确认正常派发路径不受影响，且重跑复用同一任务而不是再建一条。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DotsActionInput } from "../src/main/dots/DotsActions";

const root = mkdtempSync(join(realpathSync.native(tmpdir()), "dots-dispatch-"));
process.env.MYBUDDY_DISABLE_GOAL_CONTINUATION = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
const folder = join(root, "client");
mkdirSync(folder);
writeFileSync(join(folder, "input.txt"), "客户档案编号 A456");

const { DOTS_TASK_ID } = await import("../src/shared/dots");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { DotsDelegations } = await import("../src/main/dots/DotsDelegations");
const { NotificationService } = await import("../src/main/notification/NotificationService");
const { TaskBoardRepository } = await import("../src/main/task/TaskBoardRepository");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");

const db = new AppDatabase(join(root, "app.db"));
new (await import("../src/main/artifact/ArtifactRepository")).ArtifactRepository(db.connection);
db.openDots();
const notifications = new NotificationService(db);
const fixture = await createAgentDurableFixture(root, db, () => [{ type: "text", text: "已核对该客户的档案。" }],
  { modelVariants: ["pinned-worker"] });
const agent = fixture.agent;
const journal = new DotsDelegations(db.connection, (...args) => agent.dotsSubmission(...args), () => {});
const board = new TaskBoardRepository(db.connection);
const actions = new DotsActions(db, agent, {
  link: (...args) => journal.link(...args),
  list: () => journal.list(),
  changed: () => journal.refresh(),
  failed: (...args) => journal.failed(...args),
  // 与 src/main/index.ts 的接线一致：失败原因写进 task.failed 通知，看板卡片因此能显示原因。
  failedTask: event => {
    notifications.publish({ type: "task.failed", level: "error", title: "任务派发失败", body: `${event.title} · ${event.reason}`,
      sourceType: "task", sourceId: event.taskId, taskId: event.taskId, dedupeKey: `task:${event.taskId}:dispatch-failed` });
  },
});
agent.setDotsActions(actions);

const record = (value: unknown) => value as Record<string, unknown>;
const dispatch = (source: string, input: DotsActionInput, text: string) =>
  actions.execute(DOTS_TASK_ID, source, input, text);
const tasks = () => db.connection.prepare("SELECT id,title,status FROM tasks WHERE id<>? ORDER BY id").all(DOTS_TASK_ID) as
  Array<{ id: string; title: string; status: string | null }>;
const lane = (id: "pending" | "attention" | "finished", spaceId: string) =>
  board.page({ view: id === "attention" ? "attention" : "all", lane: id, scope: spaceId }).rows;
/** 状态投射跟随后台快照写入，这里等到库里的终态真正就位。 */
const settled = async (taskId: string, expected: string, label: string) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await agent.loadTaskHistory(taskId);
    if (db.getTask(taskId)?.status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(db.getTask(taskId)?.status, expected, label);
};

try {
  const spaceId = String(record(await dispatch("setup-bind", { action: "bind", name: "客户 A", path: folder }, "客户 A")).id);
  assert(spaceId, "绑定工作空间");

  // 1) 正常派发不受影响。
  const accepted = record(await dispatch("dots-user-1", { action: "delegate", spaceId, name: "客户报价", text: "读取客户档案" }, "读取客户档案"));
  assert(accepted.receipt, "正常派发返回持久受理回执：" + JSON.stringify(accepted));
  const normal = tasks();
  assert.equal(normal.length, 1);
  const normalId = normal[0]!.id;
  assert.equal(db.getTask(normalId)?.spaceId, spaceId);
  const normalDelegation = journal.list(["dots-user-1"])[0];
  assert.equal(normalDelegation?.taskId, normalId);
  await agent.waitForSubmission(accepted.receipt as never);
  await settled(normalId, "completed", "正常派发跑到终态");
  assert.equal(lane("pending", spaceId).length, 0, "正常任务不留在排队中");
  console.log("PASS 正常派发：建任务、受理、跑完、离开 pending 栏");

  // 2) 前置校验前移：默认模型在该工作空间不可用时，一条任务记录都不能建。
  await agent.updateAppSettings({ enabledModels: ["fixture/pinned-worker"] });
  await assert.rejects(
    dispatch("dots-user-2", { action: "delegate", spaceId, name: "模型不可用的交办", text: "核对客户回款" }, "核对客户回款"),
    /主对话默认模型 fixture\/model 在这个工作空间不可用/,
    "模型不可用必须由前置校验抛出原失败原因",
  );
  assert.deepEqual(tasks().map(task => task.id), [normalId], "可预期失败不得留下空壳任务记录");
  assert.equal(journal.list(["dots-user-2"]).length, 0, "被前置校验挡下的交办不落库");
  assert.equal(lane("pending", spaceId).length, 0, "被挡下的交办不出现在排队中");
  assert.equal(lane("attention", spaceId).filter(row => row.status === "failed").length, 0);
  console.log("PASS 前置校验：模型不可用在建任务之前挡住，没有空壳、没有排队中");

  // 3) 残余兜底 A：建任务之后、委派关联阶段才失败（空间目录消失）也必须回写终态。
  await agent.updateAppSettings({ enabledModels: ["fixture/model", "fixture/pinned-worker"] });
  rmSync(folder, { recursive: true, force: true });
  const linkStageError = await dispatch("dots-user-3", { action: "delegate", spaceId, name: "目录失效的交办", text: "整理客户回款" }, "整理客户回款")
    .then(() => undefined, (error: unknown) => error);
  assert(linkStageError instanceof Error, "建任务之后的失败必须把原因抛回 Dots");
  const linkReason = linkStageError.message;
  assert.match(linkReason, /工作文件夹不可用|Bot 工作目录不存在|ENOENT/);
  const created = tasks().find(task => task.title === "目录失效的交办");
  assert(created, "建任务之后才失败时任务记录存在，但必须是终态");
  assert.equal(db.getTask(created.id)?.status, "failed", "建任务之后失败必须回写失败状态，不能悬挂在 pending");
  const createdDelegation = journal.list(["dots-user-3"])[0];
  assert.equal(createdDelegation?.status ?? "missing", "missing", "关联阶段就失败时不留下 pending 委派");
  const byReason = <T extends { id: string }>(rows: T[]) => rows.filter(row => row.id === created.id);
  assert.equal(byReason(lane("pending", spaceId)).length, 0, "失败的空壳任务不在 pending 栏");
  assert.equal(byReason(lane("finished", spaceId)).length, 0, "也不冒充已完成");
  const attention = byReason(lane("attention", spaceId))[0];
  assert(attention, "失败任务进入待处理栏，用户能看到它");
  assert.equal(attention.status, "failed");
  assert.match(attention.failureReason ?? "", /工作文件夹不可用|Bot 工作目录不存在|ENOENT/, "看板卡片带出失败原因");
  console.log("PASS 残余兜底 A：关联阶段失败时任务进 failed 终态、离开排队中、原因可见");

  // 3b) 残余兜底 B：预检通过、受理阶段才失败（这里模拟默认模型在预检之后失效的真实竞态）。
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "input.txt"), "客户档案编号 A456");
  await agent.updateAppSettings({ enabledModels: ["fixture/pinned-worker"] });
  const preflight = agent.assertDelegationAdmissible.bind(agent);
  (agent as unknown as { assertDelegationAdmissible: (spaceId: string) => Promise<void> })
    .assertDelegationAdmissible = async () => {};
  const admitError = await dispatch("dots-user-4", { action: "delegate", spaceId, name: "受理阶段失败的交办", text: "核对客户发票" }, "核对客户发票")
    .then(() => undefined, (error: unknown) => error)
    .finally(() => {
      (agent as unknown as { assertDelegationAdmissible: (spaceId: string) => Promise<void> })
        .assertDelegationAdmissible = preflight;
    });
  assert(admitError instanceof Error, "受理阶段失败必须把原因抛回 Dots");
  assert.match(admitError.message, /主对话默认模型 fixture\/model 在这个工作空间不可用/);
  const admitted = tasks().find(task => task.title === "受理阶段失败的交办");
  assert(admitted, "受理阶段失败时任务记录保留为终态");
  assert.equal(db.getTask(admitted.id)?.status, "failed", "受理阶段失败同样回写失败状态");
  const admittedDelegation = journal.list(["dots-user-4"])[0];
  assert.equal(admittedDelegation?.status, "failed", "已关联的委派也要进入失败终态");
  assert.match(admittedDelegation?.text ?? "", /主对话默认模型 fixture\/model 在这个工作空间不可用/, "委派保留失败原因供 Dots 转述");
  assert.equal(lane("pending", spaceId).filter(row => row.id === admitted.id).length, 0, "受理阶段失败也不在 pending 栏");
  assert.match(lane("attention", spaceId).find(row => row.id === admitted.id)?.failureReason ?? "",
    /主对话默认模型 fixture\/model 在这个工作空间不可用/, "看板卡片带出模型不可用原因");
  await agent.updateAppSettings({ enabledModels: ["fixture/model", "fixture/pinned-worker"] });
  // 重启恢复会打开全部已绑定的普通任务；失败记录不得因此被重新投射回 pending。
  await agent.resumePersistedTasks();
  await agent.loadTaskHistory(admitted.id);
  await agent.loadTaskHistory(created.id);
  assert.equal(db.getTask(admitted.id)?.status, "failed", "重启恢复后受理阶段失败的任务仍是终态");
  assert.equal(db.getTask(created.id)?.status, "failed", "重启恢复后关联阶段失败的任务仍是终态");
  assert.equal(lane("pending", spaceId).filter(row => row.id === admitted.id || row.id === created.id).length, 0,
    "重启恢复后两条失败记录都不回到排队中");
  console.log("PASS 残余兜底 B：受理阶段失败时任务与委派都进 failed 终态、原因可见");

  // 4) 修好目录后沿用同一任务重跑：失败的空壳不会变成第二具空壳。
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "input.txt"), "客户档案编号 A456");
  const retried = record(await dispatch("dots-user-3", { action: "delegate", spaceId, name: "目录失效的交办", text: "整理客户回款" }, "整理客户回款"));
  assert.equal(retried.id, created.id, "同一事项复用原任务，不另建一条");
  await agent.waitForSubmission(retried.receipt as never);
  await settled(created.id, "completed", "复用后的原任务跑到终态");
  assert.equal(tasks().length, 3, "整轮只留下正常任务、受理阶段失败的那条和复用后的原任务");
  console.log("PASS 重跑：复用原任务，修复后正常完成");
  console.log("PASS Dots 委派失败路径不留 pending 空壳");
} finally {
  await fixture.close();
}
