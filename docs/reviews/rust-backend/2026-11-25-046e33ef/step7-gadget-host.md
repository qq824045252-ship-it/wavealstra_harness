# Step 7 执行报告与证据（Rust 共享静态 HTTP Gadget Host、按需后端与权限分离）

- **步骤 / 场景**：Step 7（静态 Gadget 共享 Rust HTTP Host、Node/Python/Go/Rust 按需后端与资源回收、UI 断连与实例 generation 权责拆分，`RC-17`～`RC-19`）
- **源码改动**：
  - [gadget_http_host.rs](../../../../native/runtime-audit/src/gadget_http_host.rs)：在 `mybuddy-runtime-audit` 内新增共享 HTTP 静态 Gadget Host（`CoreGadgetHost`：`Supported`、`List`、`Health`、`StartStatic`、`StopStatic`、`StopAll`、`RevokeGeneration`、`RegisterBackend`、`UnregisterBackend`），复刻 `GadgetHost` 安全头/CORS/`Sec-Fetch-Site`/symlink/敏感文件名过滤/HTML `<script src="/__mybuddy/sdk.js"></script>` 注入，并直接复用 `Arc<Mutex<gadget_state::Store>>` + `request_control::Control` 在原子重命名边界进行 generation 吊销拦截。
  - [gadget_state.rs](../../../../native/runtime-audit/src/gadget_state.rs) & [main.rs](../../../../native/runtime-audit/src/main.rs)：共享 `Arc<Mutex<gadget_state::Store>>` 并接入 `CoreGadgetHost` 分发及退出 `stop_all()` 清理。
  - [core_supervisor.rs](../../../../native/runtime-audit/src/core_supervisor.rs)：按角色与授权作用域拆分断连清理：`ClientRole::Ui` 断开连接不再吊销正常运行的后台/静态 Gadget 实例 generation，仅清理带 `ownerScope: "ui"` 的临时 UI token（同时保留 `LegacyExclusive` 测试契约）。
  - [GadgetRuntime.ts](../../../../src/main/gadget/GadgetRuntime.ts) & [gadget-types.ts](../../../../src/shared/gadget-types.ts) & [runtime-audit.ts](../../../../src/main/platform/runtime-audit.ts) & [core-business-client.ts](../../../../src/main/platform/core-business-client.ts) & [index.ts](../../../../src/main/index.ts)：静态 Gadget 在 Rust Host 可用时 100% 走共享 Rust HTTP Host（`0` 专属 Node 进程）；有后端 Gadget 支持在途保护与 `idleTimeoutMs` 自动/按需回收、子孙进程跟踪清理及缺失运行环境显式 `blocked: true` (`RUNTIME_ENVIRONMENT_MISSING`) 诊断。
  - 测试与注册：[rust-gadget-host-test.ts](../../../../scripts/rust-gadget-host-test.ts)、[package.json](../../../../package.json)、[test-all.mjs](../../../../scripts/test-all.mjs)、[verify-native-contract.mjs](../../../../scripts/verify-native-contract.mjs)。

---

## 验证实测结果（Windows）

| 检查项 | 结果 | 关键实测输出 |
| --- | --- | --- |
| Rust 单元测试 (`prepare-runtime-audit.cjs`) | `passed` | `39 passed; 0 failed`（含 `gadget_http_host::tests::shared_static_host_serves_multiple_gadgets_and_revokes_on_stop`），0 编译警告 |
| `pnpm typecheck` | `passed` | web / node / `scripts/` 0 错误 |
| `node scripts/test-all.mjs --audit` | `passed` | `headless 525 · GUI 112 · NETWORK 42 · DATASET 16 · ARTIFACT 3 · pending 0`，分类自检 OK |
| `pnpm run test:rust-gadget-host` | `passed` | `PASS RC-17`（0/1/10/20 静态 Gadget 0 Node 进程、逐个关闭重开与数据隔离）、`PASS RC-18`（Node/Python/Go/Rust 真实后端只读不启、8 并发单飞、在途保护+闲置回收、子孙进程回收、崩溃重启、缺失环境显式 `blocked`）、`PASS RC-19`（`ui` 断连保留运行态，主动 `stop` 前置吊销防迟到落盘） |
| `test:gadget-runtime-lifecycle` / `test:gadget-preview-recovery` / `test:gadget-storage-authorization` / `test:gadget-backend` | `passed` | 原有生命周期、预览恢复、提交边界吊销与进程后端测试全过 |
| `pnpm run test:gadget-backend-domain -- --native` | `passed` | `gadget-backend-domain-test: ok`（静态升级示例已直接走 `hostKind: "rust-shared"`） |
| `core-supervisor-test.mjs -- --native` | `passed` | 9/9 项全过 |
| `pnpm run test:all:native` | `passed` | `21/21` 原生业务用例全部命中真实 Rust worker |
| Linux / GUI 桌面实机 | `not-run` | 本步骤在 Windows 无头门禁执行；GUI 与打包实机留待最终验收 |

---

## Step 7 结论

**`passed`（Windows；Linux / GUI `not-run`）**：`RC-17`、`RC-18`、`RC-19` 全部门禁通过，进入 Step 8（拆出独立 Pi Node Host）。
