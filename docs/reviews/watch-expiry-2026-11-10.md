# 明确期限的持续追踪终止

## 语义

- `watchRule.endsAt` 是用户明确要求的绝对 Unix 毫秒终止时刻。前台工具说明要求按用户时区换算，不能把举例“365 天”或任意停止条件推导成期限。无限持续不填。
- `deadlineAt` 仍只是承诺到期提醒；`stopConditionText` 仍是语义目标，不能由时间调度器伪造已满足。
- 暂停不顺延期限；离线跨过期限后，正常启动即停止后续检查，不补跑过期业务。主机离线不冒充连续运行。

## 生命周期

1. cron 扫描发现明确期限，原子记录宿主所有的 `watchRule.termination`（`schedule_expired`、原定时刻、请求时刻）。同时停订阅、进入 closing、向在途执行发正常停止指令。
2. 事件入站、队列派发、原生启动/恢复均有独立期限检查，不依赖恰好赶上 scheduler 的 5 秒 tick。
3. 已发终止请求成为持久事实，时钟回拨不取消收尾。原执行回执仍正常结算，不将未知结果改成成功。
4. 有执行轮次时等最后一轮的前台监督投递/静默决定后结束，无执行轮次不冒充已有结果。
5. 终态保存 `lifecycle=closed`、`closureConclusion=NULL` 和结构化到期原因，展示“到期结束”，不统计为成功、失败或用户取消。无 CHECK 表重建，无 schema 版本变更。
6. 原对话中性结束通知可重放去重；保留已有成果、未覆盖内容和执行证据。不制造成功/失败成果卡片。

## 验证

- 专项：时间边界、暂停、正常数据库重开、在途停止回执、最后一轮监督门闩、时钟回拨、重复扫描、延期、用户取消优先、提醒与语义条件分离、前台中性反馈、投影/摘要。
- 回归：`test:bot-watch-creation`、`test:bot-watch-intake`、`test:bot-watch-scheduler`。
- 真实场景入口：`BOT_WORK_DEV_HEADLESS=1 pnpm -s test:bot-frontdoor:live --watch-expiry`。独立 HOME、实际模型和正常墙钟，不做崩溃/强杀注入。
- 真实场景结果须以运行产物为准，本文件不预先声明通过。

## 本轮实际结果

- `pnpm -s typecheck` 通过，无新增 scripts 类型错误。
- `test:bot-watch-expiry` 通过，另已接入真实 `WorkWatchSupervision.hasPending` 账本与前台投递的联合专项（模型回复使用受控夹具，未冒充真实 LLM）。
- `test:bot-watch-creation`、`test:bot-watch-intake`、`test:bot-watch-scheduler`、`test:work-watch-supervision` 通过。
- `test:remote-work-sync` 19 项通过；`test:bot-work-phase5-reconnect-diagnostics` 19 项通过。
- 真实模型场景尝试两次，均在首条前台请求收到 Open Design/Cloudflare origin invalid or incomplete response，上游未正常结束流，未创建 Work。**真实 LLM 有限期链路尚未验收通过**，不能把专项的受控回复当作真实模型验收。
- 测试代理补齐客户端断连取消上游与 240 秒请求超时，避免错误长流拖住隔离测试清理。仅影响测试夹具。
- 无生产资料修改、无生产实例重启、无崩溃故障注入。

复验命令见上。成功条件：真实模型创建含明确 endsAt 的 Watch、原生读取实际文件、回到原对话、真实墙钟到期并等最后一轮监督结算、显示“到期结束”而不是成功/取消、随后至少一个分钟槽没有新派发。
