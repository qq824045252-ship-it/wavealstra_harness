# MyBuddy Remote 架构复审

> 评审对象：`app/remote`（Android 壳 + Web 前端）+ `src/main/remote`（主进程服务端）+ `shared/src/remote-contract.ts`（契约）
> 基线：`app/remote/android/.workbuddy/memory/2026-09-09.md` 的架构梳理快照（含 09-08 扫码、09-04 MVP）
> 本次 HEAD：`9619615`（2026-09-11「ignore generated remote build artifacts」），工作区干净
> 评审时间：2026-09-12
> 方法：全量读源码 + 差异比对 + 契约核对；行号均来自当前 HEAD 实测

---

## 1. 一句话结论

**架构骨架没走样，反而更清晰了**——主进程唯一真源、Android 纯消费者、契约单向下行的三层结构在 09-09 → 09-11 的两轮大改（LAN 发现 + USB 直连 + 连接页/通知中心重写）中保持住了，认证与凭据链路的质量明显高于同类项目。

**但新增了 4 个"没接线"的仿 Claude 控件、1 个形同虚设的 Origin 校验、1 处会误导人的文档漂移**，以及一个已经撑不住的 1699 行单文件 UI。这四项是本轮最该处理的。

| 维度 | 评价 |
|---|---|
| 分层与依赖方向 | 好：契约 → 服务端 → 客户端，单向，无回环 |
| 安全模型（配对/令牌/凭据） | 好：明文不落盘、Keystore 加密、安装实例幂等轮换、审批不放大权限 |
| 边界清晰度 | 好：手机端只拿 `/v1` 窄接口，无文件系统/cwd/sessionFile 泄漏 |
| 传输通道 | 中：三条通道并存且各有约束，但 LAN 明文通道缺乏额外防护 |
| 前端工程结构 | 差：`App.tsx` 1699 行 + `app.css` 1852 行承载全部 UI |
| 真实可用性 | 差：附件/模型/联网搜索/Tool access 四个控件是纯装饰，用户以为生效 |
| 文档同步 | 差：`docs/android-remote-access.md` 与代码直接矛盾 |
| 测试覆盖 | 中：服务端强（安全断言密集），客户端与原生零覆盖 |

---

## 2. 现状分层架构

三层 + 三条入网通道，全部状态收敛在 Windows 主机：

| 层 | 位置 | 规模 | 职责 |
|---|---|---|---|
| 契约层 | `shared/src/remote-contract.ts` | 251 行 | 单一类型真源，服务端与客户端同时消费 |
| 服务端 | `src/main/remote/`（12 文件） | 1468 行 | HTTP/SSE 服务、配对、设备库、事件总线、DTO 映射、UDP/mDNS 发现、ADB 桥接 |
| 桌面装配与 UI | `src/main/index.ts:2582`、`src/renderer/src/components/settings/RemoteAccessTab.tsx` | 482 行 | 控制器实例化、8 个 IPC、设置页（开关/双模绑定/QR/USB 设备列表） |
| Android 壳 | `app/remote/android/.../`（3 个 Kotlin） | 400 行 | Capacitor 宿主、Keystore 凭据插件、局域网发现插件 |
| Web 前端 | `app/remote/src/`（11 文件） | 4608 行 | React 19 + Zustand，Connect / Home / Chat 三页 |

服务端内部再分 12 个单一职责文件，依赖方向是「Controller 装配 → Server 路由 → Service/Commands 业务 → Store/Bus 基础设施」，没有反向依赖。这是本次改动里质量最高的一处。

### 2.1 服务端模块职责表

