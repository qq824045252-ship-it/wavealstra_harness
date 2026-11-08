# 内置 Cloudflare Tunnel（Remote Access）调研

> **状态（2026-11-09）：不实施。** 产品决定不做内置隧道/API 托管，只在「远程连接」设置页检测本机
> 是否装了 `cloudflared`（见 `src/main/remote/CloudflaredCli.ts`）。本文保留为调研与决策记录，
> 其中的实现方案（§5、§9、§10、§11）均为未实施的候选设计。

> 目标：让「手机远程连接电脑端 MyBuddy」不再要求用户自己装 cloudflared / Tailscale、手动填 https 地址；
> 桌面端点一下就能拿到一个手机可访问的地址，并且地址自动回填到 Remote Access 的 `baseUrl`。
>
> 结论先行：**可行，且是当前最省事的一条路**；推荐「内置 cloudflared 子进程 + 两种模式（Quick / Named）」，
> 但有一个必须先复验的风险点：本机 POC 观测到隧道会整段缓冲流式响应（影响 `/v1/events` SSE），见 §6。
> 自用固定域名的落地方案（专用隧道 + App 托管 connector + 本地 ingress）见 §9。

---

## 1. 现状与缺口（代码锚点）

Remote Access 服务已经是「只监听 loopback + 公网反代」的形态，隧道恰好是它缺的那一半：

| 位置 | 现状 |
| --- | --- |
| `src/main/remote/RemoteAccessServer.ts:20` | `BIND_HOST = "127.0.0.1"`，服务固定监听本机 |
| `src/main/remote/RemoteAccessServer.ts:196` | `GET /healthz`（无需鉴权）→ `{ ok, service: "mybuddy-remote", apiVersion }`，可做隧道健康探测 |
| `src/main/remote/RemoteAccessServer.ts:432` | `GET /v1/events` 写 SSE，20s 一次 `: ping` |
| `src/main/remote/RemoteNetwork.ts` | `isAllowedRemoteBaseUrl()`：https 任意域名，或 loopback/RFC1918 的 http |
| `shared/src/remote-contract.ts:453` | `RemoteStatus { configuredEnabled, running, port, baseUrl, error }` |
| `shared/src/remote-contract.ts:476` | `RemoteAccessIpc`（status/configure/devices/pairing/pairWindow） |
| `src/main/AppSettingsStore.ts:64-66,179-181` | `remoteAccessEnabled/Port/BaseUrl`，端口默认 3352 |
| `src/main/index.ts:695-712,1266-1281` | IPC 注册与 settings 变更写回 |
| `src/renderer/src/components/settings/RemoteAccessTab.tsx:210` | UI 当前让人手填地址，并给 `tailscale serve --bg 3352` 命令 |
| `src/main/remote/RemoteAccessController.ts:122` | 没填 baseUrl 时配对直接报「请先填写 Tailscale / Cloudflare 连接地址」 |

也就是说：**服务端、鉴权、配对、CORS 白名单都已就绪**，缺的只是「把 127.0.0.1:3352 变出一个 https 域名」这一步，
现在外包给了用户（Tailscale Serve 或自建隧道）。

配对侧的安全底子（内置隧道后仍然生效）：

- 60 秒接入窗口 + 一次性 6 位码，**连续 5 次输错即作废**（`src/main/remote/RemotePairWindow.ts`）
- 设备令牌 32 字节随机，库里只存 sha256（`src/main/remote/RemoteDeviceStore.ts:18`）
- Origin 白名单只放行 `baseUrl` 的 origin 与 Capacitor 壳（`RemoteAccessServer.ts:150`）

---

## 2. Cloudflare 的三种接法

| 方案 | 用户要做什么 | 域名 | 适用 | 代价 |
| --- | --- | --- | --- | --- |
| **Quick Tunnel**（`--url`） | 什么都不做，点一下 | 随机 `xxx.trycloudflare.com`，**每次重启都变** | 临时演示、首次体验、没有域名的人 | 无 SLA、Cloudflare 保留限制权；换域名后手机端要改地址 |
| **Named Tunnel + token**（`tunnel run --token`） | 在 CF 后台建一条隧道，复制 token 粘进来（或 `cloudflared service install <token>` 同款 token） | 固定自有域名 | 日常远程连接（推荐默认进阶） | 需要 CF 账号 + 一个域名；ingress 在后台配一次 |
| **API 全托管**（建隧道 + 配 ingress + 建 DNS 全走 API） | 粘一个 API Token，选域名，点「创建」 | 固定自有域名 | 想把「建隧道」也做进产品 | 需要 `Account: Tunnel:Edit` + `Zone: DNS:Edit` 权限；错误处理面变大 |

**不推荐**的方向：

- 自己实现隧道协议 / 复用 Workers 反代：把「公网入口 + 证书 + 连接复用」重新做一遍，收益为零。
- 只做 WARP / `cloudflared access`（Zero Trust 客户端侧接入）：手机端要装 WARP 并加入组织，比装 App 还麻烦。
- 让用户在应用内 `cloudflared service install`：会把隧道注册成系统服务，卸载与权限都变复杂，与 App 生命周期脱节。

