/**
 * ProjectCadence 测试：时间边界算法、调度/去重/取消、重启 catch-up、resume 重算去重广播、
 * 时钟注入（跳变/回拨）、远边界钳制、有界 timer、触发仅重算（绝不后台 apply）、
 * proposal 时间跨越收敛、归档项目只读重算、A/B 隔离。
 * 真实 SQLite + 注入 fake scheduler + 可变时钟（确定性，不依赖真实定时器/墙钟）。
 * 每个测试段用独立 fake scheduler，避免跨段 timer 干扰。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import {
  MAX_TIMER_DELAY_MS,
  ProjectCadence,
} from "../src/main/project/ProjectCadence";
import { ProjectAttentionTracker } from "../src/main/project/ProjectAttention";
import type { ProjectAttentionDigestDto } from "../src/shared/project-domain";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-cadence-"));
const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A', 1, 1), ('proj-b', 'B', 1, 1), ('proj-c', 'C', 1, 1)`)
  .run();
// proj-a：t1 近滞（NOW+1d 进入 stale）、t2 已滞（blocker）、t3 completed（排除）、t5 archived（排除）、t6 failed（排除）
db.connection
  .prepare(`INSERT INTO tasks (id, title, updated_at, project_id, status, archived) VALUES
    ('t1', '近滞任务', ${NOW - 6 * DAY}, 'proj-a', 'in_progress', 0),
    ('t2', '已滞任务', ${NOW - 20 * DAY}, 'proj-a', 'in_progress', 0),
    ('t3', '完成任务', ${NOW - 1 * DAY}, 'proj-a', 'completed', 0),
    ('t5', '归档任务', ${NOW - 2 * DAY}, 'proj-a', 'in_progress', 1),
    ('t6', '失败任务', ${NOW - 2 * DAY}, 'proj-a', 'failed', 0),
    ('t4', 'B任务', ${NOW - 1 * DAY}, 'proj-b', 'in_progress', 0)`)
  .run();
projects.createTodo({ projectId: "proj-a", title: "5 天后到期", dueAt: NOW + 5 * DAY });
projects.createTodo({ projectId: "proj-a", title: "1 天后到期", dueAt: NOW + 1 * DAY });
projects.createTodo({ projectId: "proj-a", title: "10 天后到期", dueAt: NOW + 10 * DAY });
projects.createTodo({ projectId: "proj-a", title: "已过期已完成", dueAt: NOW - 1 * DAY, status: "done" });
projects.createTodo({ projectId: "proj-c", title: "C 临期", dueAt: NOW + 2 * DAY });
projects.createTodo({ projectId: "proj-c", title: "C 远期", dueAt: NOW + 100 * DAY });

interface FakeTimer {
  fn: () => void;
  delay: number;
  cancelled: boolean;
}
function makeFakeScheduler(): {
  timers: FakeTimer[];
  scheduler: { schedule: (fn: () => void, ms: number) => FakeTimer; clear: (h: FakeTimer) => void };
} {
  const timers: FakeTimer[] = [];
  return {
    timers,
    scheduler: {
      schedule: (fn, ms) => {
        const t = { fn, delay: ms, cancelled: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        h.cancelled = true;
      },
    },
  };
}

/** 只触发“快照时已存在”的未取消 timer（fire 会追加新 timer，绝不能迭代活数组） */
function firePending(fake: { timers: FakeTimer[] }): number {
  let fired = 0;
  for (const t of [...fake.timers]) {
    if (!t.cancelled) {
      t.fn();
      fired += 1;
    }
  }
  return fired;
}

/** 模拟 index.ts 的真实接线：边界触发 → proposal 重生成 + attention 重算去重广播 + 重排 */
function makeWired(
  service: ProjectService,
  fake: ReturnType<typeof makeFakeScheduler>,
  clock: () => number,
): { cadence: ProjectCadence; tracker: ProjectAttentionTracker; broadcasts: ProjectAttentionDigestDto[] } {
  const tracker = new ProjectAttentionTracker(service);
  const broadcasts: ProjectAttentionDigestDto[] = [];
  const cadence = new ProjectCadence(service, {
    now: clock,
    scheduler: fake.scheduler,
    onBoundary: (projectId) => {
      service.generateActionProposals(projectId, clock());
      const digest = tracker.onChange(projectId, clock());
      if (digest) broadcasts.push(digest);
      cadence.schedule(projectId, clock());
    },
  });
  return { cadence, tracker, broadcasts };
}