| 文件 | 行数 | 职责 | 备注 |
|---|---|---|---|
| `RemoteAccessController.ts` | 188 | 生命周期编排、设置读写、IPC 入口 | `enqueue()` 串行化生命周期（:142-146），`configure` 失败回滚（:94-104） |
| `RemoteAccessServer.ts` | 295 | HTTP 路由、鉴权、CORS、SSE、静态托管 | 唯一允许 `127.0.0.1` / `0.0.0.0` 两种绑定（:87） |
| `RemoteAccessService.ts` | 65 | 只读查询：bootstrap / history / runtime / notifications | 构造时注入 db/agent/notifications/projects |
| `RemoteTaskCommandService.ts` | 150 | 写操作：建任务、追加 prompt、abort、审批响应 | 三种领域错误类，映射到 400/404/409 |
| `RemoteDeviceStore.ts` | 160 | 设备库：签发、轮换、鉴权、撤销 | 原子写 + 0600 + 只存 tokenHash（:157-176） |
| `RemoteAccessPairing.ts` | 53 | 一次性配对会话，5 分钟 TTL，5 次失败作废 | 恒时比较 secret（:12-16） |
| `RemoteEventBus.ts` | 91 | 事件环形缓冲 + 订阅广播 + SSE 序列化 | 1000 条 / 5 分钟裁剪（:7-8） |
| `RemoteDtoMapper.ts` | 105 | 内部 DTO → 远程契约，**白名单式**投影 | 主动剔除 `cwd` / `sessionFile` / `path` |
| `RemoteDiscoveryService.ts` | 166 | mDNS publish + UDP 3353 应答器 | 双通道，任一失败降级不阻塞 |
| `RemoteNetwork.ts` | 38 | 私网判定、LAN 地址枚举、虚拟网卡过滤 | 排除 WSL/VPN/Tailscale/docker 等 |
| `RemoteUsbBridge.ts` | 130 | adb `reverse` + 校验安装 + intent 唤起配对 | 四步链式校验，失败即回收 |
| `remoteSchemas.ts` | 27 | zod 严格模式入参校验（`.strict()`） | 客户端多传字段直接 400 |

### 2.2 客户端内部结构

`api/`（4 文件，纯传输）→ `store/remoteStore.ts`（374 行，状态与编排）→ `App.tsx`（1699 行，全部 UI）。

- `RemoteClient.ts`：REST 封装 + 手写 SSE fetch reader（因 `EventSource` 无法带 Authorization 头，必须手写）
- `RemoteEventStream.ts`：1s→15s 指数退避重连 + `last-event-id` 续传
- `credentialStore.ts`：原生 Keystore / 浏览器 sessionStorage 双通道 + 配对链接协议白名单
- `remoteDiscovery.ts`：原生发现结果再经 `/healthz` 二次校验，失败即丢弃

---

## 3. 与 2026-09-09 基线的差异

两轮提交（`b706233` 09-09、`19e3225` 09-11）共 **+4323 / -230 行、23 文件**。

| 变更 | 承载文件 | 架构含义 |
|---|---|---|
| LAN 绑定模式（`bindMode: lan`） | `RemoteAccessController.ts:153`、`AppSettingsStore.ts:58-61` | 打破原「只允许 loopback」的设计前提，新增一条明文传输通道 |
| mDNS + UDP 自动发现 | `RemoteDiscoveryService.ts`（新 166 行）、`RemoteDiscoveryPlugin.kt`（新 238 行） | 新增"零输入连接"能力，但只能加速**已配对**设备重连 |
| USB 直连配对 | `RemoteUsbBridge.ts`（新 130 行） | 新增第三条通道：`adb reverse` 把主机回环端口映射到手机 |
| 设备身份幂等 | `RemoteDeviceStore.ts:44-95` | `installationId` 哈希去重 + 旧版同名行接管，重配对只轮换 Token 不新增行 |
| 连接页重写 | `App.tsx:90-295` | 从"扫码+粘贴"扩为"发现列表 + 扫码 + 剪贴板 + 高级手动"四段式 |
| 通知中心 | `App.tsx:1563-1643`、服务端 `read-all`/`clear-all` | 新增两个写接口 + 本地已清理集合（`localStorage`）防复活 |
| 抽屉改日期分组 | `App.tsx:1436-1558` | 今天 / 过去 7 天 / 更早 |
| 两个 bottom sheet | `App.tsx:967-1224` | Add to chat（附件/联网/项目/工具权限）+ Select model |
| Android 三级返回 | `App.tsx:18-42, 59-80` | `backButton` + `popstate` 双通道拦截，弹层 → 会话 → 退出 |
| 契约扩展 | `remote-contract.ts:193-251` | `RemoteBindMode` / `RemoteStatus.lanUrls` / `RemoteUsb*` / `RemoteAccessIpc` 8 项 |

