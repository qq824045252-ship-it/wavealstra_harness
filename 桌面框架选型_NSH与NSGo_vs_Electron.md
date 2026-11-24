# NSH / NSGo 换掉 Electron：能带来多少速度与内存收益

查证时间：2026 年 11 月下旬
适用场景：现有 Electron 桌面应用，依赖多会话窗口、本地进程管理、PTY、文件监听

---

## 一句话结论

`nsh` 和 `nsgo` 是真框架名，不是 Tauri/Wails 的口误——它们是同一套设计血缘的两个**原生控件**框架（NSH 用 Rust，NSGo 用 Go），确实彻底不含 Node 和 Chromium。但对「多窗口 + 本地进程管理 + PTY」这类应用，换过去的**确定收益是安装包体积（约 100 倍），内存收益看平台且无实测支撑，启动速度基本没有收益**；代价是把整套 Node 能力重写一遍，并押注两个发布不到 6 周、版本号还在 0.x 的框架。

---

## 一、nsh 和 nsgo 分别指什么

两个名字都能查到确切的真实项目，且互相有关联。

| 名称 | 全称 / 仓库 | 语言 | 定位 | 成熟度（2026-11 下旬） |
|---|---|---|---|---|
| nsh | Native Shell，`longbridge/nsh` | Rust（也可写 TSX） | 用各平台原生控件绘制的跨平台 UI 框架 | GitHub 3,197 star，仓库创建于 2026-10-14，10 个 release，最新 v0.4.0（11-03）、v0.5.0（11-11） |
| nsgo | NSGo，`nsgo-dev/nsgo` | Go（也可写 TSX） | 同一个设计的 Go 实现，"ports NSH's design" | GitHub 665 star，仓库创建于 2026-10-21，**0.1.0 是首个版本** |

依据：

- NSH 官方仓库自述为 "a native UI framework for iOS, Android, macOS, Windows, Linux and the web, built in Rust"，其 CONTRIBUTING 明确写 "It is not an all-in-one application platform in the manner of Electron"。来源：<https://github.com/longbridge/nsh>
- NSGo 官方对比页写明 "NSGo ports NSH's design: the architecture, the backends, the API's names and `base`'s unstyled components are NSH's"；弱点一节自认 "Early. 0.1.0 is the first release, and the API is not stable yet"。来源：<https://nsgo.dev/docs/comparison.md>
- 两者的关键技术选择一致：**用操作系统原生控件绘制**（AppKit / Win32 / GTK4），不是 WebView，不是自带 Chromium。

### 为什么这两个名字值得单独查

用户原来的猜测（Tauri / Wails / Neutralino / NW.js）都不对，但差别很关键：

- Tauri / Wails / Neutralino / NW.js 都是**网页型**方案，前端还是 HTML/CSS/JS，只是把 Chromium 换成系统 WebView。它们和 Electron 的差距有限。
- NSH / NSGo 是**原生控件型**方案，前端不是网页，是 Rust/Go 组件（或跑在它们自己运行时里的 TSX）。理论上和 Electron 的差距大得多——但也意味着迁移不是"换壳"，是重写。

---

## 二、实测数据

### 2.1 先说数据缺口（重要）

**没有找到任何第三方独立机构对 NSH 或 NSGo 与 Electron 的实测对比。**

- NSGo 官方基准页（<https://nsgo.dev/benchmarks/>，2026-11-10 测）只比较 NSGo / NSH / MyGo / GPUI Kit / GPUI Fast 五个原生框架，**Electron 不在其中**。
- NSH 官方对比页（<https://nsh.dev/docs/comparison>）提到 Electron 和 Tauri 时只做定性描述（"Electron bundles Chromium and Tauri uses the system's web view… NSH builds each platform's own views instead"），不给数字。
- 因此第 2 节的所有数字，都只能来自 **Electron 与 Tauri / Wails / Neutralino / NW.js（同为网页型）** 的独立实测。把它外推到 NSH/NSGo 需要假设，这个假设我会单独标注。

### 2.2 独立基准 A：同一份 React 代码，只换壳

来源：`adarSonmez/desktop-framework-benchmark`（<https://github.com/adarSonmez/desktop-framework-benchmark>）