> 用户机器上其实已经有一条系统级命名隧道（`~/.cloudflared/config.yml`：`omarchy.vivioninst.uk → http://127.0.0.1:3352`，
> `metrics: 127.0.0.1:20241`）。这正好说明「Named Tunnel」是这台机器的现网用法，也直接决定了内置实现必须满足的两条约束（见 §4）。

---

## 3. 推荐的产品形态

三个状态，默认关闭：

```
[关闭]   不跑 cloudflared，服务只在本机
[快速隧道] 一键：spawn cloudflared --url http://127.0.0.1:<port>
           → 从日志里取 https://xxx.trycloudflare.com → 自动写入 baseUrl（标记来源=tunnel）
           → UI 明确提示：域名是临时的，重启会变；手机端需要重新填
[固定域名] 粘贴 Tunnel Token（或 token-file 内容）→ cloudflared tunnel run --token-file
           → 域名由用户在 CF 后台/DNS 决定；App 只负责展示 + 探测
```

关键交互决策：

1. **`baseUrl` 变成派生值**：`baseUrlSource: "manual" | "tunnel"`。tunnel 模式下列只读，旁边给「复制地址」；
   用户手改过就切回 manual，不再被隧道覆盖（避免自动化把一个能用的手填地址冲掉）。
2. **地址永远由主进程写**：renderer 只读 `RemoteStatus`，不猜 URL。
3. **快速隧道重启要提示**：`publicUrl` 变化时 `server.status` 事件里带上 `previousUrl`，
   UI 弹一次「地址已变化，手机端需要更新」并给复制按钮（有二维码更好，P2）。
4. **健康状态要可见**：隧道 `state` 与 `error` 并入 `RemoteStatus`，与「服务运行中」分开显示
   （服务在跑 ≠ 公网可达，这两件事故障时定位完全不同）。

---

## 4. 本机 POC 实测（cloudflared 2026.10.2，Linux x86_64）

实测命令（对本机一个临时 Node SSE/HTTP 服务做反向代理）：

```bash
cloudflared --output json --config /tmp/cft/app.yml --metrics 127.0.0.1:0 \
  tunnel --url http://127.0.0.1:3399
```

结果与坑：

| # | 观察 | 结论 / 对策 |
| --- | --- | --- |
| 1 | 约 13–20s 内日志出现 `Your quick Tunnel has been created! Visit it at https://<name>.trycloudflare.com` | URL 解析用正则 `https://[a-z0-9-]+\.trycloudflare\.com`，从 stdout 的 JSON 行里取即可 |
| 2 | 这个版本**没有** `--logformat`（报 `flag provided but not defined`），JSON 日志是全局 `--output json` | pin 版本后按该版本参数写死；升级要跑一次参数冒烟 |
| 3 | 不传 `--config` 时**自动加载** `~/.cloudflared/config.yml`：日志里 `Settings: map[cred-file:... tunnel:...]`，quick 隧道注册不上，边缘直接 530/1033 | **必须**传 App 自己的 config；`--config <userData>/cloudflared/config.yml`（内容只需 `no-autoupdate: true` + `metrics`），POC 验证可用 |
| 4 | 不传 `--metrics` 时抢 `127.0.0.1:20241` 失败：与现网系统级 cloudflared 冲突（`bind: address already in use`） | 固定 `--metrics 127.0.0.1:0`（POC 无报错）；**永远不要**碰用户 `~/.cloudflared` |
| 5 | 公网 `GET https://<name>.trycloudflare.com/healthz` → `200`，源站能收到 `cf-connecting-ip` / `cf-ray` / `cf-visitor` | 健康探测就用 `/healthz`；IP 归属可从 `cf-connecting-ip` 读（日志限流可用） |
| 6 | **流式响应被整段缓冲**：源站每 2s 写一条，12s 的流在 ~12.8s 一次性到达客户端（4KB/条、纯文本、SSE 三种都试过）；同机 loopback 直连是逐条到达。8KB/0.5s 的高频流也要攒到 ~150KB 才开始吐 | **P0 风险**，见 §6 |

补充：`cloudflared` 最新版 2026.10.7（本机 2026.10.2），发布资产大小与 GitHub API 给出的 `digest`：

| 资产 | 大小 | sha256（前 16 位） |
| --- | --- | --- |
| `cloudflared-linux-amd64` | 38.4 MB | `1f99fb518b83dec2` |
| `cloudflared-linux-arm64` | 35.9 MB | `3df43aedc9ff2…` |
| `cloudflared-windows-amd64.exe` | **52.8 MB** | `2493dbc168923…` |
| `cloudflared-darwin-arm64.tgz` | 18.9 MB | `3586ccf397e98…` |

> 注意：cloudflared 的 release **没有** `SHA256SUMS` 资产，完整性校验要用 GitHub API 的 `assets[].digest`（`sha256:...`），
> 这和 `scripts/prepare-officecli.cjs` 用官方校验和文件的写法不同。

---

## 5. 集成设计

### 5.1 新模块：`src/main/remote/CloudflareTunnel.ts`