**注意**：09-09 快照列的 API 面不完整，遗漏了已存在的 `GET /v1/tasks`、`GET /v1/device/me`、`POST /v1/device/revoke-self`。当前完整路由共 17 条（见 §5）。

---

## 4. 三条入网通道对比

| | Tailscale HTTPS | 局域网 HTTP | USB 直连 |
|---|---|---|---|
| 服务端绑定 | `127.0.0.1` | `0.0.0.0` | `127.0.0.1` |
| 传输 | TLS | **明文** | 明文（走 adb 隧道，不出网卡） |
| 首次配对 | 桌面 QR / 链接 | 桌面 QR，指向 LAN IP | 桌面点「USB 配对」，自动 `am start` 深链 |
| 传输依赖 | Tailscale serve | 同网段 | USB 线 + adb + USB 调试授权 |
| 安全强度 | 高 | 中（见 P0-1） | 高（物理线缆 + 权限管控） |
| 自动发现 | 不参与 | mDNS → UDP 3353 兜底 | 不参与 |

`RemoteUsbBridge.prepare()` 的四步链：`adb reverse tcp:P tcp:P` → `pm path` 校验已安装 → `am start -W -d <pairingUrl>` 唤起深链 → 返回设备。任何一步失败都会回收 reverse 规则（`RemoteUsbBridge.ts:57-88`）。

关键设计优点：USB 配对写入的凭证是 `http://127.0.0.1:port`，拔线后失效；但 `connectDiscovered` 会用**同一个 Token** 覆写 baseUrl 为 LAN 地址（`remoteStore.ts:162-168`），实现"USB 配对一次、之后局域网直连"。Token 不变、baseUrl 可变，这个解耦是对的。

---

## 5. 完整 API 面（当前 HEAD 实测）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 发现阶段的身份探针，返回 ok/service/apiVersion |
| POST | `/v1/pair/exchange` | 无（靠 pairingId+secret） | 一次性换取 deviceToken |
| GET | `/v1/events` | Bearer | SSE，支持 `last-event-id` 续传 |
| GET | `/v1/bootstrap` | Bearer | spaces + projects + tasks + 未读数 + 设备信息 |
| GET | `/v1/tasks` | Bearer | 任务列表 |
| GET | `/v1/device/me` | Bearer | 当前设备 |
| POST | `/v1/device/revoke-self` | Bearer | 设备自撤 |
| POST | `/v1/tasks` | Bearer | 建任务并投递首条 prompt |
| GET | `/v1/tasks/:id/history` | Bearer | 会话历史 |
| GET | `/v1/tasks/:id/runtime` | Bearer | busy / todos / interactions / 待审批 |
| POST | `/v1/tasks/:id/prompt` | Bearer | 追加消息（busy 时转 followUp） |
| POST | `/v1/tasks/:id/abort` | Bearer | 中断 |
| POST | `/v1/tasks/:id/actions/:toolCallId/respond` | Bearer | 审批（deny / allow-once / allow-task-dir） |
| GET | `/v1/notifications` | Bearer | `unreadOnly` + `limit`（上限 200） |
| POST | `/v1/notifications/:id/read` | Bearer | 单条已读 |
| POST | `/v1/notifications/read-all` | Bearer | 全部已读 |
| POST | `/v1/notifications/clear-all` | Bearer | 全部清理 |
| GET | `/*` | 无 | 静态托管 SPA，带 CSP |

请求体上限 512 KB（`RemoteAccessServer.ts:13`），全部写接口走 zod `.strict()`（多传字段直接 400，防参数注入——测试里对 `cwd` / `targetPath` 有专门的防回归断言）。

---

## 6. 问题清单

### P0-1｜Origin 校验形同虚设 + CORS 反射任意来源

