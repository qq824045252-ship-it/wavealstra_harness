#!/usr/bin/env node
/**
 * verify-native-contract.mjs — 原生路径验收门禁。
 *
 * 默认套件只跑 Host 回退，无法证明业务真的命中 Rust：`runtimeAuditReader` 缺失或
 * 请求超时时，写入会静默落回 Node，用例照样全绿。这里做两件事：
 *
 *   1. 准备真实 worker 二进制（缺产物直接失败，不复用回退当作通过）；
 *   2. 对已接受 `--native` 的业务用例逐个加 `--native` 重跑，任何非零退出都失败。
 *
 * 用法：pnpm -s test:all:native
 * 环境：需要 Rust 工具链与可写的临时目录（用例把 SQLite 放在 os.tmpdir()）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = { win32: "win-x64", linux: "linux-x64" }[process.platform];
if (!platform || process.arch !== "x64") {
  console.error(`[native] 不支持的原生目标：${process.platform}/${process.arch}`);
  process.exit(2);
}
const executable = join(ROOT, "out", "native", platform,
  process.platform === "win32" ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");

/**
 * 已经写成 `--native` 分支、且当前全绿的用例。新增原生验收先在这里登记，
 * 再让它在本地以 `pnpm run <script> -- --native` 通过；不要在默认套件里假装跑过。
 */
const TESTS = [
  "test:runtime-audit-native-contract", // worker 协议契约：租约/撤销/终态
  "test:runtime-audit-lifecycle",       // 真实锁争用、队列过载、超时无写入、崩溃回执
  "test:core-supervisor",               // 3.6 第一片：租约互斥/断开仍活/崩溃接管
  "test:core-client",                   // 生产连接路径：握手、重连、断开与进程回收
  "test:core-business-protocol",        // Step 3 业务协议：多角色隔离、事件游标/补读/缺口重同步、执行桥与看门狗恢复
  "test:rust-writer-boundary",          // Step 4 RC-09：应用库 readonly/唯一 Rust 写入者与 Pi 伴生库边界
  "test:rust-domain-equivalence",       // Step 4 RC-10：Host 与监督 Rust 只读态等价性与事务回滚一致
  "test:work-host-authority",           // Rust 租约写入、真实锁争用与主循环响应
  "test:durable-task-projection",       // Durable 任务投影写入 + query_only 守卫
  "test:project-domain",
  "test:task-board",
  "test:gateway",                       // 网关消息写入：query_only 下仍由 Rust 落库
  "test:activity-time",
  "test:workspace-notes",
  "test:task-workspace-lifecycle",
  "test:gadget-backend-domain",
  "test:library-domain",
  "test:library-lifecycle-transaction",
  "test:rust-work-scheduler",
  "test:rust-background-services",
  "test:rust-gadget-host",
  "test:pi-node-host",
  "test:thin-main",
  "test:core-production-lifecycle",
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, stdio: "inherit", windowsHide: true, ...options });
}

console.log(`[native] 准备真实 worker（${platform}）`);
if (run(process.execPath, [join(ROOT, "scripts", "prepare-runtime-audit.cjs")]).status !== 0) {
  console.error("[native] 无法准备原生 worker；原生验收不能以回退路径通过");
  process.exit(1);
}
if (!existsSync(executable)) {
  console.error(`[native] 缺少产物：${executable}`);
  process.exit(1);
}

const failed = [];
for (const script of TESTS) {
  console.log(`\n[native] ${script}`);
  // Windows cannot spawn a .cmd wrapper without a shell; pnpm is the only shell entry we need.
  const result = run(`pnpm run ${script} -- --native`, [], { shell: true });
  if (result.status !== 0) failed.push(`${script} (exit ${result.status ?? "signal"})`);
}

if (failed.length) {
  console.error(`\n[native] 失败 ${failed.length}/${TESTS.length}：`);
  for (const entry of failed) console.error(`  - ${entry}`);
  process.exit(1);
}
console.log(`\n[native] PASS ${TESTS.length} 个原生业务用例全部命中真实 worker`);