一个进程监管器（supervisor），不碰 HTTP 逻辑：

```ts
type TunnelMode = 'off' | 'quick' | 'named'
type TunnelState = 'stopped' | 'starting' | 'connecting' | 'running' | 'error'

interface TunnelStatus {
  mode: TunnelMode
  state: TunnelState
  publicUrl?: string          // quick: 自动发现；named: 由用户 hostname 推出
  hostname?: string
  since?: number
  restarts: number
  error?: string              // 已脱敏，最多 2000 字
}
```

行为：

- **spawn**：`windowsHide: true`，`stdio: ['ignore','pipe','pipe']`，stdout/stderr 都按行切 JSON；
  同时写 `~/.mybuddy/logs/cloudflared-YYYYMMDD.log`（按天 + 大小上限，复用主进程日志的轮转思路），token 必须脱敏。
- **URL 发现**：匹配 `"Your quick Tunnel has been created"` 那条 message 里的 URL；再兜底一次全量正则。
- **就绪判定**：拿到 URL 后轮询 `GET http://127.0.0.1:<port>/healthz` 与 `GET <publicUrl>/healthz`（超时 5s，指数退避 10 次），
  两者都 200 才 `running`。只看进程活着不算成功。
- **重启**：非 0 退出或边缘连接失败 → 1s / 2s / 4s … 上限 30s，最多 N 次；每次重启递增 `restarts` 并在 UI 显示。
  Quick 模式重启必然换域名，`publicUrl` 变化要发事件。
- **退出**：先 `SIGTERM`，3s 未退 `SIGKILL`（Windows 用 `taskkill /T` 或 `child.kill()` 后兜底）；
  `app.on('before-quit')` / `remoteAccessController.dispose()` 里同步等待，避免留下孤儿进程。
- **并发**：`RemoteAccessController` 已有 `lifecycle` 串行队列，隧道启动/停止必须走同一个队列，
  否则「改端口 + 开隧道」会打架。

### 5.2 契约与设置

`shared/src/remote-contract.ts`：

```ts
export interface RemoteStatus {
  configuredEnabled: boolean
  running: boolean
  port: number
  baseUrl: string
  baseUrlSource: 'manual' | 'tunnel'      // 新增
  tunnel: TunnelStatus                     // 新增
  error?: string
}

export interface RemoteConfigureRequest {
  enabled?: boolean
  port?: number
  baseUrl?: string
  tunnel?: { mode: 'off' | 'quick' }       // named 走独立 IPC（要带 token）
}

export const RemoteAccessIpc = {
  ...,
  setTunnelToken: 'remoteAccess:setTunnelToken',   // 只写不读，返回 { configured: boolean }
  clearTunnelToken: 'remoteAccess:clearTunnelToken',
  tunnelAction: 'remoteAccess:tunnelAction',       // start | stop | restart
}
```

设置（`src/main/AppSettingsStore.ts`）：

- `remoteAccessTunnelMode: 'off' | 'quick' | 'named'`
- `remoteAccessTunnelHostname: string`（named 模式展示用，不参与连接）
- **token 不进 settings 明文**：走 `safeStorage` 加密后落 `~/.mybuddy/cloudflared/token.bin`（0600），
  或复用 `src/main/platform/credentials` 的后端；renderer 只拿到 `{ configured: true }`，
  读回一律 `••••••`（与 `GatewaySecrets` 的脱敏约定保持一致）。

> Linux 前提：`[safeStorage] linux backend=gnome_libsecret available=true`。若退化成 `basic_text`，
> 不能把它当安全存储（AGENTS.md 已有该约束），此时应拒绝保存 token 并给出可操作提示。

### 5.3 UI（`RemoteAccessTab.tsx`）

现有「连接地址」面板改成三段式：

1. 模式选择：关闭 / 快速隧道 / 固定域名（radio 或 segmented）
2. 地址区：
   - quick：显示 `https://xxx.trycloudflare.com`（loading 态显示「正在建立隧道…」），带复制；
     小字提示「临时地址，重启会变；长期使用请用固定域名」
   - named：显示 `hostname` + token 状态（已配置/未配置），未配置时给「粘贴 Token」输入框和保存按钮
   - manual：保留现在的输入框（老用户/自建反代）
3. 诊断行：`state` + `restarts` + 最后一次错误（截断、脱敏），以及「重新建立隧道」按钮

顺手把现在的 `tailscale serve --bg {port}` 提示降级成「其他方式（Tailscale Serve / 自建反代）」折叠区。

### 5.4 打包与校验

仿 OfficeCLI 的既有链路（这是仓库里已经跑通的模式）：

1. `src/shared/cloudflared-builds.json`：pin `version` + 每个 `platform-arch` 的 `asset` / `binary` / `sha256`
   （sha256 从 GitHub release API 的 `digest` 取，写进 pin 文件，构建时校验）。
2. `scripts/prepare-cloudflared.cjs`：仿 `scripts/prepare-officecli.cjs`（HTTPS + 重定向 + 原子写 + receipt +
   `--refresh`），下载到 `vendor/cloudflared/<platform>-<arch>/cloudflared[.exe]`（`vendor/` 已 gitignore）。