**证据**
- `RemoteAccessServer.ts:124`：`if (!this.options.baseUrl?.trim()) return;` —— 默认配置 `remoteAccessBaseUrl = ""`（`AppSettingsStore.ts:160`），因此**默认状态下写操作完全跳过 Origin 校验**。
- `RemoteAccessServer.ts:37-41` / `:135-146`：CORS 把请求方 `Origin` 原样回显，无白名单。

**影响**
局域网模式下（`0.0.0.0` + 明文 HTTP），同网段任意网页可在用户浏览器中向 `http://<lan-ip>:3352` 发起跨站写请求。虽然写接口仍需 Bearer Token，但 `/v1/pair/exchange` 是**未认证**的——若配对链接或二维码在窗口期（5 分钟）内被截图外泄、发到群里，攻击者可跨站抢注设备 Token。

**建议**
1. 删除 `:124` 的提前返回，改为：`baseUrl` 为空时**拒绝**跨域写（只允许 `capacitor://localhost` / `http://localhost` / 无 Origin 的原生请求）。
2. CORS 改为白名单：`capacitor://localhost`、`http://localhost`、`baseUrl` 的 origin、以及 LAN 模式下的 `http://<lan-ip>:<port>`；不匹配返回 403 而不是回显。
3. 配对接口对未携带可信 Origin 的请求同样收紧。

### P0-2｜四个"仿 Claude"控件完全没有接线

这是本轮改动里最伤用户的一类问题——UI 做得很完整，行为一点没变。

| 控件 | 位置 | 实际行为 |
|---|---|---|
| Select model（Fable 5.1 / Opus 5 / Sonnet 5 Thinking / Haiku 4.5） | `App.tsx:1149-1172` | 只写进 store 显示在胶囊上（:902），**从不发给服务端**；服务端恒用 `settings.defaultModelId`（`RemoteTaskCommandService.ts:64`） |
| Web search 开关 | `App.tsx:970, 1093` | 只翻转本地布尔值 |
| Tool access（Auto / Ask first） | `App.tsx:972, 1117-1133` | 只翻转本地字符串 |
| 附件（Camera / Photos / Files） | `App.tsx:331-335, 585-589` | 读到 `dataUrl` 后**丢弃**，只发一行文本 `[附件: a.png]` 进 prompt |

**根因**：契约层根本没给这些字段留位置——`RemotePromptRequest` 只有 `text / spaceId / projectId / welcomeMode / modePresetId`（`remote-contract.ts:145-151`）。所以不是前端忘了接，而是"契约没定就先把 UI 画了"。

**建议**（按成本递增）
1. **最低成本**：模型列表改为从服务端真值拉取（`/v1/bootstrap` 增加 `models` + `defaultModelId`），或先隐藏该 sheet 直到契约补齐。
2. 扩充 `RemotePromptRequest`：`modelId?` / `permissionMode?` / `webSearch?`，服务端在 `createAndPrompt` / `promptExisting` 里透传给 `agent.prompt`。
3. 附件走真实上传：新增 `POST /v1/tasks/:id/attachments`（multipart 或 base64 分片，注意现有 512 KB 请求体上限），返回附件 id 再随 prompt 引用。这一项工作量最大，建议单独排期。

### P1-1｜LAN 明文通道缺乏额外防护

`AndroidManifest.xml` 全局 `usesCleartextTraffic="true"` + `capacitor.config.ts` 的 `allowMixedContent: true`，加上 LAN 绑定，意味着 Bearer Token 与全部对话内容（含工具输出、文件路径）在局域网内明文传输，可被嗅探或 ARP 欺骗。

**建议**：改用 `network_security_config.xml`，只对 RFC1918 私网段放开明文，并对 `cleartextTrafficPermitted` 做域级白名单；同时在设置页 LAN 模式旁给出明确风险提示（当前面板只显示 "LAN listening"，无警示）。

### P1-2｜`App.tsx` 1699 行单文件 + 1852 行 CSS

