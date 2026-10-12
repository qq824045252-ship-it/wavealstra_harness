/**
 * 安卓端「已结束绿点」闭环（真实 HTTP + 真实 DB + 真实 DTO）：
 *
 *  1. GET /v1/bootstrap 的 task 摘要必须带 doneAckedAt（手机端判定绿点的唯一输入）
 *  2. POST /v1/tasks/:id/ackDone 写 tasks.done_acked_at → 同一任务的后续读取立刻变为已确认
 *  3. ackDone 不触碰 updated_at（读事件不重排手机端列表）
 *  4. 不存在的任务 → 404；ackDone 不接受 GET
 *  5. 手机端（RemoteClient）调用的是同一条路由
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { RemoteEventBus } from "../src/main/remote/RemoteEventBus";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteAccessService } from "../src/main/remote/RemoteAccessService";
import { RemoteTaskCommandService } from "../src/main/remote/RemoteTaskCommandService";
import { mapRemoteTask } from "../src/main/remote/RemoteDtoMapper";
import { RemoteClient } from "../app/remote/src/api/RemoteClient";
import { localDoneAckAt, useRemoteStore } from "../app/remote/src/store/remoteStore";
import { taskStatusDot } from "../app/remote/src/lib/taskStatusDot";

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-remote-done-ack-"));
const db = new AppDatabase(":memory:");
const now = Date.now();
db.upsertTask({ id: "t-done", title: "已完成任务", status: "completed", updatedAt: now - 60_000 });
db.upsertTask({ id: "t-running", title: "进行中任务", status: "in_progress", updatedAt: now - 1_000 });

const agent = {
  isTaskBusy: (taskId: string) => taskId === "t-running",
  listPendingActions: () => [],
  listModels: async () => [],
  getModeProfile: () => ({ labelZh: "日常办公", policy: { presets: [] } }),
} as never;
const service = new RemoteAccessService(db, agent, { unreadCount: () => 0 } as never, { list: () => [] } as never, { read: () => ({ permissionMode: "default" }) } as never);
const commands = new RemoteTaskCommandService(db, agent, { read: () => ({ permissionMode: "default" }) } as never, { get: () => undefined });

const before = service.listTasks().find((task) => task.id === "t-done");
check(before !== undefined && before.doneAckedAt === null, "bootstrap 摘要带 doneAckedAt（未确认 = null）");
check(Object.prototype.hasOwnProperty.call(before, "doneAckedAt"), "该字段始终存在（旧手机端也不会因为缺字段而误判为空闲）");
check(taskStatusDot(before!, 0) === "done-unread", "手机端判定：已结束 + 未确认 → 绿点");
check(taskStatusDot(service.listTasks().find((task) => task.id === "t-running")!, 0) === "running", "手机端判定：busy → 蓝点");

try {
  const devices = new RemoteDeviceStore(join(root, "devices.json"));
  const pairing = new RemoteAccessPairing(devices, 60_000);
  const events = new RemoteEventBus();
  const server = new RemoteAccessServer({
    port: 0, staticRoot: root, devices, pairing,
    service: service as never, commands: commands as never, events,
  });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  const token = devices.issue("Android").token;
  const auth = { authorization: `Bearer ${token}` };
  try {
    // 1. 手机端能拿到绿点所需的字段
    const bootstrap = await fetch(`${base}/v1/bootstrap`, { headers: auth }).then((r) => r.json()) as { tasks: Array<Record<string, unknown>> };
    const summary = bootstrap.tasks.find((task) => task.id === "t-done")!;
    check(summary.doneAckedAt === null, "GET /v1/bootstrap 返回 doneAckedAt=null");
    const tasks = await fetch(`${base}/v1/tasks`, { headers: auth }).then((r) => r.json()) as Array<Record<string, unknown>>;
    check(tasks.find((task) => task.id === "t-done")!.doneAckedAt === null, "GET /v1/tasks 同样透出该字段");

    // 2. 手机端点开任务 → ackDone 写库（与桌面端同一条链路）
    const ackResponse = await fetch(`${base}/v1/tasks/t-done/ackDone`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    check(ackResponse.status === 200, "POST /v1/tasks/:id/ackDone → 200");
    const acked = db.getTask("t-done")!;
    check(typeof acked.doneAckedAt === "number" && acked.doneAckedAt >= now - 60_000, "ackDone 写入 tasks.done_acked_at");
    check(acked.updatedAt === now - 60_000, "ackDone 不触碰 updated_at（不重排手机端列表）");
    const afterSummary = service.listTasks().find((task) => task.id === "t-done")!;
    check(taskStatusDot(afterSummary, 0) === null, "确认后手机端判定 → 不显示绿点");
    check(mapRemoteTask(acked, { busy: false, pendingActionCount: 0 }).doneAckedAt === acked.doneAckedAt, "DTO 映射与 DB 值一致");

    // 3. 异常路径
    const missing = await fetch(`${base}/v1/tasks/t-missing/ackDone`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    check(missing.status === 404, "不存在的任务 → 404（不静默成功）");
    const wrongMethod = await fetch(`${base}/v1/tasks/t-done/ackDone`, { headers: auth });
    check(wrongMethod.status === 404, "ackDone 不接受 GET（读接口不会意外写库）");
    const unauth = await fetch(`${base}/v1/tasks/t-done/ackDone`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(unauth.status === 401, "未认证设备不能确认绿点");

    // 4. 手机端 RemoteClient 走的就是这条路由
    const client = new RemoteClient(base, token);
    await client.ackDone("t-running");
    check(typeof db.getTask("t-running")!.doneAckedAt === "number", "RemoteClient.ackDone 命中同一路由");
  } finally {
    await server.stop();
  }
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

// 5. 旧版本电脑端兜底：接口 404 时本机水位仍让绿点消失（localStorage 覆盖层）
check(localDoneAckAt("t-done") === 0, "本机水位默认为 0（未确认过）");
await useRemoteStore.getState().markTaskDoneSeen("t-done");
check(localDoneAckAt("t-done") > 0, "markTaskDoneSeen 记录本机确认水位（PC 不可用时仍能清除绿点）");
check(
  taskStatusDot({ status: "completed", busy: false, updatedAt: Date.now() - 60_000, doneAckedAt: null }, localDoneAckAt("t-done")) === null,
  "本机水位生效：即使服务端仍是 null 也不再显示绿点",
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
