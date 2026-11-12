# Issue #21 验收收口核对（2026-11-12）

## 结论与版本

#21 的项目内共享资源隔离、动作审批及续跑已退役，普通任务、个人 Bot、团队、原生子代理与 Code Mode 的实际可用性已验证。**Issue 仍保持 open：原文指定的“已清理248条的实际用户 profile”尚未在新版本下完成复验。** 合成数据和历史清理结果不能替代这一项。没有为关单恢复审批、放宽地址策略或删失败基线。

- 实现/首轮验证已公开于 `a31dedc2`，生产修复为 `6d3d03ea`（浏览器取消后的输入保护及迁移子表先删）。[详细历史与失败记录](work-isolation-21-2026-11-12.md)保留原中断批、5/7 driver/网络失败及后续 7/7。
- 补验源码 `178a1b19`：**6/6，39 次真实 Flash 请求**，补 Code Mode 两类、原生子代理、普通聊天实显、团队交付、Stop 后同会话恢复。[机器证据](evidence/issue21/closure-178a1b19.json)。
- 补验源码 `e46c7139`：**6/6，17 次真实 Flash 请求**，后台 Work 公开搜索/独立公开网络读取/文件回读与交付，再加五种短任务。[机器证据](evidence/issue21/background-e46c7139.json)。
- `e46c7139` 默认 headless：**486/486，失败 0、已知失败 0、新增回归 0，exit 0**，03:19:34–03:26:37 UTC，源码干净未变。[逐项摘要与日志哈希](evidence/issue21/headless-e46c7139.json)。不是 GUI/NETWORK/DATASET/ARTIFACT 全绿。
- 此次新增的是测试和文档；#21 生产修复及原类型检查结果没有被改写。当前主线后续无关提交保留，各批按其实际 SHA 记录，不冒充在最终发布 SHA 重跑。

## 原文逐项对照

### 数据清理与兼容（6项）

1. 专用对象映射：14 张退役表在 `src/main/db/work-isolation-retirement.ts` 显式列出；表内索引/触发器随表删除。资源/审批/规则/outbox 模块与读写调用者已移除。混合 DTO/JSON 的 `permissionMode`、`authorization`、`delegatedScope` 保留历史兼容/审计形状，不作为审批放行条件；老 workspace-authorization IPC 是无写入的兼容返回。
2. 混合业务表保留：测试逐行比较 works、tasks、bots、admissions、execution bindings、operation receipts；成果与业务投影仍存在。仅三个机制独占 blocker 前缀清除，不整表清业务数据。
3. 支持的旧版本、未清理/已清理/新库：退役不升版本，支持的 v35→v36 预算迁移原地执行；fresh、部分清理、重复 reopen、FK-on、事务回滚均过，quick_check/foreign_key_check 通过。不扩称任意古老不支持 schema 都保证原地升级。
4. 旧 pending/queued/running：真实隔离 profile 重启后专用表消失，历史写入哨兵未创建，不回放旧动作，不改写旧失败。
5. 旧 blocker：原机制前缀清理，新普通/Bot/团队写任务及业务收尾通过，保留真实缺口/生命周期与真实失败。
6. 范围可检查：清理日志只含表名和计数；重复执行无变化。保留业务逐行检查与异常回滚，不清账号或密钥。

### 执行与派发链（7项）

1. AgentService、DurableToolPolicy、Browser、Linux/Windows 调用链已无共享 boundary 包装；Windows 为代码核对，不是 Windows 真机验收。
2. WorkExecutionAdapter 无 resourceUnavailable 跨 Work 扫描和 resource dispatch/recovery blocker 生成。
3. WorkService 无 resourceGate、旧 wait/live lease 收尾和审批接线。
4. 旧 authorizedFor/approvals.permits/permitsDeferred/action-scope/expiry 审批分支已退役；历史 readonly/空 scope 仍可完成用户请求的写入。
5. 身份/归属/工作目录/原生执行绑定/取消保留。在线团队与原生子代理、Code Mode 补验通过，团队成员与 owner_summary 独立执行并回原会话。
6. 全仓 src 旧模块名无运行时调用；三个资源/审批 blocker 前缀只在退役迁移中存在。真实操作回执和业务验收继续由公共执行链持有。
7. 后续用户明确要求全面退役应用权限及预算，已在现行契约说明；不是把 mode 改 auto 或隐藏按钮。