一个文件里塞了 3 个页面 + 9 个组件（Composer / 两个 Sheet / 抽屉 / 通知 / 工具卡片 / 工具组 / 思考折叠 / 代码块）+ 辅助函数。`remoteStore.ts` 也把数据态（`histories`/`runtimes`/`live`）与 UI 态（`isDrawerOpen`/`isModelSheetOpen`/`attachments`）混在一起；而 `store/remoteUiState.ts` 名字像 UI store，实际只是两个 localStorage 读写函数——**命名误导**。

**建议**：按 `pages/` + `components/` + `stores/`（data / ui 分离）拆分；`remoteUiState.ts` 改名为 `persist.ts`。纯搬迁，不改行为，可以一次做完。

### P1-3｜事件总线全量广播 + 流式期间易被击穿

`MAX_EVENTS = 1000` / `MAX_AGE_MS = 5min`（`RemoteEventBus.ts:7-8`）。但 `text_delta` / `thinking_delta` 是**逐 token 事件**，一轮长回答轻松产生上千条——缓冲被击穿后 `replayAfter` 返回 `null`，服务端下发 `resync_required`，客户端被迫全量拉 bootstrap + history（`RemoteAccessServer.ts:250-259`、`remoteStore.ts:305-310`）。

另外 `RemoteEventBus` 对订阅者无 taskId 过滤，所有已配对设备收到全部任务的流。

**建议**
1. 对 `agent.patch` 的 delta 类事件做合并：同一 `messageId` 的连续 delta 合并为快照，或按 taskId 分片独立缓冲。
2. 单独放宽 delta 类事件的保留窗口，把结构性事件（`tool_start` / `assistant_end` / `pending_action.changed`）与流式 delta 分开管理。

### P1-4｜SSE 状态"乐观上报"

`RemoteEventStream.ts:27-28`：在 `await fetch(...)` **之前**就调用 `onState(true)`。连接实际失败时会先报 `connected` 再报 `reconnecting`，状态灯抖动、`visibilitychange` 触发的 resync 也可能踩在假连接上。

**建议**：把 `onState(true)` 挪到 `response.ok` 校验通过之后。

### P1-5｜自动发现无法完成"首次配对"

`connectDiscovered` 无本地凭证时直接 `return false`（`remoteStore.ts:162-167`），连接页只能提示"首次连接仍需在电脑端生成一次安全配对凭证"并打开扫码。

同时 Android 发现的候选必须再经主机 `/healthz` 二次校验（`remoteDiscovery.ts:30-56`），而 `/healthz` 不鉴权——局域网内任何主机都能应答 UDP 广播并伪装成功（UDP 侧已有 nonce 校验，能防缓存投毒，但防不住主动应答）。

**建议**：主机设置页增加"允许局域网首次配对"开关（默认关），开启后 `/healthz` 返回一次性配对入口，让"发现即连"真正闭环；风险提示与 P1-1 合并处理。

### P1-6｜文档与代码直接矛盾

`docs/android-remote-access.md` 写着：

> Do not enable Tailscale Funnel. MyBuddy deliberately refuses `0.0.0.0`/LAN binding...

**当前代码完整支持 LAN 绑定**（`RemoteAccessController.ts:153`、设置面板 `RemoteAccessTab.tsx:311-312` 有"仅本机 / 局域网"按钮）。该文档同时完全未提 mDNS/UDP 发现与 USB 直连两条新通道，也没提 `mybuddy://pair` 深链。

**建议**：立刻重写该文档为"三通道"版，并把 §4 的对比表搬进去。这是当前最容易误伤下一个维护者的地方。

### P1-7｜`adb reverse` 生命周期无人回收

`RemoteUsbBridge.prepare` 建立 reverse 后不再拆除，拔线、换机、关设置都不清理。长期使用会残留映射（重启 adb server 才清）。

**建议**：在设计页加"断开 USB 通道"动作，或在 `dispose()` / 关闭 Remote Access 时批量 `adb reverse --remove-all`。

