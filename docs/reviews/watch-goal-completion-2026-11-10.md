# 持续委托的语义停止条件（2026-11-10）

## 真实问题

基线 main `5fb186e`。隔离 HOME、真实 Electron 与真实 DeepSeek V4.1 Flash Eco 模型，委托“每分钟读取发布状态，WAITING 时继续，READY 时主动结束，无需确认”。第一轮 WAITING 回报正常；第二轮真实 read 得到 READY 后，执行器调用 `conversation_goal_propose_complete`，产生 `conversation_interactions.pending`（“确认完成 Work…”），本轮一直 running，持续事项 active，240 秒观察超时。不是 Cloudflare、网络目标或文件未读到，而是旧完成工具等待人工；前台监督也只有解释/交付，没有语义结束动作。

## 实现

- Watch 执行轮只交付真实观察。误调用完成工具立即返回前台负责结算的说明，不产生人工交互、不自行取消普通 automation；once 行为不改。
- 前台每轮真实模型输出 `stopAssessment`：明确原条件、用户要求摘录、本轮原始观察 ID 与引用。仅“检查完成/出现变化/直到用户取消”不能自动当长期目标完成。
- 证据来自宿主 native toolResult 的 file/knowledge read 原文，最多单项 16,000 字符；不靠执行器摘要自报成功或哈希。缺失、裁剪、最新失败、跨要求/owner/输入版本或错团队轮次不能作为结束依据。引用允许原文字面形式或其 JSON 转义形式，不扩展到模型摘要。
- 团队必须覆盖当前计划全部成员，使用同轮当前 binding 的最新成功回执；已恢复成员的旧失败不永久阻断，旧成功也不能替代当前失败。
- 宿主在同一事务内记录结果、停止新调度并结算。已有在途轮次走正常停止/回执/末轮回报，之后自动 `closed/succeeded`，无人工验收。持久 finishing 状态保证正常重建后不重复判读/交付。
- 用户暂停/改要求、明确期限已到、证据不足、模型失败均不能伪称完成。期限前已实际满足并被接受的目标可在跨期的安静收尾后 succeeded；未接受 met 的到期路径仍为中性“到期结束”，不是成功。关闭最终消息不受 changes_only 静默吞掉。

## 验证

- 单人真实模型 + UI：WAITING 保持 active；READY 自动结束 succeeded；无人工完成卡；实际等候 65 秒无后续执行；1280/390 宽度无横向溢出。
- `test:work-watch-goal`：31 项行为检查，包括真实格式回执、假引用/旧证据、缺少原停止要求、失败/不完整、暂停/到期/版本变化、团队完整性与恢复、慢监督期间下一轮先启动不丢前轮证据、在途收尾、正常重建和重复 wake。
- 相关专项：pi-native-control、conversation-input、bot-watch-creation、bot-delegation-fidelity、work-watch-supervision、bot-watch-expiry、work-team-watch-evidence、bot-work-team-watch、work-conversation-feedback、architecture-graph 通过。
- 类型检查通过；未运行完整 GUI/default 总门禁或实机强杀/崩溃注入。
- 团队最终真实模型测试：两成员同轮 WAITING 保持追踪；下一轮各自真实读取 READY 后，负责人/前台完整引用两个来源，自动 succeeded。期间下一轮已开始的两个成员正常 stopped，不伪称成功；它们结算后完成关闭。原始 pending 完成确认数为 0，实际静置 65 秒没有新增执行。

团队首次实测进一步发现：负责人汇总结束后，下一轮已启动，原实现按“当前团队轮次”取证导致上一轮原始观察变空，虽然模型识别就绪仍不能结束。改为按负责人持久 `inboxEventId` 取同轮全部成员的最新有效 binding，下一轮仅影响收尾，不否定已发生的本轮事实。同一次测试还出现负责人回读 READY 但成员该轮仍为 WAITING，前台如实判定条件未满足，没有把不同时间的结果拼成“同轮全部就绪”。

升级重放时，旧完成确认只按同一任务/执行/toolCallId 精确取消，其他用户问题和已有回答不动；`conversation-runtime` 的正常重建回归通过。实际截图还发现原关闭反馈重复完整报告，已将本路径最终消息缩为中文“条件满足，已完成，不再检查”，详细依据留在本轮报告。

## 边界

此次是“用户明确的可观察停止条件”闭环，不是任意新目标规划器。自动调整频率、启动额外业务动作尚未实现。原始停止核验目前覆盖完整 file/knowledge read；未声称完成 X/API/任意网页语义停止验收。没有可靠原文时保留关注并如实说明，不能伪造达成，也不增加人工审批。
