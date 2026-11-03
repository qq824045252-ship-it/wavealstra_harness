# 请求缓存诊断

增量证据账本已解决已验证的跨轮历史替换机制，但真实长任务中仍观察到轮内偶发低命中。历史用量没有保存最终请求，不能据此决定再修改哪一层。0.1.81 增加请求指纹，作为定位依据；不改变缓存策略、消息、工具、采样参数或重试次数。

## 记录位置与边界

主进程聊天模型调用默认写入 `~/.mybuddy/logs/cache-requests-YYYYMMDD.log`，沿用现有日志的按天、4 MiB 文件轮转与保留机制。`MYBUDDY_CACHE_TRACE=0` 可关闭记录。记录失败不阻断模型调用，也不绕过权限、取消和请求大小门禁。

0.1.82 起，原生子代理在相同的供应商/HTTP 边界使用同一个指纹实现。元数据通过 Pi 的原生 stdout 队列发送，宿主在专用 RPC 回调中落盘，不进入模型历史、工具输出或 UI 事件。子代理 session/transcript 仍按既有生命周期销毁；日志以 `source=subagent`、子会话 SHA-256 和 `parentSessionHash` 保留归属。HMAC 密钥仍只存在各 worker 内存中，跨 epoch 不比较内容。

每个模型调用有独立 request ID：

- `provider`：调用方 `onPayload` 替换/修改完成后的请求对象。
- `http`：实际交给 fetch 的 JSON 字符串；独立记录每次发送及 HTTP 状态。
- `result`：对应模型回复的 response ID 哈希、用量和停止原因。
- 可用的会话边界：用户条目、证据账本、重建、压缩及当前操作的哈希。

请求正文、图片、推理签名、工具参数、完整 URL、凭据和完整请求头均不写入日志。内容、参数、工具 schema、路由相关头使用进程私有随机密钥的 HMAC；密钥不落盘。session ID 和 response ID 使用 SHA-256，供与本地会话/网关记录对应。

每项 input/messages 的指纹及第一个差异的字段名可定位“哪条历史变了”。未缓存输入与缓存读取分别保留，避免错误分母。模型返回的实际模型名另存为哈希。

## 明确不作推断的情况

- 进程重启产生新 epoch；不同 epoch 的内容哈希不能相互比较。
- 最多保留 32 条内存比较链、每次最多 4,096 项、16 MiB JSON。超过限制、无法解析、观察失败会标记覆盖不全并中断比较链。
- 任意请求流和 WebSocket 没有最终 HTTP JSON 覆盖。仅有 `onPayload` 不能声称看到了网络请求体。
- 配置了请求大小门禁时，门禁可能把字符串转换为 Request 流；这种发送明确标记为覆盖缺口，不额外消费请求流。
- 稳定的客户端请求不证明网关转发正文或供应商内部缓存节点稳定。
- 用户换轮、压缩、分支和工具配置变化都可能是合法边界。指纹变化本身不是错误判定。
- 旧版只覆盖宿主聊天调用；子代理完整追踪需要运行 0.1.82 或更新的 worker，历史汇总不能补出已删除的请求指纹。

## 审计

```text
pnpm -s cache:trace
pnpm -s cache:trace -- --session <原生 session UUID 或其 SHA-256>
pnpm -s cache:trace -- --dir <日志目录>
```

结果区分：客户端请求变化、重试时请求变化、前缀稳定但低命中、没有可比前驱、历史日志缺口和 HTTP 覆盖缺口。重试与前一个逻辑请求分开比较，避免第二次发送覆盖掉首次发送时的前缀变化。日志序号用于跨轮转文件恢复顺序。

传入父会话 `--session` 也会返回其子代理的记录，各调用带来源和父会话哈希；传入子代理 ID 则只查看该子会话。`historyUncachedTokens` 是“上一请求输入总量 − 本次缓存读取量”的非负估计，超过 `max(512, 上一请求输入的 8%)` 时标记稳定前缀下的缓存复用不足（低于 50% 为 `stable-prefix-low-cache`，其余为 `stable-prefix-partial-cache`）。低百分比但旧输入已完整命中的调用标记为 `stable-prefix-new-input`，不再把大块新文件内容误报为历史缓存失效。该估计有分块取整和计量差异，不能直接当作浪费或费用节省。