### P2 级（整洁度）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | 契约双路径：`shared/src/remote-contract.ts` 与 `src/shared/remote-access.ts`（后者纯 re-export），且服务端用相对路径 `../../../shared/src/...` 而非 `@shared` 别名 | 各服务端文件 import 行 | 统一走 `@shared` 别名，删除 re-export 层 |
| 2 | 端口常量四处重叠：默认 API 3352、发现 UDP 3353、Vite dev 3353、Android `DISCOVERY_PORT` 3353 | `AppSettingsStore.ts:159`、`RemoteDiscoveryService.ts:8`、`vite.config.ts`、`RemoteDiscoveryPlugin.kt` | 抽到契约层常量并由两端共同引用 |
| 3 | store 外部直写状态，绕过 action | `App.tsx:38, 604` | 收敛为 action（如 `closeTask()`） |
| 4 | `RemoteDeviceStore` 复用记忆网关的文件保护函数 | `RemoteDeviceStore.ts:5, 96, 140, 144` | 抽通用 `protectSecretFile` |
| 5 | `MainActivity` 手动 `registerPlugin(AppPlugin)` | `MainActivity.kt:9` | Capacitor 8 已内置，可删 |
| 6 | 客户端零自动化测试：`reconcileLiveMessagesWithHistory` 的 30s 文本去重、SSE 分块解析、扫码降级路径均无覆盖 | `remoteStore.ts:83-98`、`RemoteClient.ts:43-63` | 补 vitest 单测（纯函数，成本低） |

---

## 7. 值得保留的设计

这些是本轮大改里做对的地方，重构时不要动：

1. **白名单式 DTO 投影**：`RemoteDtoMapper` 主动剔除 `cwd` / `sessionFile` / `path`，并有防回归断言（`scripts/remote-access-test.ts:26-33`）。手机端拿不到主机路径信息，边界干净。
2. **Token 只存哈希 + 安装实例幂等**：`RemoteDeviceStore` 原子写 + 0600 + `tokenHash`，`installationId` 相同则轮换 Token 不新增行；还为旧版同名遗留行做了接管与去重（`RemoteDeviceStore.ts:74-90`）。演进考虑周到。
3. **配对会话恒时比较 + 失败计数**：5 分钟 TTL、单次使用、5 次失败作废（`RemoteAccessPairing.ts`）。
4. **审批权限不放大**：`allow-task-dir` 严格限定 `approvalKind === 'external-write'`，普通工具审批传该值直接 400；服务端从**自己登记的** `externalWrite.canonicalDir` 取路径，不接受客户端传入（`RemoteTaskCommandService.ts:123-135`）。
5. **SSE 降级链完整**：`last-event-id` → 缓冲重放 → 缓冲不可用则 `resync_required` → 客户端全量刷新。断线语义闭合。
6. **生命周期串行化 + 配置失败回滚**：`enqueue()` 保证并发 configure 不打架，失败时把设置与运行时都还原（`RemoteAccessController.ts:94-104`）。
7. **Token 与 baseUrl 解耦**：USB 配对、LAN 发现、Tailscale 三种入口可共享同一设备身份。

---

## 8. 建议的推进顺序

| 阶段 | 内容 | 理由 |
|---|---|---|
| 1 | 修 P0-1（Origin/CORS）+ 重写 `docs/android-remote-access.md` | 安全洞 + 误导文档，成本最低、收益最高 |
| 2 | 处理 P0-2：模型列表接真实值或先隐藏；其余三个控件同理 | 消除"假功能"，恢复信任 |
| 3 | P1-4（SSE 状态）、P1-6（文档已含）、P2-1/2/3/4/5 批量整洁 | 低风险清理 |
| 4 | P1-2（`App.tsx` 拆分） | 纯搬迁，为后续功能腾出结构 |
| 5 | P1-3（事件总线分片/合并）、P1-7（adb 回收） | 需要设计取舍 |
| 6 | 附件真实上传（契约 + 存储 + 上限策略） | 独立特性，单独排期 |

---

## 附录：模块规模

| 模块 | 文件 | 行数 |
|---|---|---|
| 服务端 | 12 | 1468 |
| 契约 | 1 | 251 |
| Web 前端 | 11 | 4608 |
| Android 原生 | 3 | 400 |
| 桌面设置面板 | 1 | 482 |
| 服务端测试 | 1 | ~200 |
| **合计** | **29** | **~7409** |
