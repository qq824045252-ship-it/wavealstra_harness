# Step 6 执行报告与证据（后台调度、渠道、Remote、通知补偿与退出收敛）

- **步骤 / 场景**：Step 6（按 Cron → Dots → Gateway → Remote 顺序将触发调度、状态机与通知补偿迁入 Rust Core，`RC-14`～`RC-16`）
- **源码改动**：
  - Rust Core 模块：
    - [work_scheduler.rs](../../../../native/runtime-audit/src/work_scheduler.rs)：导出 `now_ms` / `sha256_hex` / `days_from_civil` / `ParsedCron`（扩展支持可选 6 字段秒级 Cron）。
    - [cron_scheduler.rs](../../../../native/runtime-audit/src/cron_scheduler.rs)：`core_cron_runtime_config`、`core_cron_schedule_state`、`core_cron_occurrences`、`every`/`at`/`cron` 纯 Rust 计算、睡眠与时钟回拨区分 `skip` vs `coalesce`、确定性去重、启动迁移与崩溃恢复。
    - [dots_scheduler.rs](../../../../native/runtime-audit/src/dots_scheduler.rs)：`core_dots_control_config`、`core_dots_control_cycles`、`core_dots_causal_dedup`、睡眠跳变合并（最多补跑一次）、`in_flight` 防自激围栏与因果去重。
    - [gateway_scheduler.rs](../../../../native/runtime-audit/src/gateway_scheduler.rs)：`core_gateway_config`、`core_gateway_channels`、`core_gateway_outbound_reconcile`、重连入站去重、有界退避、可查询渠道出站恢复 vs 不可查询渠道永久保留 `unknown_unqueryable`（绝不盲目重发）。
    - [remote_control.rs](../../../../native/runtime-audit/src/remote_control.rs)：`core_remote_state`、`core_remote_commands`（命令幂等重放/冲突围栏）、`core_remote_events`、`PublishNotification`/`CatchupNotifications`。
    - [business_protocol.rs](../../../../native/runtime-audit/src/business_protocol.rs) & [main.rs](../../../../native/runtime-audit/src/main.rs)：接入 `CoreCronScheduler` / `CoreDotsScheduler` / `CoreGatewayScheduler` / `CoreRemoteControl` 与 `SchedulerTickerGuard` 自动心跳、执行结算与断连 `unknown` 收敛。
  - Electron Main / Host 适配：
    - [core-business-client.ts](../../../../src/main/platform/core-business-client.ts)、[runtime-audit.ts](../../../../src/main/platform/runtime-audit.ts)、[ExecutionHostBridge.ts](../../../../src/main/host/ExecutionHostBridge.ts)
    - [CronService.ts](../../../../src/main/cron/CronService.ts)
    - [DotsDiscovery.ts](../../../../src/main/dots/DotsDiscovery.ts)、[DotsGoogleMonitor.ts](../../../../src/main/dots/DotsGoogleMonitor.ts)、[DotsProactiveDelivery.ts](../../../../src/main/dots/DotsProactiveDelivery.ts)、[DotsFileWatches.ts](../../../../src/main/dots/DotsFileWatches.ts)、[DotsActions.ts](../../../../src/main/dots/DotsActions.ts)、[DotsDelegations.ts](../../../../src/main/dots/DotsDelegations.ts)、[AgentService.ts](../../../../src/main/agent/AgentService.ts)
    - [GatewayPlatformRegistry.ts](../../../../src/main/gateway/GatewayPlatformRegistry.ts)、[GatewayService.ts](../../../../src/main/gateway/GatewayService.ts)、[GatewayDeliveryJournal.ts](../../../../src/main/gateway/GatewayDeliveryJournal.ts)（补齐 `kind: "gatewayDeliveryOp"`）
    - [RemoteAccessController.ts](../../../../src/main/remote/RemoteAccessController.ts)、[RemoteAccessServer.ts](../../../../src/main/remote/RemoteAccessServer.ts)、[NotificationService.ts](../../../../src/main/notification/NotificationService.ts)、[index.ts](../../../../src/main/index.ts)
  - 测试与注册：[rust-background-services-test.ts](../../../../scripts/rust-background-services-test.ts)、[package.json](../../../../package.json)、[test-all.mjs](../../../../scripts/test-all.mjs)、[verify-native-contract.mjs](../../../../scripts/verify-native-contract.mjs)、[remote-access-test.ts](../../../../scripts/remote-access-test.ts)。