async function main(): Promise<void> {
  /* ============ 1. 边界算法 ============ */
  const fake1 = makeFakeScheduler();
  let clock = NOW;
  const raw = new ProjectCadence(projects, { now: () => clock, scheduler: fake1.scheduler });
  const rawFired = new ProjectCadence(projects, {
    now: () => clock,
    scheduler: fake1.scheduler,
    onBoundary: (projectId) => fired.push(projectId),
  });
  const fired: string[] = [];

  const b = raw.nextBoundary("proj-a", NOW);
  ok(b === NOW + 1 * DAY, `1. 最近边界 = min(dueAt-3d, dueAt, updatedAt+7d)（${b} === ${NOW + DAY}）`);
  ok(raw.nextBoundary("proj-a", NOW + 1 * DAY) === NOW + 2 * DAY, "1b. 边界恰在 now 时不重复调度（strict >；此刻尚未越过）");
  ok(raw.nextBoundary("proj-a", NOW + 3 * DAY) === NOW + 5 * DAY, "1c. 越过 due1 与 t1 后，下一个是 near5 的逾期边界");
  ok(raw.nextBoundary("proj-a", NOW + 10 * DAY) === null, "1d. 全部越过/无未来边界 → null");
  ok(raw.nextBoundary("proj-b", NOW) === NOW + 6 * DAY, "1e. B 项目独立边界（t4 updatedAt+7d）");
  // done/completed/archived/failed 排除：只有 active 源贡献边界
  db.connection
    .prepare(`UPDATE project_todos SET status='done' WHERE project_id='proj-a'`)
    .run();
  db.connection
    .prepare(`UPDATE tasks SET status='completed' WHERE project_id='proj-a' AND status != 'failed'`)
    .run();
  ok(raw.nextBoundary("proj-a", NOW) === null, "1f. 全部 done/completed → 无边界");
  db.connection
    .prepare(`UPDATE project_todos SET status='todo' WHERE project_id='proj-a'`)
    .run();
  // 还原 fixture：已过期已完成 todo 回到 done；t3/t6 回到 completed/failed（不被状态还原误伤）
  db.connection
    .prepare(`UPDATE project_todos SET status='done' WHERE project_id='proj-a' AND title='已过期已完成'`)
    .run();
  db.connection
    .prepare(`UPDATE tasks SET status='in_progress' WHERE project_id='proj-a'`)
    .run();
  db.connection.prepare(`UPDATE tasks SET status='completed' WHERE id='t3'`).run();
  db.connection.prepare(`UPDATE tasks SET status='failed' WHERE id='t6'`).run();

  /* ============ 2. 调度/去重/触发 ============ */
  rawFired.schedule("proj-a", NOW);
  rawFired.schedule("proj-a", NOW);
  ok(rawFired.activeCount() === 1, "2. 同项目重复 schedule 只保留一个 timer");
  const activeTimer = fake1.timers.filter((t) => !t.cancelled).pop()!;
  ok(activeTimer.delay === 1 * DAY, "2b. 注入时钟下 delay 精确（1d）");
  // 推进到边界再触发（真实 setTimeout 语义：≥ delay 才 fire）
  clock = NOW + 1 * DAY;
  const before = fake1.timers.length;
  activeTimer.fn();
  ok(fired.includes("proj-a"), "2c. 触发调用 onBoundary");
  ok(activeTimer.cancelled, "2d. 触发的 handle 被显式 clear（不残留）");
  ok(rawFired.activeCount() === 1, "2e. 触发后重排下一个边界（仍单 timer）");
  ok(fake1.timers.length === before + 1, "2f. 触发产生新 timer");
  const nextTimer = fake1.timers.filter((t) => !t.cancelled).pop()!;
  ok(nextTimer.delay === 1 * DAY, "2g. 重排到下一个边界（near5 dueAt-3d = NOW+2d，delay 1d）");
  // 无未来边界 → 不调度过期边界
  clock = NOW + 101 * DAY;
  rawFired.scheduleAll(clock);
  ok(rawFired.activeCount() === 0, "2h. 越过所有边界（含 C 远期 100d）→ 无 timer");

  /* ============ 3. 有界：N 项目 → N timer ============ */
  clock = NOW;
  rawFired.scheduleAll(NOW);
  ok(rawFired.activeCount() === 3, "3. 3 项目 → 3 timer（有界，非每 source 一个）");
  rawFired.scheduleAll(NOW);
  ok(rawFired.activeCount() === 3, "3b. scheduleAll 幂等（先清后建，不叠加）");

  /* ============ 4. 项目删除 → 取消边界（A/B 隔离） ============ */
  rawFired.schedule("proj-a", NOW);
  rawFired.schedule("proj-b", NOW);
  ok(rawFired.activeCount() === 3, "4. A+B+C 各一 timer");
  rawFired.cancel("proj-a");
  ok(rawFired.activeCount() === 2, "4b. 取消 A 不影响 B/C（A/B 隔离）");
  ok(fake1.timers.filter((t) => !t.cancelled).length === 2, "4c. 底层 handle 同步释放");

  /* ============ 5. 重启/resume catch-up ============ */
  const fake5 = makeFakeScheduler();
  clock = NOW;
  const wired = makeWired(projects, fake5, () => clock);
  wired.cadence.scheduleAll(NOW);
  // 模拟关机/休眠错过：状态已变，resume 时 catchUp（重算全部，指纹去重广播）+ scheduleAll（重建未来边界）
  clock = NOW + 30 * DAY;
  wired.cadence.catchUp();
  ok(wired.broadcasts.length === 3, "5. catchUp 对全部项目各触发一次重算（3 项目）");
  const digestA = wired.tracker.getAttention("proj-a", clock);
  ok(digestA !== null && digestA.blockerCount === 0 && digestA.atRiskCount >= 1, "5b. 错过边界后重算即反映真实状态（普通逾期与停滞任务均为 at-risk）");
  const beforeBroadcasts = wired.broadcasts.length;
  wired.cadence.catchUp();
  ok(wired.broadcasts.length === beforeBroadcasts, "5c. 二次 catchUp 指纹去重：无变化不重复广播");
  wired.cadence.scheduleAll(NOW + 101 * DAY);
  ok(wired.cadence.activeCount() === 0, "5d. catch-up 后只调度未来边界（此时全部已过 → 0）");
  // 边界跨越 → 广播变化（digest 前后对比）
  const beforeCross = wired.tracker.getAttention("proj-a", NOW)!;
  clock = NOW + 2 * DAY + 1;
  wired.cadence.catchUp();
  const crossed = [...wired.broadcasts].reverse().find((d) => d.projectId === "proj-a")!;
  ok(crossed !== undefined && crossed.atRiskCount >= beforeCross.atRiskCount, "5e. 边界跨越后 broadcast 反映新的风险/建议指纹");

  /* ============ 6. 触发仅重算：绝不后台 apply；proposal 时间跨越收敛 ============ */
  const fake6 = makeFakeScheduler();
  clock = NOW;
  const wiredC = makeWired(projects, fake6, () => clock);
  wiredC.cadence.scheduleAll(NOW);
  // 此刻 proj-c 唯一边界 = C 临期 dueAt（NOW+2d；dueAt-3d 已过）
  const cTimer = fake6.timers.filter((t) => !t.cancelled).find((t) => t.delay === 2 * DAY)!;
  ok(cTimer !== undefined, "6. proj-c 边界 = dueAt（2d）");
  const todoBefore = projects.listTodos("proj-c").find((t) => t.title === "C 临期")!;
  const appliedBefore = projects.listActionProposals("proj-c").filter((p) => p.status === "applied").length;
  // 真实流程在读取 digest 前先收敛 proposal 层（getProjectAttention/notify 均先 regen）
  projects.generateActionProposals("proj-c", clock);
  const cDigestBefore = wiredC.tracker.getAttention("proj-c", clock)!;
  ok(cDigestBefore.blockerCount === 0 && cDigestBefore.executableProposals === 0, "6a. 边界前 digest 不变（未逾期：无 blocker/无可执行建议）");
  clock = NOW + 2 * DAY + 1;
  firePending(fake6);
  const todoAfter = projects.listTodos("proj-c").find((t) => t.title === "C 临期")!;
  const appliedAfter = projects.listActionProposals("proj-c").filter((p) => p.status === "applied").length;
  ok(todoAfter.status === "todo" && todoAfter.updatedAt === todoBefore.updatedAt, "6b. 边界触发不改业务真源（todo 状态/时间戳未动）");
  ok(appliedAfter === appliedBefore, "6c. 边界触发不产生任何 applied proposal（绝不后台执行）");
  const locateCount = projects.listActionProposals("proj-c").filter((p) => p.actionType === "locate_plan" && p.status === "proposed").length;
  ok(locateCount >= 1, "6d. 时间跨越后确定性重生成收敛：逾期 todo 仅出现定位建议");
  const cDigest = wiredC.tracker.getAttention("proj-c", clock);
  ok(cDigest !== null && cDigest.executableProposals === 0, "6e. recommendation-only：attention 无可执行建议");

  /* ============ 7. 时钟跳变/回拨 ============ */
  const fake7 = makeFakeScheduler();
  clock = NOW;
  const jumpFired: string[] = [];
  const jumpCadence = new ProjectCadence(projects, {
    now: () => clock,
    scheduler: fake7.scheduler,
    onBoundary: (id) => jumpFired.push(id),
  });
  jumpCadence.schedule("proj-a", NOW);
  const jumpTimer = [...fake7.timers].filter((t) => !t.cancelled).pop()!;
  ok(jumpTimer.delay === 1 * DAY, "7. 注入 now 下 delay 精确（时钟跳变不依赖墙钟）");
  // 回拨：触发时 clock 落后于边界 → 以当前 now 重算重排（不信任旧 timeout，边界不丢）
  clock = NOW - 2 * DAY;
  jumpTimer.fn();
    ok(jumpFired.includes("proj-a"), "7b. 回拨后触发仍执行 onBoundary");
  ok(jumpCadence.activeCount() === 1, "7c. 回拨后边界未丢（重新调度）");
  const rearmed = [...fake7.timers].filter((t) => !t.cancelled).pop()!;
  ok(rearmed.delay === 3 * DAY, `7d. 回拨后 delay 按新 now 重算（1d + 2d 回拨 = 3d，实际 ${rearmed.delay}）`);
  // 前跳：scheduleAll 以新 now 重建（不再信任旧边界）
  clock = NOW + 3 * DAY;
  jumpCadence.scheduleAll(clock);
  ok(jumpCadence.activeCount() === 3, "7e. 前跳后按新 now 重建（3 项目仍有未来边界）");
  const aTimerAfter = fake7.timers.filter((t) => !t.cancelled).find((t) => t.delay === 2 * DAY);
  ok(aTimerAfter !== undefined, "7f. proj-a 下一个边界 = near5 dueAt（NOW+5d，delay 2d）");
  // 远边界钳制：JS timer 上限
  const cFar = jumpCadence.nextBoundary("proj-c", clock)!;
  ok(cFar === NOW + 97 * DAY, "7g. proj-c 远边界 = C 远期 dueAt-3d（NOW+97d）");
  jumpCadence.schedule("proj-c", clock);
  const clamped = fake7.timers.filter((t) => !t.cancelled).find((t) => t.delay === MAX_TIMER_DELAY_MS);
  ok(clamped !== undefined, "7h. 远边界 delay 钳制到 2^31-1 ms（提前触发后重算重排）");

  /* ============ 8. 归档项目：只读 attention 重算仍允许 ============ */
  const fake8 = makeFakeScheduler();
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  const archivedCadence = new ProjectCadence(projects, { now: () => clock, scheduler: fake8.scheduler });
  archivedCadence.schedule("proj-b", clock);
  ok(archivedCadence.activeCount() === 1, "8. 归档项目仍调度边界（只读重算允许）");
  const archivedDigest = new ProjectAttentionTracker(projects).getAttention("proj-b", clock);
  ok(archivedDigest !== null, "8b. 归档项目 attention 可重算（不禁止只读）");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  /* ============ 9. 大量项目：有界 timer（无全库扫描循环） ============ */
  const fake9 = makeFakeScheduler();
  const manyCadence = new ProjectCadence(projects, { now: () => clock, scheduler: fake9.scheduler });
  const bulk = db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)`);
  for (let i = 0; i < 50; i += 1) bulk.run(`bulk-${i}`, `bulk-${i}`);
  const bulkTodo = db.connection.prepare(`INSERT INTO project_todos (id, project_id, title, status, due_at, created_at, updated_at) VALUES (?, ?, 'x', 'todo', ?, 1, 1)`);
  for (let i = 0; i < 50; i += 1) bulkTodo.run(`bt-${i}`, `bulk-${i}`, clock + 5 * DAY);
  manyCadence.scheduleAll(clock);
  ok(manyCadence.activeCount() === 53, "9. 50 批量项目 + 3 基础项目 → 53 timer（每项目一个，无 per-source timer）");
  ok(fake9.timers.filter((t) => !t.cancelled).length === 53, "9b. 底层 handle 数一致（无泄漏）");
  manyCadence.shutdown();
  ok(fake9.timers.filter((t) => !t.cancelled).length === 0, "9c. shutdown 全部释放");

  db.close();
  rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`project-cadence-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-cadence-test: PASS (${passed})`);
  }
}

void main().catch((err) => {
  console.error("project-cadence-test: FAILED", err);
  process.exitCode = 1;
});