子代理 Context Contract 增加按任务路径/符号逐步读取及复用未变化区间的指引。文件变化、截断或证据不足时仍要求重新读取，不截断工具返回、不改写历史，也不降低必要的审查和测试要求。提示指引不等同于已经验证了真实任务的命中率提升。

`stable-prefix-low-cache` 是继续检查网关/上游的证据，不是自动给上游定责。`client-request-changed` 应结合第一个差异和边界事件，确定是否为预期变化。

## 长历史回放

```text
pnpm -s cache:replay -- --session-file <会话 JSONL> --from 80 --count 8
pnpm -s cache:replay -- --session-file <会话 JSONL> --from 80 --count 8 --live
```

默认使用模拟 fetch，禁止实际联网；`--live` 使用已配置的 Magpie 模型，最多 12 次调用，每次有 90 秒超时。Windows 下若包管理器把带引号的文件参数原样传递，可在编译后直接用参数数组调用 `node out/tests/cache-long-session-replay.mjs`。

脚本只读取历史文件，通过 Pi 原生投影和当前供应商序列化器回放。它添加固定诊断提示及占位工具声明；原生历史系统条目若存在仍参与投影。原来的临时证据没有被恢复，因此不等同于原始线上请求的完整复原。使用新会话/cache 标识，回复不写回用户会话，模型即使返回工具调用也不会执行。

## 本次证据

- `test:cache-request-trace`：原生 Responses 序列化与模拟 fetch，覆盖调用方替换、503 → 200 重试、正文/凭据保护、权限和大小门禁、日志失败隔离、长历史及报告分类。
- `test:context-ledger`：44 次序列化请求通过，已有证据生命周期契约保留。
- 完整 headless 门禁：254 通过、0 失败；未调整失败基线。
- 频谱仪历史 #80–#87：8 次离线回放、8 次真实模型回放，均观察到 7 次完整前缀延续。真实输入约 15–16 万 tokens，原先的骤降未复现。模型回复未执行为工具。

详见 [真实用户任务审计](../artifacts/cache-investigation/real-tasks/findings.md) 和 [截图、子代理、搜索归因核对](../artifacts/cache-investigation/real-tasks/content-claims-check.md)。剩余轮内异常应在新版自然运行时依据指纹定位，当前不宣称已消除全部缓存波动。

## 安装包验收

0.1.81 从提交 `36fdd95` 的固定源码导出构建，依赖单独复制安装。打包文件门禁和 Pi worker 启动通过。使用临时 HOME/userData、隐藏窗口和本地可控 Responses 服务，通过真实 preload IPC 发起三次聊天请求：前缀保持追加，故意返回的一次低缓存用量被归为 `stable-prefix-low-cache`，日志中没有测试正文或密钥。此桌面夹具不是额外的真实云模型试验。

桌面和开始菜单快捷方式均已读回 target、cwd、icon、`com.mybuddy.app` 身份。验收时旧 0.1.79 仍在运行，因此保留旧目录和进程；用户完成当前任务并重新启动后，新追踪才生效。实际包哈希、验证摘要及快捷方式记录见 [0.1.81 验收记录](../artifacts/cache-investigation/request-trace-acceptance.json)。

## 0.1.82 子代理验收

源码提交 `609ab5d`：类型检查无新增错误，headless 门禁 255 通过、0 失败。新增 `test:subagent-cache-trace` 用真实 Pi RPC 子进程和本地 Responses 服务覆盖连续文件读取、503 原生重试、稳定前缀下模拟归零、父会话查询、追踪关闭及既有销毁行为。

实际 Windows 包通过 payload 门禁；隐藏窗口和临时 HOME/userData 下，宿主三轮聊天验证通过，另一次真实 IPC 派发覆盖宿主 2 次、原生子代理 3 次调用。子代理清理后仍可按父会话核对完整指纹，正文和凭据未进入日志。模拟低缓存用于验证诊断，不代表已经复现或修复此前真实任务中的九次子代理归零。

桌面和开始菜单快捷方式已指向 0.1.82，并读回目标、工作目录、图标和应用标识。0.1.79 已在确认无进程/快捷方式引用后清理；正在运行的 0.1.81 保留且未重启，新子代理追踪在正常启动新版后生效。详细证据及限制见 [0.1.82 验收记录](../artifacts/cache-investigation/subagent-trace-acceptance.json)。