---

## 验证实测结果（Windows）

| 检查项 | 结果 | 关键实测输出 |
| --- | --- | --- |
| `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs` | `passed` | `38 passed; 0 failed`（含 `cron_skip_vs_coalesce_and_clock_backward_dedup`、`dots_causal_dedup_sleep_coalescing_and_no_self_excitation`、`gateway_reconnect_dedup_and_queryable_vs_unqueryable_unknown`、`remote_command_dedup_and_offline_notification_catchup`），Rust release 无警告编译通过 |
| `pnpm typecheck` | `passed` | web / node / `scripts/` 0 错误（基线 0 条） |
| `node scripts/test-all.mjs --audit` | `passed` | `headless 525 · GUI 112 · NETWORK 42 · DATASET 15 · ARTIFACT 3 · pending 0`，分类自检 OK |
| `pnpm run test:rust-background-services` | `passed` | `RC-14` / `RC-15` / `RC-16` 全过；验证监督模式下 Main `CronService`、`DotsProactiveDelivery`、`DotsGoogleMonitor`、`DotsDiscovery` 0 本地 timer，无 UI 下通过 `ExecutionHostBridge` 触发与结算 |
| `pnpm run test:all:native` | `passed` | `20/20` 原生业务用例全部命中真实 Rust worker |
| `pnpm run test:cron-scheduling` & `-- --native` | `passed` | Step 6.1 门禁通过 |
| `test:dots-google` / `test:dots-discovery` / `test:dots-proactive-notices` / `run-dots-test.mjs actions/resident-tools/reply-recovery` | `passed` | Step 6.2 门禁通过（`run-dots-test.mjs delivery` L1-345 断言通过，末尾失败项为基线已知 `dots-foreground-scenario`） |
| `test:gateway-lifecycle` (`4/4`), `test:gateway-delivery-journal` (`22/22`), `test:gateway` (`50/50`), `test:slack-gateway` (`23/23`), `test:lark-wecom-gateway`, `test:weixin-gateway`, `test:dingtalk-gateway`, `test:discord-gateway`, `test:qq-gateway`, `test:gateway-security` (`4/4`) | `passed` | Step 6.3 全渠道门禁通过（补齐了 `GatewayDeliveryJournal.ts` 遗漏 `kind: "gatewayDeliveryOp"` 的线上写入修复） |
| `test:remote-access`, `test:remote-done-ack` (`18/18`), `test:remote-delete` (`18/18`), `test:remote-work-sync` (`11/11`), `test:remote-task-cache` (`13/13`), `test:remote-db` (`15/15`) | `passed` | Step 6.4 Remote 回归通过（同步修复了 `remote-access-test.ts` mock `openDotsAsync`） |
| `pnpm run test:notification-activation` | `baseline-fail` | 与 Step 1 基线一致，因 Node 26 `test-typescript-memory-loader.mjs` `ERR_INVALID_ARG_VALUE`（`mode: 'transform'`）失败 |
| Linux / GUI 桌面实机 | `not-run` | 本步骤在 Windows 无头门禁执行；GUI 与打包实机留待后续步骤与最终验收 |

---

## Step 6 结论

**`passed`（Windows；Linux / GUI `not-run`）**：`RC-14`、`RC-15`、`RC-16` 全部契约达成，进入 Step 7（Rust 共享静态 HTTP Gadget Host 与按需后端）。
