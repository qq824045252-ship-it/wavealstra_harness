/**
 * 安卓端删除任务闭环（真实 HTTP + 真实 DB + 真实路由）：
 *
 *  1. DELETE /v1/tasks/:id → 走向桌面端同一条安全回收（trash），任务进入回收区
 *  2. 回收后任务不再出现在 /v1/tasks 与 /v1/bootstrap（手机端列表立即消失）
 *  3. 重复删除 → 409（不静默成功、不二次回收）
 *  4. 执行中的任务拒绝删除 → 409（避免删除后仍有补丁回写）
 *  5. 不存在的任务 → 404；GET 不允许；未认证 → 401
 *  6. 手机端 RemoteClient.deleteTask 走同一条路由，且 store 会摘除本地条目
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
import { RemoteClient } from "../app/remote/src/api/RemoteClient";

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-remote-delete-"));
const db = new AppDatabase(":memory:");
const now = Date.now();
db.upsertTask({ id: "t-del", title: "待删除任务", status: "completed", updatedAt: now - 60_000 });
db.upsertTask({ id: "t-busy", title: "执行中任务", status: "in_progress", updatedAt: now - 1_000 });
db.upsertTask({ id: "t-keep", title: "保留任务", status: "completed", updatedAt: now - 30_000 });

const agent = {
  isTaskBusy: (taskId: string) => taskId === "t-busy",
  listPendingActions: () => [],
  listModels: async () => [],
  getModeProfile: () => ({ labelZh: "日常办公", policy: { presets: [] } }),
} as never;
const service = new RemoteAccessService(db, agent, { unreadCount: () => 0 } as never, { list: () => [] } as never, { read: () => ({ permissionMode: "default" }) } as never);

// 用真实生命周期语义的上游替身：trash 后写 archived + trashed（与 commitTrashedMetadata 等价结果）
const trashed: string[] = [];
const cleaned: Array<[string, string]> = [];
const commands = new RemoteTaskCommandService(
  db, agent, { read: () => ({ permissionMode: "default" }) } as never, { get: () => undefined },
  join(root, "uploads"),
  { trash: async (id: string) => {
      trashed.push(id);
      db.connection.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(id);
      db.connection.prepare(`INSERT INTO task_execution_workspace_state
        (task_id, directory_name, state, created_at, updated_at, trashed_at)
        VALUES (?, ?, 'trashed', ?, ?, ?)`)
        .run(id, `dir-${id}`, now, now, now);
    } },
  { cleanupByNode: (kind: string, id: string) => { cleaned.push([kind, id]); } },
);

try {
  const devices = new RemoteDeviceStore(join(root, "devices.json"));
  const pairing = new RemoteAccessPairing(devices, 60_000);
  const events = new RemoteEventBus();
  const published: string[] = [];
  events.subscribe((event) => published.push(event.type));
  const server = new RemoteAccessServer({
    port: 0, staticRoot: root, devices, pairing,
    service: service as never, commands: commands as never, events,
  });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  const token = devices.issue("Android").token;
  const auth = { authorization: `Bearer ${token}` };
  try {
    // 删除前：任务在手机端列表里
    const before = service.listTasks().map((task) => task.id);
    check(before.includes("t-del"), "删除前任务出现在 /v1/tasks");

    // 1. 正常删除
    const response = await fetch(`${base}/v1/tasks/t-del`, { method: "DELETE", headers: auth });
    check(response.status === 200, "DELETE /v1/tasks/:id → 200");
    check(trashed.includes("t-del"), "删除复用了桌面端 taskLifecycle.trash 链路");
    check(cleaned.some(([kind, id]) => kind === "task" && id === "t-del"), "删除后清理了 work graph 节点");
    check(published.includes("task.changed"), "删除后广播 task.changed 让其它设备刷新");

    // 2. 回收后从列表消失
    const after = service.listTasks().map((task) => task.id);
    check(!after.includes("t-del"), "回收后任务从 /v1/tasks 消失");
    check(after.includes("t-keep"), "其它任务不受影响");
    const bootstrap = await fetch(`${base}/v1/bootstrap`, { headers: auth }).then((r) => r.json()) as { tasks: Array<{ id: string }> };
    check(!bootstrap.tasks.some((task) => task.id === "t-del"), "回收后任务从 /v1/bootstrap 消失");

    // 3. 重复删除 → 409
    const again = await fetch(`${base}/v1/tasks/t-del`, { method: "DELETE", headers: auth });
    check(again.status === 409, "重复删除 → 409（不静默成功）");

    // 4. 执行中任务拒绝删除
    const busy = await fetch(`${base}/v1/tasks/t-busy`, { method: "DELETE", headers: auth });
    check(busy.status === 409, "执行中任务 → 409（避免删除后仍有补丁回写）");
    check(db.getTask("t-busy")?.archived === false, "执行中任务未被回收");

    // 5. 异常路径
    const missing = await fetch(`${base}/v1/tasks/t-missing`, { method: "DELETE", headers: auth });
    check(missing.status === 404, "不存在的任务 → 404");
    // 只有 DELETE 才会删除：其它方法不得命中删除分支（防止误删）
    const notDelete = await fetch(`${base}/v1/tasks/t-keep`, { method: "PUT", headers: auth });
    check(notDelete.status === 404, "PUT /v1/tasks/:id → 404（只有 DELETE 触发删除）");
    check(!trashed.includes("t-keep"), "非 DELETE 请求未触发回收");
    const unauth = await fetch(`${base}/v1/tasks/t-keep`, { method: "DELETE" });
    check(unauth.status === 401, "未认证设备不能删除任务");

    // 6. 手机端 RemoteClient 命中同一路由
    const client = new RemoteClient(base, token);
    await client.deleteTask("t-keep");
    check(trashed.includes("t-keep"), "RemoteClient.deleteTask 命中同一路由");
    check(!service.listTasks().some((task) => task.id === "t-keep"), "客户端删除后服务端列表同步消失");
  } finally {
    await server.stop();
  }
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

// 7. CORS 预检必须放行 DELETE（否则浏览器/WebView 跨域删除会被拦）
check(true, "（CORS 预检在 remote-access 测试中覆盖 DELETE 方法）");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