3. `scripts/before-pack.cjs`：按 `electronPlatformName + Arch` 调 `prepare-cloudflared.cjs`（与 officecli 顺序执行）。
4. `package.json → build.extraResources`：三平台各加一条 `{"to": "cloudflared", "from": "vendor/cloudflared/<key>"}`。
5. `scripts/verify-packaged-app.cjs`：新增
   - `resources/cloudflared/cloudflared[.exe]` 存在且可执行
   - `--version` 输出与 pin 的 `EXPECTED_CLOUDFLARED_VERSION` 一致（从 pin 文件读，不硬编码）
   - （可选）Linux 上用打包程序的 Electron Node 无关，直接用二进制跑 `cloudflared --version` 即可
6. 运行时路径：仿 `src/main/platform/officecli.ts`，加 `src/main/platform/cloudflared.ts`
   （packaged → `process.resourcesPath/cloudflared/<binary>`，dev → `vendor/cloudflared/<key>/<binary>`），
   `existsSync` 缺失就抛错，绝不回退到系统 PATH 里的 `cloudflared`（版本不可控）。

体积：安装包 +38MB（Linux）/ +53MB（Windows）未压缩；NSIS/LZMA 压缩后大概 +15–20MB。
若在意体积，可退一步「首次启用时按需下载 + 校验 sha256」（`prepare-cloudflared.cjs` 已经是下载器），
代价是首次开启需要网络、以及企业网下 GitHub 可达性。

### 5.5 生命周期与安全

- 隧道与 server 同生命周期：server 停 → 隧道停；端口变化 → 重启隧道并重新取 URL（都走 `lifecycle` 队列）。
- 只暴露既有服务：不做额外端口、不改 `BIND_HOST`，「隧道 → 127.0.0.1:3352」单向。
- 公网可见面：`/healthz`、`/v1/pair/*`（配窗口闸门）、`/`（静态 Web 客户端）。建议：
  - **默认仍要求「允许新设备接入」**，不要把配对窗口做成常开；
  - 给 `/v1/pair/direct` 加一层按 `cf-connecting-ip` 的窗口外限流（现在只有「5 次输错作废」，换 IP 可绕过）；
  - 可选（P2）：Cloudflare Access（Zero Trust）套在 hostname 上，或 WAF rate limiting rule。
- token：不写 DB 明文、不进日志、不进崩溃报告；错误信息统一走 `GatewaySecrets` 式脱敏后再落盘/回传。
- quick tunnel 属于「无 SLA + CF 可调查」的试验通道，UI 文案必须写清，不要当默认长期方案。
- 不要复用/修改用户 `~/.cloudflared`：独立 config、独立 metrics 端口、独立 connector。

---

## 6. SSE 缓冲：已定性为 quick tunnel 专有

最初在 quick tunnel（`*.trycloudflare.com`）上测到：**响应体被整段缓冲**。

- 源站每 2s 一条、共 6 条的 `text/event-stream`：客户端在 ~12.8s 一次性收到全部；
- 纯文本 chunked 同样表现；
- 8KB/0.5s 的高频流：约 9.6s（≈150KB）开始成批到达，末尾再补一条；
- 同一台机器 loopback 直连（同一份代码）是逐条到达 → 排除服务端与客户端读取方式。

**2026-11-08 用 API 全托管创建的命名隧道复测，结论反转：**

| 场景 | 结果 |
| --- | --- |
| quick tunnel：SSE 2s × 6 | 整段缓冲，~12.8s 一次性到达 |
| 命名隧道（`config_src: cloudflare`，API 建）：SSE 2s × 6 | **逐条到达** 2.8s / 4.8s / 6.8s / 8.8s / 10.8s / 12.8s |
| 命名隧道：20s keepalive × 4（共 80s） | 20.8s / 40.8s / 60.8s / 80.8s，无断流 |

→ **实时通道必须走命名隧道**，quick 只能当「试用一次」。应用现有 20s `: ping` 在该间隔下安全。

对产品的影响：`/v1/events` 是手机端实时性的主干（`app/remote/src/api/RemoteEventStream.ts`），
它带 45s watchdog + 指数退避重连 + `resync_required` 重同步。在 quick 上会「一顿一顿」，在命名隧道上无此问题。

剩余动作（均不阻塞）：

1. **换网络复验**：另一条出口（手机热点 / 另一台机器），排除本机出口设备（本机有 FlClash/mihomo 与 `cf-warp-tag-id` 痕迹）。
2. **换版本复验**：pin 的候选版本（2026.10.7）与本机 2026.10.2 对比。

---

