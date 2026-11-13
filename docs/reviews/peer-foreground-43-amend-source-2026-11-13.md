# #43 接收方修改同一 Work：来源解析修复与真实模型验收

## 版本与范围

- 2026-11-13，Vivion 原产品仓库，基线 `94746f80c41e4ffdfa928f8e93db7d87426ebaac` 加本记录对应未提交修复。
- 直接运行生产 AgentService、Bot/Work 工具及 Durable 执行链；使用独立测试 HOME/数据库/工作目录，没有操作真实用户数据。
- 实际模型：本机 Magpie 的 `opendesign/deepseek-v4.1-flash-eco`。没有调用本地或云端 Codex，没有运行 esbuild，没有构建发行包。
- Electron 使用测试 shim；Discord HTTP/WebSocket 使用受控协议夹具。因此这是实际模型/生产服务链验收，不是 Electron GUI 或实际 Discord 账号验收。

## 根因与修复

接收方 B 的 `source.user_message_id` 对应发送方生成的 peer plan，并非原始人类输入。计划中截短的 Work ID 会污染目标解析，即使工具传入完整且正确的 Work ID，也被拒绝。04:44 批次实际模型重复触发该错误，原 Work 停留 intentRevision=1。

`BotForegroundTools.select()` 现在通过 `messages.userSource(source)` 读取经过验证的原始人类文字及引用。继续使用接纳时绑定的 selected_work_id；同一事务内的 relation.targetBotId、原 Work 身份、owner、版本守卫与 return 禁止修改等检查未放宽。

异步 peer 受理不等于执行完成。实模脚本仅在当前 A 请求拥有未取消、无错误且 queued/running 的持久 B 投递时继续等待。失败、取消或没有可继续投递仍失败；每阶段180秒期限及真实文件/终态/身份断言不变。

## 保留的失败

1. `2026-11-13T04-40-12-733Z`：真实 draft 已产出；脚本按旧同步受理语义提前失败。
2. `2026-11-13T04-44-42-043Z`：35次实际模型调用，复现上述来源解析产品缺陷，同一 Work 未改向。
3. `2026-11-13T04-53-10-678Z`：修复后同一 Work 已修订到2并成功关闭、真实 final 文件及原会话附件通过；后续方法纠正阶段仍有相同同步等待假设，整体记失败，没有当作通过。

## 最终通过

`out/diagnostics/bot-cross-channel/model-live/2026-11-13T05-01-30-316Z/report.json`：`passed`，`notReachedExpectedStages=[]`，guard exit0，503秒。

- A 委派、B 自行建立唯一 Work；A 无 Work、无团队。
- draft.txt 真实写入/读回 `DRAFT_ALPHA`，等待补充而不猜 final 内容。
- 从桌面前台补充后，原 B Work intentRevision 1→2，未重复建单；final.txt 真实写入/读回 `FINAL_BETA`，原 draft 保留，closed/succeeded。
- 原 Discord 会话受控 multipart 附件的文件内容/哈希与真实文件相符。
- 人类方法纠正形成 B 范围候选；隔离脚本审核启用（非真人 GUI 操作），A 不可发现该私有 Skill。
- 第二 Work 真实读取已挂载 SKILL.md，有 invocation_kind=read/completed 记录；写入并读回 second.txt=`SECOND_GAMMA`、verification.txt=`VERIFIED_REUSE`，closed/succeeded。
- 最终 A=0、B=2、teams=0；投递 effect 每项一次。
- 91次模型调用均有 usage：输入3,025,982、输出76,757 tokens；货币费用未知，不能把这些当作性能基准。

运行前后全部 src 文件 SHA-256 无变化，HEAD 未变化。冻结 SHA-256：

- BotForegroundTools.ts：77AC88681F995E72F3CB41C825D1A97383D55B8C957FEEDB8CEE530AED796213
- bot-peer-ingress-test.ts：F9AB5AB49484766F7DF6FC1C4438F9F06853D42586A4295FA64AFD10B79F0ED5
- bot-cross-channel-model-live-test.ts：CE075764133A8410B0C770BAEC6FE65FD017E6FAD89DD8E8B05027D06193EAEB

## 定向回归

- bot-peer-ingress-test：通过，包括原人类完整ID与计划截短ID冲突、修改同一Work、全局Work数量不变、另一既有Work完整DTO不变、来源归属、恢复及取消边界。
- bot-work-control-test：通过。
- tsconfig.node.json 与 tsconfig.scripts.json 无输出类型检查：通过。

本记录不替代其它 Issue 的真实 QQ/钉钉/Discord账号、Electron界面、跨进程常驻及统一全量验收，也不代表 #29/#31/#32/#43 全部可关闭。原有失败证据未删除。
