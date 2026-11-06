# Bot / Work Phase 1 GitHub 复审与修复

复审日期：2026-11-07。审查基线：`8e558289a16ae2b964cf968ecd7af96eab033dc9`（`feat(bot-work): 完成 Phase 1 控制与验收基础`）。本记录与修复在同一提交中交付，不修改冻结设计、不升级应用版本、不修改数据库 schema。

## 结论与范围

架构方向符合 [冻结设计](../bot-work-design.md) 与 [R01～R10 修复规划](../bot-work-phase1-review.md)：Bot 身份持久化、Work 唯一真源、版本守卫、来源快照、可信验收、专家快照和 Memory 隔离已经接线；执行继续委托给现有 Pi Durable。原提交仍存在下列可复现的权限、恢复、历史成果和投影缺陷，因此不能仅依据原有测试通过记录直接判为完全满足规划。

本补丁修复本次确认的缺陷，并补充行为回归。检查覆盖真实 SQLite、实际 Goal/Memory 工具接线、专家文件快照、生产 renderer store，以及原生执行端口和持久历史读取的可控夹具。它不等于 Pi 1.5 原生运行时、真实跨端重连、GUI 或全部 BW 端到端场景重新验收通过。

## 已修复的问题

| 问题 | 原行为与影响 | 修复与回归证据 |
| --- | --- | --- |
| 旧成果仍充当当前成果（R04/R06） | 要求或输入 A→B 后，旧 `acceptedDeliverableIds` 和缺口留在当前投影；仅更换输入时旧待验收成果也不失效 | 保留历史 accepted 状态、正文和审阅证据；从当前已采纳引用、缺口和下一步中排除旧要求、旧输入及失效执行；旧 proposed 成为历史。交接本身不丢弃有效成果 |
| worker 省略绑定绕过委派（R02） | 省略业务参数 `bindingId` 会跳过执行失效和 delegated scope 检查 | 由可信 worker actor 的持久绑定补足准入身份；旧输入、失效执行和超出委派范围的动作拒绝 |
| 停用执行 Bot 后仍能执行新工具（R02/R08） | 派发检查执行 Bot，但工具准入未检查该 Bot 是否仍 active | 每次新动作检查实际执行 Bot；已发生效果的结果提交、查回和结算仍保留 |
| Goal 适配提升 worker 权限（R02/R08） | 后台执行调用 Goal 被构造成负责人 Bot，可取消原 Work；未关联前台会话的 worker 查询为空，并能另建长期 Work | Goal 模型身份优先取持久执行绑定；worker 只读查询原委托，不能取消负责人 Work，也不能创建新的长期责任；普通前台 Bot 创建能力保留 |
| 同毫秒重用 Task 读取旧绑定 | `ORDER BY admitted_at DESC` 对同毫秒连续执行没有稳定次序，第二次执行会被当成第一次，输入检查失败 | Work 与 Memory 查询均增加持久插入顺序的确定性排序；回归覆盖同毫秒前次完成后再次派发 |
| 租约接管后旧宿主仍提交（R02/F14） | 权威检查位于 SQLite 写事务之前；检查后另一连接接管租约，旧宿主仍能提交 | create、控制和动作准入在写事务内重新核验权威及身份；租约写入使用立即事务。两条真实 SQLite 连接复现并验证拒绝旧宿主 |
| 过期授权没有用户续权入口 | resume 要求重新授权，但过期检查也拒绝用户的授权 amend | 仅可信用户明确提供新的有限期限，且与当前宿主 grants 相交后仍有效，才可续权；模型不能续权、不能扩大当前 grants，重放保持幂等 |
| 取消恢复先 stop 阻断已完成结果（R07/BW-A15） | 原输入已完成，但当前会话变化时先 stop 会报命名空间不匹配，原成果无法结算 | 先核对原回执状态；终态直接查回结算，仅仍在运行的原执行请求 stop，并再次检查结果。测试分别覆盖已完成和仍运行两条分支 |
| 原生成果取自 UI 历史窗口（R04/R05/R06） | 产物和 writeConflicts 来自当前会话的有限展示窗口，可能混入其他轮次或遗漏较早冲突 | 从原 submission 的 conversation、input entry 到 answer entry 分页读取持久记录；不依赖 UI 当前会话和窗口。回归覆盖前后轮次、另一会话、跨页的早期冲突与产物 |
| 可读共享记忆被当成可写（BW-A07/A08） | worker 可更新其可见 Bot 私人/项目事实；共享原子仍带 task scope 时，自动提炼可 update、supersede、resolve、forget 或追加 evidence | 工具写入携带可信 task 身份，检查原子的全部作用域。worker 只写本任务独占记忆；Bot 前台只写自身私人/当前对话独占记忆。越界提炼候选待审，正文、状态、revision 和 evidence 不变；用户显式审核与普通任务既有行为保留 |
| 派生记忆与初始专家快照不完整（R09/BW-A07/A08） | L1 按 Work 项目查询，L2/L3 却可能使用不一致的 Task 项目；初次注册 Bot 的专家版本行遗漏完整配置和技能包 | 派生提示与 L1 使用同一权威作用域；初始专家版本持久化完整配置及技能包。用真实审批后的提示投影和文件复制验证 |
| 刷新复活已结束事项、覆盖当前交互（R10 的 renderer 部分） | 权威 open-only 列表未返回的旧 active 项被永久保留；旧并发响应、迟到失败或同版本通知快照可覆盖较新的本地状态 | 仅保留请求开始后收到的新投影，拒绝过期刷新，按合并列表保留选择，并单向合并通知已读状态。生产 store 的 6 组竞态回归通过 |