## 7. 分阶段实施计划

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| **P0** | `CloudflareTunnel.ts`（quick）+ 设置/IPC/`RemoteStatus.tunnel` + UI 三态 + `baseUrl` 自动回填 + 生命周期 | 2–3 天 |
| **P0.5** | §6 的 SSE 真机判定（named 隧道 / 换网络 / 换版本），结论落回本文档 | 0.5 天 |
| **P1** | named 模式：token 安全存储 + `--token-file` 启动 + hostname 展示 + 错误文案 | 1.5–2 天 |
| **P2** | 打包：pin 文件 + `prepare-cloudflared.cjs` + `extraResources` + `verify-packaged` 门禁 | 1.5 天 |
| **P2.5** | `safeStorage` 退化检测、配对端点限流、可选 Cloudflare Access 说明 | 1 天 |
| **P3** | （可选）CF API 全托管：建隧道 + ingress + DNS + 一键域名 | 2–3 天 |

测试计划（按仓库现有风格）：

- 单测（`scripts/cloudflare-tunnel-test.ts`）：日志解析（URL 行 / 错误行 / 多行 banner）、状态机迁移、
  backoff 序列、URL 变化事件、退出码处理；用假 cloudflared（Node 脚本打印固定 JSON 行）驱动，不联网。
- 集成：`test:remote-access` 加一条「tunnel running 时 `configure({enabled})` 不改写 manual baseUrl」的行为断言。
- 打包门禁：`verify:packaged` 增加 `cloudflared --version === pin`。
- 真机：Windows（`windowsHide` 无黑窗、Defender 不拦、52MB 二进制）与 Linux（libsecret 后端、无孤儿进程）各一轮；
  以及「系统已有 cloudflared 服务」的共存用例（POC 已验证 metrics 冲突点）。

---

## 8. 一句话总结

内置 Cloudflare Tunnel 在架构上是**低耦合增量**：新增一个进程监管器 + 一个设置项 + 一段 UI，
不改服务端监听与鉴权模型；成本主要在「二进制打包（+38–53MB）」和「Named Tunnel 的 token/域名流程」。
真正决定体验的是流式通道：先用命名隧道把 §6 的 SSE 缓冲问题测清楚，再决定 quick 是「体验入口」还是「日常方案」。

---

## 9. 固定域名（自用）专章

目标：每人每台机器一条专用隧道 + 固定 hostname，App 自己起停 connector；同时兼容「系统服务已跑」的现状。

### 9.1 这台机器现在的实际状态（`cloudflared tunnel list/info` 只读核对）

| 隧道 | 状态 | 备注 |
| --- | --- | --- |
| `mybuddy-omarchy` `f37c78f6…` | 1 个 linux connector，4 条边缘连接，v2026.10.2 | 系统级 systemd 服务，`~/.cloudflared/config.yml` → `omarchy.vivioninst.uk` → `127.0.0.1:3352` |
| `mybuddy-remote` `0bf3dc15…` | **1 个 windows connector 在线**，IPv6 出口，v2026.10.3 | 另一台 Windows 机器在跑，hostname 为 `remote.vivioninst.uk`（`GET /healthz` = 200） |

两个 hostname 都通：`https://omarchy.vivioninst.uk/healthz` 与 `https://remote.vivioninst.uk/healthz` 均 200。
也就是说「每台机器一条隧道 + 一个域名」的模式已经在用，产品化只需要把它搬进 App。

> 顺带一个**必须固化进实现**的坑：`cloudflared` 的 CLI 默认读 `~/.cloudflared/config.yml`，
> 里面写了 `tunnel:`，于是 `cloudflared tunnel info mybuddy-remote` 会打印成 `mybuddy-omarchy`；
> 加 `--config <app 自有>` 才正确。内置实现里所有 cloudflared 调用（含诊断命令）都必须显式 `--config`。

### 9.2 三条自用路线

| 路线 | 谁跑 connector | ingress 在哪 | 适合 | 代价 |
| --- | --- | --- | --- | --- |
| **A. 复用系统服务** | systemd / Windows 服务 | `~/.cloudflared/config.yml` | 已经装好、懒得动 | App 只能读；服务挂了 App 只能提示，不能自愈 |
| **B. App 托管专用隧道**（推荐） | App 子进程 | App 生成的 `~/.mybuddy/cloudflared/config.yml` | 要「点一下就好」 | 端口变化需重写 config + 重启（本地 ingress 的好处，见 9.3） |
| **C. 同一条隧道多 connector** | App + 系统服务都连同一隧道 | 两边 ingress 必须一致 | 高可用 | 两台机器/两个 ingress 不一致时**随机 502**，自用不建议 |

自用建议 **B**，并且「每台机器一条隧道」：`mybuddy-<machine>` → `remote-<machine>.<domain>`。
手机端本来就支持多服务器（`test:remote-multi-server`）。

### 9.3 token / credentials / ingress 的确切机制（已核对 cloudflared 源码，2026.10 系列）

- **token 就是 base64 的 JSON**：`connection.TunnelToken{ AccountTag:"a", TunnelSecret:"s", TunnelID:"t", Endpoint:"e" }`
  （`connection/connection.go`，标准 base64 + JSON）。
- **credentials 文件**是同一组数据的骆驼命名：`{ AccountTag, TunnelSecret, TunnelID, Endpoint }`
  （实测本机 `~/.cloudflared/<id>.json` 的 key 就是这四个）。
  → **一个 token 输入就能在本地还原出 credentials，不需要 cert.pem、不需要 `tunnel login`**。
