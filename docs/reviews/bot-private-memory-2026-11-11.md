# Bot 专属记忆与管理入口

## 实现边界

已有记忆引擎以 `scopeType=bot, scopeId=botId` 持久化私人记忆；不是每个 Bot 新建一份数据库。前台记忆读写限定该 Bot，同 Bot 新旧对话共享，团队不自动继承成员私人基线。Work 使用可信执行绑定的 Bot 身份，不能伪造另一 Bot 身份更新私人记忆。本次不迁移、不删除既有用户记忆。

新增 Bot 设置 → 专属记忆，复用现有记忆管理器。查询固定当前 Bot，不加载全局统计、候选、画像或整理操作，不允许切换到其他作用域。支持搜索、查看来源与历史、编辑私有条目及移除当前 Bot 的记忆。

旧共享条目保留且明确标注：此处只读，移除只解除当前 Bot 绑定；其他作用域的内容保留。最后一个绑定移除时沿用现有记忆服务删除语义。设置页不再显示会误导用户的额外“保存 Bot 设置”按钮，记忆编辑即时保存。

## 验证

- 类型检查通过（scripts 零新增）。
- `test:all --filter=memory`：19 passed / 0 failed / 0 known / 0 regression。
- `test:bot-settings` 通过。
- Electron `test:memory-ui` 通过：固定服务端查询范围、另一 Bot 不出现、不读全局数据、切换 Bot 不残留、旧共享条目禁止全局编辑且只解除当前 Bot 绑定。部分通用截图捕获受 Wayland 限制；断言均正常执行。
- 真实模型 `opendesign/deepseek-v4.1-flash-eco`、真实 `pnpm dev` Electron renderer、独立 HOME：`pnpm -s test:bot-frontdoor:live --bot-isolation` 六类任务全部通过（库存计算、行程建议、会议议程、文字改写、单位换算、出门清单）。
- 两个 Bot 自然学习不同标记，六项各自创建不同对话 ID；A 更正和忘记后 B 记忆不受影响；逐次检查真实模型请求与回答均不包含另一 Bot 标记。
- 真实 dev 专属记忆页面截图已人工核看。Linux headless renderer 不冒充物理鼠标或 Windows 验收。

## 后续边界

无生产数据改动、无打包或版本号变更。崩溃故障注入仍按用户要求后置。已主动共享到其他作用域的历史数据不会静默迁移或擅删。
