# 子代理配置与退出诊断修复

目标：设置 → 模型中可配置子代理候选模型、模型白名单与执行时间；运行时实际执行同一策略。保留无关脏文件和当前工作进程。

- [x] Ground：DTO/AgentService 丢失 roles/timeoutMs；UI 仅默认模型和思考；显式模型能覆盖默认。运行中崩溃未返回已有 stderr 尾部。历史 Vertex 400 无字段级根因证据。
- [x] Sketch：复用 subagent.json，新增共享 SubagentExecutionPolicy (allowedModels?, roles?, timeoutMs?, timeoutPolicy?: fixed|allow-override)。未设白名单不限；空名单拒绝全部。单一解析器校验并被主进程/worker共同使用。策略在选择前过滤、启动前和发送前复核。
- [x] Agree：按最小增量方案实施。固定时限优先于调用，保留可选调用覆盖；不引入空闲超时或自动重试，避免与总时限混淆。
- [ ] Implement：共享策略、IPC、独立设置组件、执行回执时间来源与退出错误。
- [ ] Prove：行为回归、真实 worker HTTP夹具、实际 Electron UI 保存重开、真实提供商短任务、headless门禁及Windows包。
- [ ] Review/release：thermos、补丁版本、选择性提交/main push、包验证与快捷方式。

吞吐检查点：先证明设置/运行时一致，再处理 UI 和诊断；无权限/模型替代探测，不重复运行无结果长委派。默认时间保持600秒，当前用户配置将固定使用设置时限；模型名单不代用户猜选。HTTP400未证实的字段不修改。