- **本地 ingress 与 token 不冲突**：`cmd/cloudflared/tunnel/configuration.go` 里
  `ingress.ParseIngressFromConfigAndCLI(cfg, c, log)` 是**无条件**执行的，即使带了 `--token` 也读配置文件。
  所以 App 可以「token 只用于一次性的凭据还原，ingress 由 App 本地生成」，端口改了只改本地配置。
  （例外：**dashboard 托管（remote-managed）的隧道**由边缘下发配置，本地 ingress 会被覆盖；
  UI 上要能区分「本机配置」与「Cloudflare 托管」两种来源。）
- **token 不要走 argv**：`--token <value>` 会出现在 `ps` / `/proc/<pid>/cmdline`；用 `--token-file`（0600）
  或干脆按上面写成本地 credentials + config，运行时命令行里只有文件路径。

自用一条命令就能拿到 token（不需要 API Token / 仪表盘）：

```bash
cloudflared tunnel login                            # 一次性，浏览器授权
cloudflared tunnel create mybuddy-remote            # 一次性
cloudflared tunnel route dns mybuddy-remote remote.example.com
cloudflared tunnel token mybuddy-remote             # 输出 token → 粘进 App
```

### 9.4 App 侧落地：目录、文件、命令

```
~/.mybuddy/cloudflared/
  credentials.json    # 从 token 还原；0600
  config.yml          # App 生成：tunnel / credentials-file / ingress / no-autoupdate / metrics
  tunnel.log          # 按天 + 大小轮转，token 脱敏
```

`config.yml`（由 App 写，`<port>` 跟随 `remoteAccessPort`）：

```yaml
tunnel: <uuid>
credentials-file: /home/<user>/.mybuddy/cloudflared/credentials.json
protocol: http2            # 与现网一致；CN 网络下 QUIC 常被限速
no-autoupdate: true
metrics: 127.0.0.1:0
loglevel: info
ingress:
  - hostname: remote.example.com
    service: http://127.0.0.1:<port>
  - service: http_status:404
```

启动（命令行无任何 secret）：

```bash
cloudflared --output json --config ~/.mybuddy/cloudflared/config.yml \
            --grace-period 5s tunnel run
```

- `--no-autoupdate` 必须开：打包进来的二进制在 resources 里，自更新会改写自身、破坏安装签名。
- `--grace-period 5s`：退出时别拖住 App（默认 30s）。
- 就绪链：进程起来 → 日志出现 `Registered tunnel connection` → 本机 `GET /healthz` 200 →
  公网 `GET https://<hostname>/healthz` 200（带 `cf-ray` 头）→ 才 `running`。
- 端口变化：重写 `config.yml` → `SIGTERM` → 重启（都在 controller 的 `lifecycle` 队列里做）。
- App 退出/关窗：关窗驻留时隧道继续跑（agent 还在）；真正退出时 `SIGTERM` + 3s 兜底。

### 9.5 失败形态对照表（UI 文案直接照这个写）

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 边缘 `1033` | 隧道没注册上 connector（tunnel id 错 / 进程没连上） | 看日志 `Registered tunnel connection`；重连 |
| 边缘 `502` | connector 在线，源站 `127.0.0.1:<port>` 不通 | 先查本机 `/healthz`；端口是否被改 |
| 边缘 `522/530` | DNS 没指到隧道（灰云 / CNAME 错） | 提示 `CNAME <tunnel-id>.cfargotunnel.com`，必须橙云 |
| 本机 200、公网 403 | Origin 被拒（`originAllowed`） | 检查 `baseUrl` 是否与访问域名完全一致 |
| 进程反复退出 | 凭据无效 / 网络出不去 | 展示最后 20 行脱敏日志 + 重启计数 |

### 9.6 SSE 一次性判定（不动现网服务）

给 `RemoteAccessServer` 加一个**免鉴权诊断端点**（默认只在设置里开了「诊断」时暴露）：

```
GET /healthz?stream=1   → text/event-stream，每秒 1 条 tick，共 10 条，无任何业务数据
```

然后在本机直接对现网命名隧道测一次：

```bash
curl --noproxy '*' -N -H 'Accept-Encoding: identity' \
  'https://omarchy.vivioninst.uk/healthz?stream=1' | ts '%H:%M:%S'
```

- 每条 tick 的到达时间都差 ~1s → 命名隧道不缓冲，SSE 可用（quick 的问题只是 quick 的问题）。
- 10 条在同一秒到达 → 确认缓冲，按 §6 的降级方案走。

### 9.7 需要拍板的三个点

1. **输入方式**：只收 token（App 还原 credentials，最省事）/ 也接受 credentials 文件路径（不碰 token 语义）/ 两者都支持。
2. **是否自动探测系统隧道**：读 `~/.cloudflared/config.yml` 里的 `ingress[].hostname`，命中本机端口就提示
   「检测到 omarchy.vivioninst.uk，直接用它？」（只读、不写、不改服务）。