## 本轮验证

### 新增行为回归

| 命令 | 覆盖与结果 |
| --- | --- |
| `pnpm -s test:bot-work-review-control` | 10 组通过：历史成果、输入切换、交接/失效、委派、worker 新建限制、同毫秒绑定、停用、租约接管、可信续权 |
| `pnpm -s test:bot-work-review-execution` | 6 组通过：Goal worker 权限、无前台关联的 Work 查询、取消后终态查回、运行中停止、原提交成果隔离、长历史分页。使用真实业务库与受控执行端口/存储查询夹具，不冒充真实 Pi 1.5 执行 |
| `pnpm -s test:bot-work-review-memory` | 5 组通过：注册的真实 Memory 工具、自动提炼共享原子保护、已审批派生提示、完整专家技能快照 |
| `pnpm -s test:bot-work-review-projection` | 6 组通过：关闭后的缺项删除、请求期间新/更新投影、旧刷新与旧失败拒绝、选择保留、已读状态不回退 |

四个脚本已登记到 package.json，并由现有 headless 聚合规则选入默认套件；没有放宽断言或增加失败基线。

### 既有回归与静态检查

以下已在本轮实际执行并通过：

- `pnpm -s test:bot-work-phase1`、`pnpm -s test:bot-work-control`、`pnpm -s test:conversation-runtime`。
- `pnpm -s test:memory`、`pnpm -s test:memory-cognition`、`pnpm -s test:memory-organization`、`pnpm -s test:expert`。
- `pnpm -s test:bot-workspace`、`pnpm -s test:app-store-structure`、`pnpm -s test:app-store-transactions`。
- `pnpm -s test:db-schema-discard`、`pnpm -s test:db-migration`；保留不兼容数据库备份重建契约。
- `pnpm exec tsc --noEmit -p tsconfig.web.json`；另对 Work 服务、Goal 适配与新增控制回归进行了定向 TypeScript 检查。
- `node scripts/test-all.mjs --audit`、`git diff --check`。

### 环境限制与未通过项

仓库锁定 Pi 1.5.0；此环境可用的既有缓存为 Pi 1.3.0，且缺少部分当前依赖。尝试 `pnpm install --offline --ignore-scripts --frozen-lockfile` 因离线包元数据不足失败，没有改锁文件或降低依赖要求来绕过检查。

- 完整 `pnpm -s typecheck` 与 `pnpm -s typecheck:scripts` 没有通过：Pi 1.3 类型缺少当前使用的 1.5 接口，并缺少 `dbus-native`、`@xterm/headless` 等依赖。新增回归自身发现的类型错误已修复；环境错误没有加入失败基线。
- 额外运行既有 `test:durable-projection`，在旧缓存运行时的 `runtime.snapshot.historyBefore` 断言失败。其测试与 DurableBotRuntime 源码未在本补丁修改；此结果不能作为锁定 Pi 1.5 的通过或失败结论，也没有因此放宽断言。
- `node scripts/ipc-channel-inventory.mjs --check` 扫描得到本进程 478 个唯一通道，真实重复与未解析引用均为 0，但因当前 GitHub 源码没有生成基线 `artifacts/ipc-channel-baseline.json` 而退出 2，不能标记为基线检查通过。本补丁没有新增 IPC 通道，也没有生成新基线掩盖该限制。
- 本轮没有声称全量 headless、真实 Pi 1.5 `test:bot-work-execution`、联网 `test:durable-bot`、GUI、移动端、Omarchy 或安装包重新验收通过。[原实施记录](../bot-work-implementation.md) 的 314 项通过是原提交者的历史证据，不是本轮复跑结果。

## 后续阶段边界

当前 Bot 页面发送仍为草稿占位。独立 Bot 前台对话、受理与业务派发入口、完整资源/交接流程、真实订阅、跨端同步和全量端到端故事继续按 Phase 2～5 推进，不因本次修复被删减。

本次 renderer 回归处理已明确复现的刷新竞态；没有列表快照水位或删除 tombstone 的现有协议，仍不能代表完整跨端乱序同步协议。

持久历史读取的区间两端包含语义已核对 [Pi 1.5 官方 EntryQuery 定义](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/types.ts)。同一轮的多个 steer 输入可能共享 answer，因此这里取得的是原输入至 answer 的运行区间证据，不保证同轮输入之间的独立因果归属，也不宣称多输入合并、任意原生终止工具等执行故事已在真实运行时验收。