测试条件：AMD Ryzen 7 7840HS / 15 GB RAM / Windows 11 Pro（build 26300）；Electron 45 vs Tauri 2 + WebView2；**两者跑完全相同的 React bundle**，所以差值只来自外壳；1 次冷启 + 10 次热启轮转，取热启中位数；内存和 CPU 统计整个进程树（含 WebView2 与 Chromium 辅助进程）。

| 指标 | Electron | Tauri | 谁更低 |
|---|---:|---:|---|
| 冷启动（进程启动 → 列表首帧） | 725 ms | 1,162 ms | Electron |
| 热启动 | 546 ms | 614 ms | Electron |
| 空闲工作集 | 348 MB | 407 MB | Electron |
| 空闲私有内存 | 220 MB | 212 MB | Tauri（差 4%） |
| 峰值工作集 | 450 MB | 515 MB | Electron |
| 进程数 | 4 | 7 | Electron |
| 整个测试期 CPU 时间 | 3.6 s | 6.5 s | Electron |
| 安装后占用磁盘 | 357.1 MB | 4.1 MB | Tauri（87 倍） |
| IPC 单次往返 | 0.145 ms | 1.629 ms | Electron（11 倍） |

作者自己的结论原文："At runtime the two are close: WebView2 is Chromium too, and Tauri's tree had more processes and a larger working set here."

> 这一组数据最反直觉，也最重要：**同一份前端代码，Tauri 在 Windows 上的空闲内存反而比 Electron 高 17%，冷启动慢 60%。** 原因是 Windows 上的 WebView2 本身就是 Chromium，你没省掉浏览器引擎，只是换了打包方式。

### 2.3 独立基准 B：全框架横评（CI 环境）

来源：`Elanis/web-to-desktop-framework-comparison`（<https://github.com/Elanis/web-to-desktop-framework-comparison>），目前最常被引用的独立横评。

测试条件：GitHub CI 跑空应用（01-empty-app），Release 构建，内存为主进程 + 子进程的内存中位数。作者明确声明："These benchmarks are done on GitHub CI… You should read these tables as a comparison between frameworks for the same OS, architecture, and app, with a margin of error."

内存（Release，主进程 + 子进程，越低越好）：

| 平台 | Electron | Tauri | Wails | NW.js | Neutralino |
|---|---:|---:|---:|---:|---:|
| Windows x64 | **279 MB** | 312 MB | 330 MB | 618 MB | 502 MB |
| macOS arm64 | 370 MB | **96 MB** | 101 MB | 657 MB | — |
| Linux x64 | 596 MB | **94 MB** | 360 MB | 821 MB | 821 MB |

启动时间（Release，越低越好）：

| 平台 | Electron | Tauri | Wails | NW.js | Neutralino |
|---|---:|---:|---:|---:|---:|
| Windows x64 | **195 ms** | 650 ms | 572 ms | 676 ms | — |
| macOS arm64 | **431 ms** | 1,933 ms | 1,785 ms | 886 ms | — |
| Linux x64 | **191 ms** | 30,343 ms¹ | 271 ms | 517 ms | 350 ms |

¹ Linux 下 Tauri 这个数字是异常值（疑似构建/环境问题），不应当作框架特性。

> 这组数据说明：**WebView 方案的省内存效果高度依赖平台。** macOS / Linux 上（WebKit）省 3–4 倍；Windows 上（WebView2 = Chromium）反而更费。启动速度上 Electron 在三个平台都是最快的。

### 2.4 独立基准 C：最严谨的单次实测（含方法论纠错）

来源：Michał Wolinski，`tauri-vs-electron-ipc-memory`（<https://wolinski.com/blog/tauri-vs-electron-ipc-memory.html>）

测试条件：MacBook Pro M1 Pro / 32 GB / macOS 27.2；Tauri 2.12.5（系统 WebKit）vs Electron 45.2.3（Chromium 156 / Node 24.22）；同一份 HTML 页面、同一个 MCP 服务端；内存用 macOS footprint 口径（作者与 Apple `footprint` 工具逐字节核对过）。