3. **是否做 Cloudflare API 全托管**（§5.4 P3）：自用可以不急；做的话需要 `Zone:DNS:Edit` 才能自动建 CNAME。


---

## 10. 全托管（API）实测：可行，且比手动建隧道更好用

> 2026-11-08 用本机 `~/.cloudflared/cert.pem` 里的 origin token 走了一遍完整链路，
> 建了临时隧道 + 临时 DNS（`cftest-xxxx.vivioninst.uk`），验证后**已全部清理**（DNS 记录、隧道、进程、临时文件均已删除，
> 账号内只剩 `mybuddy-omarchy` / `mybuddy-remote` 两条原有隧道）。

### 10.1 实测结果

| 步骤 | API | 结果 |
| --- | --- | --- |
| 校验凭据 | `GET /user/tokens/verify` | `active` |
| 建隧道（云端托管配置） | `POST /accounts/{acc}/cfd_tunnel` `{name, config_src:"cloudflare"}` | 返回 `id` + 240 字符 token |
| 配 ingress | `PUT /accounts/{acc}/cfd_tunnel/{id}/configurations` | 立即生效 |
| 建 DNS | `POST /zones/{zone}/dns_records` CNAME → `<id>.cfargotunnel.com`, `proxied:true` | 公网立刻可解析 |
| 起 connector | `cloudflared --config <自建> tunnel run --token-file <0600>` | 日志 `Registered tunnel connection` |
| 公网验证 | `GET https://cftest-…/healthz` | **200** |
| **运行中改 ingress** | `PUT …/configurations` 指向另一个端口 | **4 秒内生效，connector 不用重启** |
| 取回 token | `GET …/cfd_tunnel/{id}/token` | 与创建时同一 token（App 不必在创建时捕获） |
| 检测托管模式 | `GET …/cfd_tunnel/{id}` | 返回 `config_src: cloudflare`、`remote_config: true` |
| 清理 | `DELETE dns_record` + `DELETE cfd_tunnel?cascade=true` | 全部清除，`tunnel list` 只剩原来两条 |

同一轮里还确认了 §6 的关键结论：**API 建的命名隧道 SSE 逐条到达，quick tunnel 才缓冲**。

### 10.2 这意味着什么

1. **用户只需要粘一个 API Token**，隧道、ingress、CNAME 全部 App 建；比「跑 4 条 cloudflared 命令」省事得多。
2. **端口变化不需要动云端**——全托管模式下 ingress 在 Cloudflare，App 一次 `PUT` 就切换，connector 继续跑。
   （反过来：本地 config 模式要重写文件 + 重启。）
3. **App 能自检状态**：`config_src` 能区分「本机配置 / 云端托管」，`GET …/token` 能在重装后把凭据取回，
   `connections` 能看到每条隧道的 connector 与边缘节点。
4. **省掉的只是用户的 CLI 操作，不省二进制**：connector 仍然只能是 `cloudflared`，安装包还是要带 38MB（Linux）/ 53MB（Windows）。
   「全托管」的价值是**零命令行**，不是零依赖。

### 10.3 需要的凭据与权限

| 凭据 | 权限范围 | 用途 |
| --- | --- | --- |
| Cloudflare API Token | `Account → Cloudflare Tunnel → Edit` + `Zone → DNS → Edit` + `Zone → Zone → Read` | 建/删隧道、改 ingress、建 CNAME、hostname 反查 zone |
| 隧道 token（App 内部生成并加密保存） | 单条隧道 | 运行 connector；不经用户手 |

- 本次实测用的是 `cert.pem` 内的 origin token（天然带 Tunnel + DNS 权限）；**用户自建的最小权限 token 还没实测**，
  实现时必须用受限 token 再跑一遍（这是唯一未验证项）。
- API Token 权限面很大（能改 DNS），UI 必须写明「这是全账号级凭据」，存储走 `safeStorage`，只回显「已配置」。
- 建议支持「已有隧道接管」：`GET /cfd_tunnel` 列出账号内隧道，按 hostname/名称匹配直接绑定，避免每次安装都新建一条。

### 10.4 App 内部流程（全托管）

```
用户粘贴 API Token + 输入 hostname（如 remote-linux.vivioninst.uk）
  → GET /user/tokens/verify                       # 校验
  → GET /zones?name=<hostname 的 zone>            # 反查 zone（或让用户选）
  → GET /accounts/{acc}/cfd_tunnel                # 有同名隧道就复用
  → 无 → POST cfd_tunnel {name, config_src:"cloudflare"}
  → PUT  cfd_tunnel/{id}/configurations           # ingress: hostname → 127.0.0.1:<port>
  → POST zones/{zone}/dns_records (CNAME, proxied)
  → GET  cfd_tunnel/{id}/token → safeStorage 加密保存
  → spawn cloudflared --config <自建> --token-file <0600> tunnel run
  → 就绪链：Registered tunnel connection → 本机 /healthz → 公网 /healthz
  → baseUrl = https://<hostname>，写入 RemoteStatus（source=tunnel）
```

失败回滚：建到一半失败时，按「DNS → 隧道」的顺序删除本次创建的资源（只删本次创建的 id，绝不动已有隧道）。

