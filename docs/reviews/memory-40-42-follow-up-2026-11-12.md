> 历史验收记录：本文描述 2026-11-12 当时的 `b7040544` 加未提交修改工作区，不是该 Git SHA 单独对应的测试结果，也不是当前 main 的全量验收。保留原始失败及验证边界，不以本记录修改失败基线。后续集成记录见 [memory-40-42-integration-2026-11-12.md](memory-40-42-integration-2026-11-12.md)。

# #40、#41、#42 复审补修与最终验收

本轮以 GitHub CLI 读取三条复审评论后继续修复。基线仍是 `main@b7040544` 上已有未提交工作区，不能把这些实现当成远端该 SHA 已包含的代码。没有提交、推送、关闭 Issue、构建产品、发布或修改真实用户记忆。

复审来源：[#40 多行示例](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/40#issuecomment-6821820803)、[#41 通用标题](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/41#issuecomment-6821821999)、[#42 万向量验收](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/42#issuecomment-6821823063)。

## #40 从完整文档生成执行意图

首轮直接拆句，丢失了“示例命令”和块尾“不要执行”的约束。新增的真实捕获测试先复现了范围水位被推进，证据在 `out/tests/memory-review-red.log`。

现在 `MemoryInstructionDocument` 统一拥有文档块、引用、代码围栏、禁止执行和问句上下文。操作只能从可执行的顶层片段产生，持久失效入口接收该文档生成的意图。问号在分类前保留，不能通过只截取“忘记我的名字”绕过原问句。引用中的“现在请执行”也不自动取得顶层权限；明确结束引用块后，真实顶层指令仍可执行。

显式遗忘、自动捕获和写入证据共用该文档。测试包含多行示例、解释请求、围栏、引用块、块尾禁止执行、能力问句，以及结束示例后真实删除。原有“不要忘记”、混合 forget-A/remember-B、团队、共享渠道和迟到旧来源保护继续验证。

## #41 标题不再单独定义事实失效

首轮将标题作为独立文本指纹，“回复偏好”因此会同时命中无关 B/C。新增集成测试先证明，删除 A 后同标题 B 的旧在途提炼无法提交。

现在 `Withdrawal` 的 fact 分支必须同时提供身份与事实内容，持久约束在同一证据子句内要求两者共同命中。修订也按完整事实处理。原话证据不再按“只含标题”挑选，只有标题的证据不能重新成为类别失效规则。

精确前台工具的完成回执按范围、用户消息和请求子句指纹保存。完成捕获不能把已经定向删除的 A 再扩大为“回复偏好”类别规则。另一个尚未形成 L1 的真实遗忘子句仍需单独留下保护，不能因为同一消息已成功删除 A 就被吞掉。回执与事实失效均在原删除事务内完成。

集成测试在删除前建立同源 A/B 和不同来源 C。A/B 同标题但内容不同。删除 A、完成捕获、旧提炼返回和数据库正常重开之后，A 不可提交，B/C 的原历史仍能返回。同毫秒顺序、混合新事实、全局共享范围和其他 Bot 隔离继续受检。

当前 schema 只幂等增加失效元数据和回执，不通过重建有效数据库恢复召回。已有粗水位及无法证明可撤销的旧约束不自动清空。修复针对新操作，不声称自动恢复此前误伤的历史，也不声称能无锚点识别任意语义转述。

## #42 测满实际向量，再修主线程阻塞

首轮 10K 记录里只有一条向量，只能证明候选准入。新 `test:memory-semantic-scale` 在真实文件 SQLite 中建立：

| 数据 | 数量 |
| --- | --- |
| L1 记录 | 10000 |
| 当前模型实际持久向量 | 10000 |
| 向量维度 | 从 `SEMANTIC_DIMENSION` 读取，当前运行 1024 |
| 范围绑定 | 30000，包含可读和不可读范围 |
| 干扰事实内容长度 | 8192 字符 |
| 语义独有目标前的向量 | 9999，目标位于实际游标最后 |

embedding 计算是明确替身，向量存储、SQL、相似度计算、权限检查、前台搜索和返回值使用生产代码。不是实际嵌入模型质量或 Electron UI 测试。

测试在实现优化前固定预算：单次查询不超过 1500 ms，事件循环延迟不超过 50 ms，查询期 RSS 增长不超过 256 MiB。每条路径先预热一次，再交替运行词法和语义各五次；每次都检查目标实际返回、条数有界且绑定去重，不能用错误或空结果换时间。此用例纳入默认 headless 串行池。

同步实现的十次测量全部超预算。原始样本的词法查询约 1792 至 2053 ms，语义约 1548 至 1980 ms，事件循环几乎被阻塞整个查询。该结果只确认本受控数据超出所定预算，不等同测量了用户真实 profile 的卡顿。

CPU 诊断及查询计划进一步区分了阻塞点：

- 全范围规范化、扫描和候选评分都曾在一个连续执行段里完成。
- 初次分批后，评分仍会在没有命中的候选上连续执行。
- 向量分页原计划从记忆状态索引扫描并排序整范围，每一页重复该工作。

最终实现将词法发现、评分和向量计算分批处理。词法以主键游标每页 32 条，向量每页 128 条，按约 4 ms 的协作时间片让出线程。页数据在让出前通过 `.all()` 读完，不跨异步边界持有 SQLite 语句或事务。向量 SQL 从向量游标索引驱动，消除每页整范围排序。JS 保留有界候选和 top-k，不提前缩小合法可搜索语料。

异步返回前再次检查内容哈希、状态、有效期、范围和任务归属。新增测试在实际分页让出期间删除、解绑、改写或过期目标，验证同一连接允许写入，旧 DTO 不能返回。

FTS 与无查询路径仍有同步阶段；底层同步 `search()` 保留同步契约。这里验证的是前台 `searchHybrid()` 的固定数据预算，不能推广为任意关键词、任意规模或真实模型端到端延迟的保证。总扫描工作仍随合法数据增长。

## 验收结果

| 检查 | 本轮结果 |
| --- | --- |
| `pnpm -s test:all` | 509 项，491 PASS / 18 FAIL，7.9 min，完整门禁未通过 |
| 完整运行中名称包含 memory 的用例 | 25 PASS / 0 FAIL，包含最后串行执行的万向量测试 |
| `pnpm -s typecheck` 收尾复跑 | PASS，主进程、渲染层和 scripts 无新增错误 |
| `pnpm -s test:typecheck-guard` 收尾复跑 | PASS，不重写完整运行中曾失败的历史结果 |
| 本轮路径 `git diff --check` | PASS |

最终完整运行内的万向量测量，每条路径五次：

| 路径 | 中位总耗时 | 总耗时范围 | 最大事件循环延迟 |
| --- | --- | --- | --- |
| 词法前台 | 918.0 ms | 879.8 至 993.7 ms | 47.02 ms |
| 语义前台 | 914.1 ms | 878.5 至 937.1 ms | 18.40 ms |

十次均正确返回目标，零超预算。预热后 RSS 约 276.03 MiB，进程历史峰值约 320.21 MiB，相对预热 RSS 的峰值增量上界约 44.18 MiB，低于 256 MiB 预算。该峰值可能包含建夹具阶段分配，未强制 GC，不能当作存活对象、稳态内存或泄漏率。

这些是本机 Node、受控 embedding、固定合成长文本和多范围绑定下的测量。后台软件未隔离，优化前后没有交替切换实现跑配对试验，因此不报告提速倍数、生产收益比例或真实模型延迟。

完整运行记录的 18 个失败为：

| 失败用例 | 观察到的结果 |
| --- | --- |
| `architecture-graph` | BotWorkResult / WorkFilePreview 运行时依赖环，文件行数检查通过 |
| `bot-call-thread`、`bot-create-ui`、`bot-report-images-ui`、`bot-team-ui`、`bot-workspace-navigation-ui` | Monaco worker 默认导出相关构建错误 |
| `bot-collaboration`、`bot-cross-channel-contract` | 正常前台协作接收器不可用 |
| `bot-foreground-lifecycle`、`bot-peer-calls` | 生命周期或原生覆盖断言失败 |
| `bot-organization` | 渠道表夹具列数错误 |
| `bot-scheduling-gaps` | 夹具缺少 `messages.peers` |
| `db-migration` | 旧数据库备份断言与当前契约冲突，后续 undefined 路径错误 |
| `linux-session` | 源码导入顺序断言失败 |
| `local-workflow` | Windows 临时目录清理 EPERM |
| `task-isolation-p2` | os-sandbox 行为断言失败 |
| `typecheck-guard` | 执行时记录 `bot-organization-test.ts` 中 `deleteSource` 未定义；收尾复跑已通过 |
| `durable-storage-lease` | 临时 lease.cjs 写入 Access denied |

这里保留完整运行的实际数量，不能因单项收尾复跑通过而将其改成全库通过。没有完成这些失败的修改前同环境对照，不将它们全部归因于本轮或全部断言为无关。

本轮相关原始证据：

- `out/tests/memory-review-red.log`：#40 与 #41 修复前集成失败。
- `out/tests/memory-review-correctness.log`：反例、正对照、原有保护与实际分页撤销。
- `out/diagnostics/memory-review-scale-before.json`：优化前固定数据与预算失败。
- `out/diagnostics/memory-review-scale-before.cpuprofile`：未计入性能结果的剖析。
- `out/diagnostics/memory-review-scale-pages.json`：第一次分批仍失败及旧向量查询计划。
- `out/tests/memory-semantic-scale.json`：最终源码实际万向量测量。
- `out/tests/memory-review-headless.log`：最终源码完整默认门禁。
- `out/tests/memory-review-typecheck.log`：最终源码类型检查。
- `out/tests/memory-review-typecheck-final.log`、`out/tests/memory-review-typecheck-guard-final.log`：收尾复查。

没有修改测试失败放行基线。完整运行中的失败不自动归因于本轮，也不声称已对每项完成修改前同环境复现。真实模型、真实 embedding、Electron、GUI 和发行包验收均未执行。