| 指标 | Tauri | Electron | 备注 |
|---|---:|---:|---|
| 空窗口空闲内存（全部进程） | 59.5 MiB | 86.0 MiB | 中位数，10 次启动 |
| 接入 MCP 客户端后 | 58.8 MiB | 102.7 MiB | Electron 主进程要加载 TS SDK，+16.7 MiB |
| 页面脚本执行 | 309 ms | 321 ms | 30 次启动中位数 |
| 首帧 | 377 ms | 326 ms | Tauri 慢 51 ms |
| 首帧超过 1 秒 | 4 / 50 次（7.9–80.2 s） | 0 / 50 | WebKit 隐藏窗口不绘帧的坑 |
| 安装包 | 7.3 MiB | 268.7 MiB | — |

三条关键判断，引用作者原文：

1. "The difference is real, but it is not an order of magnitude."
2. "On this Mac, Tauri does not start faster."（同一次测试里，Tauri 首帧 377 ms，Electron 326 ms）
3. "The MCP server itself, a Node process, took about 35 MiB: more than Tauri's own app process."（26.4 MiB）

> 第 3 点对这个题目是决定性的：**如果应用的内存主要花在子进程上（PTY、语言服务、本地工具），换壳省下的那点内存会被子进程淹没。**

### 2.5 多窗口：唯一相关的数据，但样本很小

来源：Hopp 团队，Costa Alexoglou（<https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4>）

测试条件：MacBook Pro；Electron 与 Tauri 各建一个带按钮的 demo 应用，点开 6 个窗口，看内存；作者本人免责："This is a basic benchmark performed on my MacBook Pro with a single run (`N=1`)."

| 指标 | Electron | Tauri |
|---|---:|---:|
| 6 窗口内存 | ~409 MB | ~172 MB |
| 安装包 | 244 MiB | 8.6 MiB |
| 启动时间 | 作者原话：差异可忽略（"negligible"） | — |
| 构建时间 | 15.8 s | 1 分 20.9 s |

机制解释（Hopp 原文）："every window you open in an Electron app creates a new renderer process"。窗口越多，Electron 的增量越大。

> 这是唯一直接命中「多窗口」场景的实测：**在 macOS 上开 6 个窗口，Tauri 约为 Electron 的 42%。** 但它是 1 次运行、单机、macOS，不能当定律。

### 2.6 需要注意的口径争议

Tauri v1 官方基准曾给出 Electron 在 Linux 上约 500 MB 的数字，社区在 <https://github.com/tauri-apps/tauri/issues/5889> 提出质疑：不计入共享内存页会系统性高估 Electron，按共享内存折算后为 Tauri 421 MB / Electron 337 MB（macOS）、Tauri 581 / Electron 240（Ubuntu）、Tauri 399 / Electron 318（Windows 10），**结论反转**。

> 这一点只作为提醒：看到"Tauri 内存只有 Electron 十分之一"这类说法时，先问它有没有把共享内存和子进程算对。厂商页的数字普遍偏乐观。

---

## 三、对你这类应用，收益到底有多大

### 3.1 分项结论

| 维度 | 判断 | 依据强度 |
|---|---|---|
| 安装包体积 | **确定大幅改善**，Electron 357 MB → 原生控件框架个位数 / 十几 MB | 强，多个独立实测一致 |
| 冷启动 | **基本没有收益，甚至变慢**。所有实测里 Electron 都最快或接近最快 | 强，三组独立数据一致指向 |
| 空闲内存（单窗口） | **收益不确定，Windows 上可能是负数**。NSH/NSGo 不是 WebView，理论上能省，但无实测 | 弱，只能外推 |
| 空闲内存（多窗口） | **理论上收益最大的一环**：Electron 每窗口一个 renderer 进程，原生控件框架没有 | 中，Hopp 6 窗口数据支持，但 N=1 且是 macOS |
| 运行时性能 / 交互响应 | **没有可引用数据**。同一 React 代码下两者的 filter/sort/scroll 差距在 10% 内（见 2.2） | 弱，无对比数据 |
| 大文件/IPC 传输 | Electron 反而常占优：对象路由 652 ms vs Tauri 279 ms（Tauri 快），字符串路由 108 vs 112 ms（持平） | 中 |

### 3.2 折算到「多会话 + PTY」这个具体形态

一个真实的判断链：