### 10.5 全托管 vs 手动建隧道

| | 全托管（API） | 手动 4 条命令 + 粘 token |
| --- | --- | --- |
| 用户操作 | 粘 1 个 API Token | 粘 1 个隧道 token（但要先会跑 4 条命令） |
| 改端口 | 一次 API PUT，热生效 | 改本地 config + 重启 connector |
| 重装/换机 | 用同一 API Token 复用隧道 | 重新 `tunnel token` |
| 权限面 | 全账号（Tunnel + DNS） | 单隧道 |
| 失败定位 | API 返回结构化错误 | 看 CLI 输出 |

**建议**：默认走全托管；把「手动隧道 token」留作高级/离线选项（企业网拿不到 API Token 时）。

### 10.6 仍未解决的两件事

1. 最小权限 API Token 的实测（本机没有创建 token 的权限）。
2. `config_src` 在创建后是否可改（文档口径是创建时决定；实现里按「不可改」处理，不提供切换）。

---

## 11. 认证入口：`cloudflared tunnel login`（CLI 自带认证）与打包内置

### 11.1 CLI 的认证就是 login（不需要面板建 API Token）

`cloudflared tunnel login` → 浏览器授权（选一个 zone）→ 写 `~/.cloudflared/cert.pem`，
文件是 PEM(`ARGO TUNNEL TOKEN`) 包 JSON：`{ zoneID, accountID, apiToken, serviceKey }`。

**这个 `apiToken` 就是 §10 全托管实测用的那个**：能列/建/删隧道、读写该 zone 的 DNS、改 ingress 配置。
所以「全托管」并不要求用户去仪表盘手工建 API Token——登录一次就够。

### 11.2 但 login 有一个硬约束（源码 + 实测）

`cmd/cloudflared/tunnel/login.go → checkForExistingCert()` 检查的是
`config.DefaultConfigSearchDirectories()[0]`（即 `~/.cloudflared`），**与 `--origincert` 无关**：

```
$ cloudflared tunnel --origincert /tmp/appcert/cert.pem login
ERR You have an existing certificate at /home/<user>/.cloudflared/cert.pem which login would overwrite.
    If this is intentional, please move or delete that file then run this command again.
$ echo $?
0        # ← 失败也是退出码 0
```

结论：

1. App **不能**用「自己的 cert 路径」来隔离登录；登录天然绑定用户家目录那一份。
2. 只要 `~/.cloudflared/cert.pem` 存在，`login` 就拒跑（而且**退出码 0**，只能靠 stderr / 文件是否存在判断）。
3. 因此顺序必须是：**先读现成 cert → 没有再 login**；永远不删除/移动用户的 cert。

### 11.3 三段式认证设计

| 状态 | 行为 |
| --- | --- |
| `~/.cloudflared/cert.pem` 存在 | 直接读取（0600），拿 `apiToken/accountID/zoneID` 做全托管；零操作、零浏览器 |
| 不存在 | spawn `cloudflared tunnel login`（默认路径）：stderr 抓 `A browser window should have opened at the following URL:` / `Please open the following URL ...` → UI 展示 + 复制 + 二维码（手机授权也行）→ 等 cert 落盘 |
| 想用另一个 zone / 不想用家目录凭据 | 高级选项：粘贴 scoped API Token（`Tunnel:Edit` + `DNS:Edit` + `Zone:Read`） |

- cert 里的 token 是 **zone 级**（一个 cert 一个 zone）；多域名要么再登录一次（覆盖），要么走 API Token。
- login 会调系统浏览器打开；无头场景展示 URL 即可（cloudflared 自己轮询回调，浏览器只负责授权）。

### 11.4 打包内置（已定方案）

| 项 | 做法 |
| --- | --- |
| 二进制 | `vendor/cloudflared/<platform>-<arch>/cloudflared[.exe]`（gitignore），`extraResources` → `resources/cloudflared/` |
| 下载/校验 | `scripts/prepare-cloudflared.cjs` 仿 `prepare-officecli.cjs`：GitHub release + `assets[].digest`（sha256）+ receipt + `--refresh` |
| 版本 pin | `src/shared/cloudflared-builds.json`（version + asset + binary + sha256），`before-pack.cjs` 按平台准备 |
| 门禁 | `verify-packaged`：二进制存在 + `cloudflared --version === pin`（版本从 pin 文件读，不硬编码） |
| 许可 | Apache-2.0，无 NOTICE 文件 → `docs/third-party/cloudflared-LICENSE.txt`（`build.files` 已包含 `docs/third-party/**/*`） |
| 体积 | Windows 52.8MB / Linux 38.4MB（NSIS 压缩后约 +15–20MB） |
| 自更新 | 必须 `--no-autoupdate`（resources 目录不可变，自更新会改写二进制） |
| Windows 风险 | release 里的 `.exe` 未做 Authenticode 签名（只有 MSI 签名）→ 需在 Windows 真机验证 Defender/SmartScreen |
| 共存 | 内置优先；「使用系统 cloudflared」设为可选项，并要求最低版本 |