### UI、IPC与文档（5项）

1. ResourceEffectReview、BotWorkApprovals、BotWorkspaceAuthorization 组件删除。
2. Bot 创建/设置无对应授权勾选、追加写入授权或恢复卡；真实任务/业务评审保留。
3. IPC/preload/Remote/Gateway 对齐；历史兼容读取不触发旧审批或改变权限。IPC inventory、权限 UI 退役专项通过。
4. 当前文档、提示词和模型工具描述不再要求 workspace:write 审批；本次又给历史实施总览及 Phase 3 旧预算说明加了明确现状指引，避免历史条款误当现行契约。
5. 批量验收、成果采纳、关闭缺口、团队交接相关 headless 全量通过；两项个人后台 Work 和新团队任务另有真实成功关闭、文件交付证据。

### 真实验收与门禁（8项）

1. 类型、架构、IPC、相关专项通过；最终默认 headless 486/486，不冒充未跑的其他分类。
2. 普通搜索、browser navigate/read、公开网络读取、本地 ls/read 都有真实模型证据。故意关闭的本机端口返回真实 curl 错误，不是共享隔离。
3. 普通真实磁盘建目录/两文件/ls/wc/stat/回读通过；补验又在真实普通聊天页面显示翻译、不可预测标记和文件卡，截图经目视复核（本机保留，含临时个人路径，不上传原图）。
4. Bot 后台同类动作：原 7/7 的文件与 browser，加新后台 Work 的 web_search、独立 example.com curl、research.md 回读，实际执行、回会话、可见文件及业务 closed/succeeded 全链通过。
5. 新/同会话、团队、原生 subagent、Code Mode、真实 app 重启、明确 Stop 与停止后续读都已执行。Stop 后禁止写入哨兵始终未生成。
6. 历史 quarantine/outbox/blocker 旧 profile：合成专用数据通过真实 app 重启；不锁无关任务、不重放。
7. **未完成，保留关单阻塞**：原文“已清理248条的实际用户 profile”本轮没有启动新版本复验。历史真实清理/业务保留/SQLite 一致性记录以及本轮合成“已清理形状”与全新 profile 回归，均不能替代实际指定 profile 的新版本验收。此次只读定位发现真实默认库仍活跃，以及随后建立的现成备份；现有记录不足以把某份备份可靠绑定到当次清理前后校验。没有打开、迁移或复制真实数据库，也没有读取、复制凭据。
8. 并行/取消输入：Linux mock 27 项加真实靶窗 **23/23**，排队取消不落键、按住取消/超时释放、worker 意外退出释放及 1.6 实际缩放均过，未重建持久 host 隔离。[输入证据](evidence/issue21/physical-input-de4ae9f4.json)。

## 剩余项与关闭条件

在能可靠定位当时实际 profile 的安全副本并完成适当复验之前，**不关闭 #21，不勾选该条款，不以合成形状放宽原验收标准**。最小下一步是核实当时清理记录与备份的来源对应关系；若必须修改或启动当前真实 profile，先停止该步骤并交由用户决定。不能为了关单干扰当前实例、启动真实业务或复制凭据。

Windows、发行包、全部 GUI 不属于本轮已验证范围。旧 RFC 地址的 URL-policy 拒绝仍保留，未换路重试；当前独立预先指定的公开页面读取成功不等于该 RFC 页面已核验。业务预算的原“保留”要求已被用户后续明确退役预算的方向替代。