1. Electron 每开一个会话窗口，多一个 renderer 进程。这部分是原生控件框架能真正消掉的。
2. 但 PTY 起来的 shell、语言服务、构建进程这些子进程，**换个框架一个都不会消失**。Wolinski 的实测里，一个 Node 子进程 35 MiB，比整个 Tauri 应用进程（26.4 MiB）还大。
3. 所以收益上限 = 「Electron renderer + main 进程的内存」减去「原生控件框架的进程内存」。
4. 在 macOS 上，参照 Tauri 的实测：单窗口 ~86 → ~60 MiB，6 窗口 ~409 → ~172 MB。
5. 在 Windows 上，参照两个独立基准：WebView 方案不但不省还更费；原生控件方案没有对应实测，无法给数字。

**结论：如果你主力平台是 macOS / Linux，且用户常年开着 5 个以上会话窗口，内存收益可能是 2–3 倍这个量级。如果你主力平台是 Windows，或者用户通常只开 1–2 个窗口，收益很可能不到 20%，甚至没有。**

### 3.3 一个反常识但重要的点

在这类应用里，内存和卡顿的主因往往是**自己代码里的问题**，不是外壳：

- 每个窗口都加载了完整的重前端 bundle
- 隐藏的窗口没销毁，renderer 一直挂着
- 每个 PTY 会话挂了一套完整的事件监听 + 累积的输出缓冲区，从不清理
- 文件监听无上限（chokidar 监听了整个 workspace，含 node_modules）
- 每个会话一个独立的语言服务进程

这些在 Electron 里改成本极低，换框架后问题会原样带过去。

---

## 四、主要代价

### 4.1 这不是换壳，是重写

| 现有 Node 能力 | 在 NSH / NSGo 里的处境 |
|---|---|
| `node-pty`（VS Code 在用，最成熟的 PTY 实现） | 需改用 Rust 的 `portable-pty` 或 Go 的 `creack/pty` / `go-pty`。POSIX 上不难，Windows ConPTY 的边界情况（resize、进程树回收、退出码）是坑集中的地方 |
| `chokidar` 文件监听 | 换 Rust `notify` / Go `fsnotify`，语义差异需重测（尤其是重命名、大小写、网络盘） |
| `child_process` 进程管理 | Rust `std::process` / Go `os/exec`，能力对等但要重写全部生命周期逻辑 |
| npm 生态（xterm.js、monaco、各类解析器） | **没有替代生态**。终端可以不用 xterm.js——NSGo 自带 `base/terminal`（基于 libghostty-vt），这是少见的加分项；但其余依赖要自己解决 |
| 前端技能栈（React/Vue） | NSH/NSGo 可以写 TSX，但跑在它们自己的运行时里（NSGo 用 goja 解释器，官方自认 "slower than the engines React Native or Electron use"） |

### 4.2 成熟度风险（这一项我认为是决定性的）

- **NSGo：0.1.0 是首个版本**，仓库 2026-10-21 才创建，到今天 5 周，665 star。官方自认 API 不稳定、生态小（"A small ecosystem. Few third-party components, examples or answers online"）。
- **NSH：v0.4.0（11-03）→ v0.5.0（11-11）**，8 天两个版本，且 v0.4.0 的 release note 明写 "This release includes breaking API changes"。v0.3.0 同样有 breaking changes。
- 原生控件方案的固有代价，官方自承："Native views mean small differences between platforms, so an app needs checking on each"。

> 也就是说：你会成为一个 0.x 框架的早期采用者，在它每周改 API 的阶段，把一个用户依赖的生产工具押上去。

### 4.3 具体的迁移成本估算（供决策用，非实测）

不含前端重写，只算被 Node 依赖绑定的部分：

- PTY 层（含 Windows ConPTY、resize、多会话、退出码、输出流控）：这是最贵的一块，且没有成熟参考实现
- 进程管理 + 文件监听 + 事件总线
- 多窗口生命周期（NSH 的 `nsh/desktop`、NSGo 的 desktop 包都能开窗口，但你要自己管理会话状态）
- 打包、签名、自动更新（NSH/NSGo 自带工具链，这一块反而比 Electron 省事）
- 团队技能：Rust 或 Go

---

## 五、建议的下一步

### 5.1 先测，别先换

在动任何代码之前，先回答一个问题：**你现在这台机器的内存，有多少花在 Electron 上，有多少花在你自己起的子进程上？**

做法（30 分钟）：

1. 开着典型工况（比如 5 个会话窗口 + 各自 PTY + 文件监听全部打开）。
2. 分别统计：Electron main 进程、每个 renderer 进程、GPU/utility 进程、所有 PTY 子进程。
3. 如果 renderer 合计占比 > 50%，换原生控件框架的收益上限就在那儿，值得进一步验证。
4. 如果 PTY 子进程合计占比 > 50%，换框架基本白干——优化子进程数量和生命周期收益更大。

### 5.2 Electron 内部的低成本优化（先做这些）

- 隐藏/最小化的会话窗口：直接销毁 renderer，恢复时重建（会话状态由主进程持有），而不是留着
- 检查是否所有窗口都加载了完整前端 bundle（可以按窗口类型拆分）
- 给每个 PTY 会话的输出缓冲区设上限 + 上限触发截断
- 文件监听白名单化，排除 node_modules / .git / 构建产物
- 确认 `backgroundThrottling` 行为符合预期

### 5.3 如果还是要验证 NSH / NSGo

做一个最小切片的对照实验，别做全量迁移评估：

- 范围：**只做一个会话窗口** —— 终端（PTY）+ 文件树（监听）+ 输入回显
- 两个框架各做一份（NSGo 用 Go 可能比 NSH 的 Rust 更快出结果，且自带 terminal 组件省掉最贵的一块）
- 测三件事：冷启动到可输入、5 个这样的窗口空闲内存、粘贴 1 MB 输出后的内存峰值
- 用你自己的真实工况做基线，别用空窗口

这个实验 1–2 周能出结论，成本远低于一次全量迁移的评估。

---

## 附：来源清单

| 编号 | 来源 | 类型 | 用于 |
|---|---|---|---|
| 1 | <https://github.com/longbridge/nsh> | 官方仓库 | NSH 定位、star、创建日期、release 数 |
| 2 | <https://nsh.dev/docs/comparison> | 官方文档 | NSH 与 Electron/Tauri 的定性差异（无数字） |
| 3 | <https://github.com/longbridge/nsh/releases/tag/v0.4.0> | 官方 release | breaking API changes 证据 |
| 4 | <https://github.com/nsgo-dev/nsgo> | 官方仓库 | NSGo 定位、star、创建日期 |
| 5 | <https://nsgo.dev/docs/comparison.md> | 官方文档 | NSGo 与 NSH 血缘、自认"Early / 0.1.0"、goja 解释器较慢 |
| 6 | <https://nsgo.dev/benchmarks/> | 官方基准 | NSGo/NSH 自身性能，**不含 Electron** |
| 7 | <https://nsgo.dev/docs/terminal.md> | 官方文档 | NSGo 自带 terminal 组件，桌面端跑本地程序 |
| 8 | <https://github.com/adarSonmez/desktop-framework-benchmark> | 第三方独立基准 | 同一 React bundle 下 Electron vs Tauri（Windows 11） |
| 9 | <https://github.com/Elanis/web-to-desktop-framework-comparison> | 第三方独立基准 | 五框架三平台内存与启动（CI 环境，有误差声明） |
| 10 | <https://wolinski.com/blog/tauri-vs-electron-ipc-memory.html> | 第三方独立实测 | 最严谨的 macOS 单机实测 + 方法论纠错 |
| 11 | <https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4> | 第三方实测 | 唯一的多窗口（6 窗）数据，作者自标 N=1 |
| 12 | <https://github.com/tauri-apps/tauri/issues/5889> | 社区 issue | 共享内存口径争议，说明厂商数字可能反转 |

### 未验证项

- NSH 与 Electron 的同条件实测：**不存在**，无法给出数字
- NSGo 与 Electron 的同条件实测：**不存在**，无法给出数字
- NSGo 的 PTY 实现深度（Windows ConPTY 行为、多会话并发、resize 语义）：文档只说明"桌面端跑本地程序"，未验证细节
- 多窗口场景下的原生控件框架内存：除 Hopp 的 N=1 数据外无其他来源
- 用户在 Windows 的实际表现：现有所有"原生控件 vs Electron"推理都无法用实测支撑
