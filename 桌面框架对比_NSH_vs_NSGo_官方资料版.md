# NSH 与 NSGo 横向对比（仅依据官网与官方文档）

编制日期：2026-11-24
数据来源限定：`nsh.dev`、`nsgo.dev`，以及两个项目的官方仓库（GitHub `longbridge/nsh`、`nsgo-dev/nsgo`）。
本文不使用第三方博客、论坛讨论或其他框架的数据。官网未写明的，正文中逐条标为「官网未写明」。

---

## 一句话结论

NSGo 官方自述是 NSH 的 Go 移植，两者共用同一套架构、API 命名和布局算法。差别集中在四点：**语言（Rust vs Go）、TSX 运行时（QuickJS vs goja）、包体积（NSGo 明显更小）、成熟度（NSH 快一个身位）**。性能上两边在消费级场景已经非常接近，NSH 在 CPU 占用和内存上占优，NSGo 在启动和体积上占优；但 NSGo 自己的路线图承认 Linux 与 Windows 上的表格滚动仍落后 NSH。

---

## 一、两者的关系

这一点必须先讲清楚，因为后面对比的所有维度都源于此。

NSGo 官方文档明确写道：「NSGo ports the design of Native Shell (NSH) to Go. The architecture, the names and the behavior apps see are NSH's; the language, the toolchain and a few platform mechanisms are Go's.」
（`nsgo-dev/nsgo` 仓库 `docs/architecture/nsh.md`）

NSGo 在公开对比页里给出的选型建议也是这个口径：「Choose NSGo to write apps in Go rather than Rust or TSX… **Choose NSH for a more mature project, TSX run by QuickJS with bytecode and heap limits, the GPUI backend, or 32-bit Android.**」
（<https://nsgo.dev/docs/comparison.md>）

也就是说，「哪个更成熟」这个问题，NSGo 官方文档自己给出了答案。

---

## 二、架构与渲染方式

### 2.1 两家共同的架构（NSGo 照搬 NSH 的部分）

| 环节 | 官方描述 | 出处 |
|---|---|---|
| 引擎 | 每个界面一个引擎，独占反应式图（signals）、影子树、样式、布局、文本准备 | `docs/architecture/nsh.md` |
| 提交模型 | 一次变更 = 一次 commit = 一批 mount items 交给主线程，只含变化的项 | `docs/architecture/nsh.md`；nsgo.dev 首页 |
| 布局 | Taffy（flexbox + CSS grid）；NSGo 是 Taffy 0.15 算法的 Go 移植，用 Taffy 自己的 fixtures 校验 | nsh.dev `docs/architecture.md`；`docs/architecture/nsh.md` |
| 反应式 | Solid 1.9 算法的原生实现；组件只运行一次，之后只更新读该 signal 的绑定 | nsh.dev `docs/performance.md` |
| 动画 | 跑在平台帧时钟上，不逐帧回调 JS | nsh.dev `docs/performance.md` |
| 绘制主体 | 各平台自己的视图 | 两家文档一致 |

### 2.2 逐平台实现（两家官方表格对照）

| 平台 | NSH 官方描述 | NSGo 官方描述 |
|---|---|---|
| iOS | UIKit 视图；CoreText；系统文本框与 TextView | UIKit 与 CoreText |
| Android | Android views；`StaticLayout`；`EditText` | Android Views |
| macOS | AppKit + Core Animation；CoreText；`NSTextField`/`NSTextView` | AppKit 与 CoreText |
| Windows | **Win32 窗口，用 Direct2D 绘制**；DirectWrite；**文本框是 NSH 自己的编辑器 + 系统输入法（IMM32）** | **Direct2D 与 DirectWrite** |
| Linux | GTK 4；Pango；GTK `Text`/`TextView` | GTK 4、Pango 与 Cairo |
| Web | HTML 元素 + CSS；浏览器字体；浏览器输入框 | WebAssembly 与 DOM 元素 |

出处：nsh.dev `docs.md`「What native means」表；nsgo.dev `docs/index.md`「How it works」表。

**需要点明的一处**：两家官网对 Windows 的措辞不同——NSH 写「Win32 窗口，用 Direct2D 绘制」，NSGo 直接写「Direct2D」。但按 NSH 自己的说明，Windows 上连文本输入都是框架自带的编辑器（不是系统原生文本框），NSH 在「Goals」页也重申「including NSH's own editor on Windows」。所以**在 Windows 上两家都不是系统原生控件，都是自己画**；macOS / iOS / Linux 才是真正挂平台视图。这一点两家都没回避，但只有 NSH 写得更细。

### 2.3 线程模型

NSH 有独立架构页，描述了每个 app 两条线程：**引擎线程**（你的代码、反应式图、渲染器、commit）和**主线程**（只做必须主线程做的事：绘制已排好版的文字、原生动画、手势与滚动），并声明「The main thread never waits for JS.」
（nsh.dev `docs/architecture.md`）

NSGo 官网**没有对应的架构页**——`https://nsgo.dev/docs/architecture.md` 返回 "Page not found"，官网文档目录里也没有「架构」条目。NSGo 对线程模型只有首页一句「each update crosses to the main thread once, as one batch of only what changed」，深度说明放在仓库 `docs/architecture/` 下。**官网未写明 NSGo 的线程细节**，只能引用其仓库文档。

---

## 三、平台覆盖与各平台成熟度

### 3.1 平台清单

| 平台 | NSH | NSGo |
|---|---|---|
| iOS | ✅ iOS 15.0+，真机与模拟器 | ✅（含 App Clips） |
| tvOS / watchOS | ❌ 无 | ✅ |
| Android | ✅ Android 8（API 26）+；`arm64-v8a`、`armeabi-v7a`、`x86_64` | ✅（**不含 32 位 `armeabi-v7a`**） |
| macOS | ✅ macOS 14+ | ✅ |
| Windows | ✅ Windows 10 1809+ / 11 | ✅ |
| Linux | ✅ GTK 4.14+ | ✅ GTK 4.14+ |
| HarmonyOS | ❌ 无 | ⚠️ **Preview** |
| Web | ✅ 现代浏览器，可发布为静态站点 | ✅ |
| 终端（TUI） | ✅ ratatui 后端 | ❌ 无 |
| GPUI 嵌入 | ✅ 独立后端 | ❌ 明确不移植 |
| 小程序 | 社区仓库（`--target miniprogram`） | ⚠️ **实验性**，微信/QQ/支付宝/抖音 |
| Mac Catalyst | ✅ 仅用于开发预览，固定 390×844 | 未提及 |

出处：nsh.dev `docs/platforms.md`「At a glance」表；nsgo.dev 首页平台列表；`docs/architecture/nsh.md`「What NSGo leaves out」。

### 3.2 官方自己标注的成熟度差异

- **NSGo 首页标题即标「Early preview」**；HarmonyOS 标「Preview: ArkUI draws a first set of views, and you sign the package yourself」；四个小程序平台标「Experimental: mini programs hold an app to 2 MB, which larger apps exceed for now」。（nsgo.dev 首页）
- **NSH 无任何平台标 preview/experimental**，但其平台表把 Mac Catalyst 注为开发用途，并把 Windows 文本输入标注为自研编辑器。
- **构建机要求不同**：NSH 是「package a Mac app on a Mac, a Windows app on Windows and a Linux app on Linux」，每个桌面目标在各自系统上打包（`docs/platforms.md`「Develop and package」）；NSGo 是「Every target builds from a Mac with Go and Xcode」，一台 Mac 交叉编译全部目标（`docs/index.md` 与 `docs/comparison.md`「Every platform from one Mac」）。
- **Android 实现机制不同**：NSH 是 `libnsh.so` 在同进程里走 JNI；NSGo 是「A Go executable the Java runtime starts, over pipes」，因为「Go builds Android shared libraries only with cgo and the NDK」，而 NSGo 全平台不用 cgo。（`docs/architecture/nsh.md`「Platforms and embedding」）

---

## 四、语言与其带来的约束

### 4.1 语言清单

| | NSH | NSGo |
|---|---|---|
| 核心 | Rust | Go |
| 写应用 | Rust（首选），TSX（第二路径），或两者混用 | Go（首选），TSX（在 Go 之上），或混用 |
| TSX 运行时 | **QuickJS**（C 库），每个视图一个 VM | **goja**（纯 Go 实现），只跑 TSX 应用 |
| Go/Rust 应用是否带 JS 引擎 | Rust 应用不带：「QuickJS is not part of a Rust app on any platform」 | Go 应用不带：「Go apps are native code compiled with the engine」 |
| 原生依赖 | 有 C 依赖（QuickJS） | **全平台无 C、无 cgo** |

出处：nsh.dev `docs.md`「How it runs」与「The difference」表；nsgo.dev `docs/index.md`「What you write」；`docs/architecture/nsh.md`「Language and runtime」表。

### 4.2 语言带来的具体约束（均为官方原话）

**NSH（Rust / 或 QuickJS 上的 TSX）**

- 「QuickJS is an interpreter: small, quick to start, and much slower than native code for heavy work.」（`docs/performance.md`）
- 官方给 TSX 开发者的建议：「keep event handlers and computed values light. Heavy computation (parsing large payloads, sorting thousands of items on every keystroke) costs more in QuickJS than you may be used to in V8 or JavaScriptCore with a JIT.」（同上）
- 反过来，重计算放 Rust 是官方推荐路径：经 Rust 模块排序 100,000 行「takes about 3 ms… as in plain Rust」（`docs.md`「Retained views」）。
- TSX 交付物会被编译成字节码（`bundle.nshc`），且运行时对动态下发的 TSX 有**堆上限与沙箱**（`docs/architecture.md`、`docs.md`）。

**NSGo（Go / 或 goja 上的 TSX）**

- 官方明列一条能力缺失：「**QuickJS's bytecode and heap limit: goja has neither**」。（`docs/architecture/nsh.md`「What NSGo leaves out」）
- NSGo 对比页对 TSX 的评价：「TSX is interpreted. TSX runs in goja, a JavaScript interpreter written in Go, slower than the engines React Native or Electron use.」（<https://nsgo.dev/docs/comparison.md>）
- Go 的语言特性直接决定了 API 形状，官方列了表，其中几条对写代码手感影响最大：
  - 用结构体字面量，不用 builder / `#[component]` / 派生宏（「Go's idiom for many optional fields; no macros」）
  - 用指针 + GC，不用代际 arena（「Go frees what nothing references」）
  - 用 goroutine，不用引擎线程上的 future executor
  - **零值必须是默认值**，所以布尔选项用否定式命名，例如 `NoCloseOnEscape`（「Options that default to true (`closeOnEscape`) → Negative names (`NoCloseOnEscape`)」）
  - 样式用构造函数（`LinearGradient`、`Blur`），不用 CSS 字符串
  - 出处：`docs/architecture/nsh.md`「Go's API shape」表
- 工具链假设不同：NSGo 只假定有 Go 和 Xcode（「Only Go and Xcode are assumed」），`nsh check` 需要从 npm 下载 tsc，NSGo 用 `go run` 跑 TypeScript 7 的检查器（「No Node or npm」）。出处同上「Toolchain」表。

---

## 五、官方性能数据

### 5.1 NSGo 官方基准页：两家同机同 App 的直接对比

页面：<https://nsgo.dev/benchmarks/>（2026-11-10 测）

**测试条件（官网原文）**：
- 三个小应用（Counter / Streaming quotes / Scrolling list），每个框架按各自惯用方式各写一份，release 构建，轮流跑
- 三台机器：**Apple M1 Max，34.36 GB**（macOS）；**Intel Core Ultra 9 285K，67.94 GB**（Windows）；**AMD Ryzen 9 6900HX，31.25 GB**（Linux）
- 每组「3 次运行、每次 10 s 的中位数」
- 内存口径逐平台不同：「the physical footprint on macOS, the proportional set size on Linux, the working set on Windows」
- CPU 为「percent of one core」，并额外计入合成器
- release 构建参数：「`go build -ldflags "-s -w"`，and `cargo build --release` with symbols stripped」
- 版本：NSGo 03896f1、NSH 0.4.0

**Counter（一个计数器和两个按钮，放着不动）**

| 指标 | 平台 | NSH | NSGo | 差值 |
|---|---|---:|---:|---|
| 启动（启动到首帧） | macOS | 324 ms | **285 ms** | NSGo 快 39 ms |
| | Windows | 161 ms | 161 ms | 持平 |
| | Linux | 90 ms | **81 ms** | NSGo 快 9 ms |
| 内存 | macOS（footprint） | **21.3 MB** | 24.9 MB | NSH 少 3.6 MB |
| | Windows（working set） | 60.3 MB | **59.2 MB** | NSGo 少 1.1 MB |
| | Linux（PSS） | 50.0 MB | **47.6 MB** | NSGo 少 2.4 MB |
| 二进制体积 | macOS | 33.0 MB | **7.9 MB** | NSGo 小 4.2 倍 |
| | Windows | 45.4 MB | **8.4 MB** | NSGo 小 5.4 倍 |
| | Linux | 40.1 MB | **7.9 MB** | NSGo 小 5.1 倍 |

**Streaming quotes（40 行报价表，其中 10 行每帧变化，每行四段文字）**

| 指标 | 平台 | NSH | NSGo |
|---|---|---:|---:|
| CPU（低于为好） | macOS | **66.2%** | 75.8% |
| | Windows | **157.8%** | 175.6% |
| | Linux | **19.4%** | 24.0% |
| 内存 | macOS | **36.7 MB** | 47.9 MB |
| | Windows | **68.3 MB** | 76.2 MB |
| | Linux | **55.5 MB** | 61.1 MB |
| 帧率 | 三平台 | 达到刷新率（120 / 260 / 60） | 同 |

**Scrolling list（10,000 行，每帧滚动一行）**

| 指标 | 平台 | NSH | NSGo |
|---|---|---:|---:|
| CPU | macOS | **47.4%** | 52.3% |
| | Windows | **148.7%** | 154.9% |
| | Linux | **11.0%** | 13.4% |
| 内存 | macOS | **31.3 MB** | 42.0 MB |
| | Windows | **64.9 MB** | 71.5 MB |
| | Linux | **52.1 MB** | 56.0 MB |
| 帧率 | 三平台 | 达到刷新率 | 同 |

**读这张表要注意三件事：**

1. 这是 **NSGo 自己发布的页面**，却有多行显示 NSH 更省 CPU / 内存。如果存在系统性偏向，方向应该相反，这一点让数据相对可信。
2. 帧率两家都顶到刷新率，**日常动画与滚动场景两家都够用**，差别在同样的帧花了多少 CPU 和内存。
3. 内存口径三平台不同，**只能横向比同一行的 NSH 与 NSGo，不能跨平台比**。

### 5.2 NSGo 官方路线图：承认仍落后于 NSH 的部分

`nsgo-dev/nsgo` 仓库 `docs/roadmap.md` 里，NSGo 用 NSH 的同一批 gallery 场景在自己机器上量了两家，并把这些当作尚未达标的条目：

| 场景 | 平台 | NSGo 实测 | NSH 实测 | 说明 |
|---|---|---:|---:|---|
| DataTable 滚动 | Linux（GTK） | 5.5 ms/帧，51% 单核 | 1.6 ms/帧，22–23% | 2026-11-12，对 NSH 0.5.0 |
| DataTable 滚动 | Windows | 41–44% 单核 | 30–32% | 2026-11-09，对 NSH 0.4.0 |
| 堆叠视图滑动 | Windows | 28–29% 单核 | 20–22% | 同上 |
| DataTable 滚动 | Android 模拟器 | 118–126% | 110% | 2026-11-12，对 NSH 0.5.0 |
| 动画层 | macOS | 6–15% 单核，0.3–0.8 ms/帧 | 10–14%，0.6 ms | 2026-11-12，大体持平 |

同一页还有一句结论：「Headless, in headless Chrome, on macOS for the DataTable and the stack, and in the iOS simulator, NSGo costs what NSH does or less.」

也就是说：**macOS 与无头环境两家打平，Linux（GTK）和 Windows 上 NSGo 目前更费 CPU，这是 NSGo 自己写进路线图的待办。**

### 5.3 NSH 官方性能报告：自家绝对基线（无 NSGo 数据）

页面：<https://nsh.dev/docs/performance-report.md>

**基线（Apple silicon，release）**

| 场景 | 数值 |
|---|---|
| Counter 无头（debug） | 首帧 ~0.5–0.65 ms；一次点击 ~0.15 ms |
| Counter Mac Catalyst（release） | 首帧 ~1.05–1.15 ms；一次点击 ~0.12 ms |
| 引擎启动（release） | ~75–155 µs |
| 热重载 | 存盘到新版本运行 ~120 ms |

**各平台静置内存（release）**

| 平台与口径 | Rust 应用 | TSX 应用 | 裸平台窗口参照 |
|---|---|---|---|
| macOS（footprint） | ~19 MB | ~20 MB | 裸 AppKit 窗口 ~17 MB |
| Windows（私有工作集） | ~14 MB | ~15 MB | — （工作集 ~53–71 MB） |
| Linux（private dirty） | 41.6 MiB | 45.4 MiB | 裸 GTK 窗口 36.7 MiB |
| Linux（PSS） | 69.2 MiB | 78.6 MiB | 裸 GTK 窗口 48.8 MiB |

**测试条件**：
- macOS：MacBook Pro（Apple M3，24 GB），内置 120 Hz ProMotion，1200×800 窗口
- Windows：Windows 11，Intel i7-13700KF，32 GB，RTX 3060 Ti，4K 144 Hz 屏 150% 缩放，1200×800 窗口
- Linux：x86_64 24 线程 + NVIDIA GPU，1896×1030 / 120 Hz（内存单测在 i7-13700KF + RTX 3060 Ti + GTK 4.24.1 + Wayland 1.6× 上，480×640 窗口，启动后 8 s 采样）

**帧成本（gallery 逐页）**：Linux 144 Hz 下 p95 帧时间 0.5–4.2 ms、CPU 1–26%；macOS 120 Hz 下 p95 0.2–3.5 ms、CPU 3–36%；Windows 4K144 下 p95 0.1–4.8 ms、CPU 1–43%；iOS 真机 120 Hz 下 p95 0.1–0.3 ms。

### 5.4 两组数据的关系

- **5.1 可以直接横向比**（同一台机器、同一个应用、同一时点）。
- **5.3 只能作为 NSH 的绝对基线**，因为 NSH 报告里没有 NSGo；把它和 5.1 的 NSGo 数字比会是不同应用、不同机器。
- **可以互相校验**：NSH 自报 Windows 工作集 ~53–71 MB，NSGo 基准页测到 NSH 为 60.3 MB；NSH 自报 macOS footprint ~19 MB，NSGo 测到 21.3 MB。两组独立测量落在同一区间，说明两家的数字都还可信。

### 5.5 官网未写明的性能项

- **NSGo 没有公布微基准**（单次点击、启动到首帧的引擎开销、热重载耗时），只有应用级整包数据。
- **NSH 没有公布与 NSGo 的直接对比**。
- **两家都没有公布多窗口场景的内存或帧成本数据**。
- **两家都没有公布长时间运行的子进程（如 PTY 会话）对内存的影响**。

---

## 六、版本历史、API 稳定性、Star 与发布节奏

数据取自两个官方仓库的 release 与仓库元信息（2026-11-24）。

| 项目 | 仓库创建 | Star | 首个版本 | 当前版本 | 稳定版数量 | 节奏 |
|---|---|---:|---|---|---:|---|
| NSH | 2026-10-14 | 3,337 | v0.1.0（2026-10-17） | v0.6.1（2026-11-20）+ 每日 nightly | 9 个（34 天内） | 约 4 天一个版本 |
| NSGo | 2026-10-21 | 743 | v0.1.0（2026-11-16） | v0.3.0（2026-11-23） | 3 个（7 天内） | 约 3–4 天一个版本 |

**NSH 版本序列**：v0.1.0（10-17）→ v0.1.1（10-18）→ v0.2.0（10-22）→ v0.3.0（10-26）→ v0.4.0（11-04）→ v0.5.0（11-11）→ v0.5.1（11-14）→ v0.6.0（11-18）→ v0.6.1（11-20）

**NSGo 版本序列**：v0.1.0（11-16）→ v0.2.0（11-19）→ v0.3.0（11-23）

### API 稳定性

- **NSH**：8 个 0.1 之后的版本里，**5 个的 release note 明确提到 breaking changes 或迁移说明**（v0.2.0、v0.3.0、v0.4.0、v0.5.0、v0.6.0）。v0.4.0 原文：「Upgrading from 0.3.x? This release includes breaking API changes.」v0.3.0 同样是「Upgrading from 0.2.x? This release includes breaking API changes.」
- **NSGo**：官网「Status」一节原文：「NSGo is early: **0.1.0 is its first release, its API is not stable yet**, and what is missing is in the roadmap.」（`docs/index.md`）
- 两家都还是 0.x，**都还没有到 API 稳定的阶段**；NSH 的快照更接近可用，代价是它也在频繁改 API。

### 与 NSH 的版本对齐

NSGo 的路线图明确以 NSH `v0.5.0`（2026-11-11）为参照系，「lists what NSGo may still take from NSH's 0.5.0 release」。NSGo 也已公告「NSGo has grown from NSH and now goes its own way (decided by the user, 2026-11-08)」，此后不再跑 NSH 的测试用例。也就是说 **NSGo 不再是简单的跟随移植，两边会持续分叉**。

---

## 七、包体积

### 7.1 NSH 官方数据（`nsh.dev/docs/performance-report.md`「App size」）

Hello world 由 `nsh init` 生成，release 构建，LTO + strip：

| 目标 | 模板 | 可执行文件 | 打包产物 |
|---|---|---:|---:|
| Linux x86_64 | Rust | 21.5 MB | 9.7 MB（`.tar.gz`） |
| Linux x86_64 | TSX（含 QuickJS） | 25.7 MB | 11.6 MB |
| macOS arm64 | Rust | 12.4 MB | 6.0 MB（zip） |
| macOS arm64 | TSX | 19.8 MB | 9.5 MB |
| Windows x86_64 | Rust | 25.3 MB | 10.7 MB（zip） |
| Windows x86_64 | TSX | 28.6 MB | 12.4 MB |

### 7.2 NSGo 官方数据（`nsgo.dev/benchmarks/`「Binary size」）

Counter 应用（一个计数器和两个按钮），release 构建：

| 平台 | NSH | NSGo |
|---|---:|---:|
| macOS | 33.0 MB | 7.9 MB |
| Windows | 45.4 MB | 8.4 MB |
| Linux | 40.1 MB | 7.9 MB |

### 7.3 注意

7.1 与 7.2 是**不同应用**（hello world vs counter）在不同机器上的结果，不能逐字节相减。但两个来源的结论方向一致：**NSGo 的二进制明显小于 NSH**，量级差异在 2–5 倍（NSGo 官方在对比页写的是「the same counter app packs to about 8 MB… smaller than MyGo's, GPUI's and NSH's (33 to 45 MB for NSH)」）。

TSX 应用比纯 Rust / 纯 Go 应用更大，因为要带上 JS 运行时（NSH 带 QuickJS，NSGo 带 goja）。

---

## 八、官方自述：适合什么、不适合什么

### 8.1 NSH

**适合**（`docs.md`「Retained views」原文）：
> 「That suits the screens most apps are made of — chats, mail, forms, lists, documents, settings, an AI reply streaming in — where a few views change at a time and the rest wait. Such screens sit near idle between updates, and scrolling and animation hold 120 FPS on ProMotion displays.」

**不适合**（`docs/comparison.md`「When another option fits better」原文）：
> - 「The screen is dominated by sustained, dense updates of thousands of views — a market-data terminal streaming tens of thousands of quotes a second…: GPUI Fast's retained GPU rendering uses a fraction of the CPU.」
> - 「The app must look pixel-identical on every platform… such as Flutter or Slint」
> - 「You need a large ecosystem of third-party packages today: React Native, Flutter and Qt have years of them.」
> - 「The UI is a document or an existing web page: a web view shows it as it is.」
> - 「The set of screens is fixed and small, and only content and order change: server-driven UI needs no runtime at all.」

**关于自身定位的一句关键表述**（官方 `CONTRIBUTING.md`「Scope」）：
> 「NSH is a lightweight, cross-platform GUI framework… **It is not an all-in-one application platform in the manner of Electron.** Small binaries, fast builds and fast start-up are part of its design, and every feature added to NSH costs all of them for every app, including the apps that never use it.」

这句话对「想用 NSH 重写一个依赖大量系统能力的桌面应用」是重要提示：NSH 官方刻意把范围收窄，不追求成为一个什么都能做的应用平台。

### 8.2 NSGo

**优势**（`docs/comparison.md`「Strengths」摘录）：
- 原生视图：文本、输入法、选择、滚动、无障碍、菜单都是平台自己的
- 细粒度更新：signal 只更新读它的地方，没有虚拟 DOM，也不逐帧 diff
- 「The smallest packages and the fastest start」——官方基准里 counter 在 macOS/Windows/Linux 上约 8 MB，比 MyGo、GPUI、NSH 都小
- 只用 Go：引擎、布局、后端全是 Go，「no C, no cgo and no JavaScript engine for Go apps」
- 「Every platform from one Mac」：只要有 Go 和 Xcode 就能交叉编译所有目标
- 自带 terminal 组件：「A terminal running programs with Ghostty's emulator」（`docs/architecture/nsh.md`「What NSGo adds」）

**劣势**（`docs/comparison.md`「Weaknesses」原文全列）：
- 「**Early.** 0.1.0 is the first release, and the API is not stable yet」
- 「**A small ecosystem.** Few third-party components, examples or answers online, next to Flutter, React Native or Qt.」
- 「**Platforms differ.** Native views mean small differences between platforms, so an app needs checking on each.」
- 「**Its own bridges.** On Android the Go program runs beside the Java runtime and talks to it over pipes, and on Linux users need GTK 4.14 or newer.」
- 「**TSX is interpreted.** TSX runs in goja, a JavaScript interpreter written in Go, slower than the engines React Native or Electron use.」

### 8.3 两家的官方选型建议（NSGo 对比页原话）

- 「**Choose NSGo** to write apps in Go rather than Rust or TSX, to build every target from a Mac with Go and Xcode, or for what NSGo adds: GPU shaders written in Go, vector icons, **a terminal**, apps opening their own windows, panels and tray icons, and styled components in `ui`.」
- 「**Choose NSH** for a more mature project, TSX run by QuickJS with bytecode and heap limits, the GPUI backend, or 32-bit Android.」

---

## 九、官网未写明的（不做推测，逐条列出）

1. **NSGo 官网没有架构页**：`https://nsgo.dev/docs/architecture.md` 返回 Page not found；官网文档目录无「架构」条目。线程模型、引擎细节只在仓库 `docs/architecture/` 里。
2. **NSH 官网没有与 NSGo 的对比数据**：`nsh.dev/docs/comparison.md` 的对比对象是 React Native、Flutter、Qt、GPUI、Slint、Electron/Tauri，不含 NSGo。
3. **两家官网都没有多窗口场景的性能数据**：窗口数量对内存和启动的影响，官方未测未述。
4. **两家官网都没有 PTY / 长驻子进程的内存数据**：NSGo 有 terminal 组件（文档写「Desktops run local programs」），但未公布多会话 PTY 的资源占用；NSH 文档中没有终端或 PTY 相关条目。
5. **NSGo 没有微基准**：只有应用级整包数据，没有「一次点击多少微秒」「引擎启动多少微秒」这类数字。
6. **NSGo 的 App size 只给二进制大小**，未给安装包或压缩包体积；NSH 三种产物（可执行文件 / 压缩包）都给了。
7. **Android 帧数据两家都不完整**：NSH 只在性能报告里给了模拟器上「滚动时重绑一行 ~0.3–0.4 ms」一行；NSGo 的路线图承认 Android 表格滚动仍在追 NSH。
8. **两家都没有公布 API 稳定版的时间表**：NSH 无 1.0 计划说明；NSGo 只说「API is not stable yet」。

---

## 十、来源清单

| # | 页面 | 用于 |
|---|---|---|
| 1 | <https://nsh.dev/docs.md> | NSH 定位、What native means 表、Rust/TSX 双路径、retained views、适合场景 |
| 2 | <https://nsh.dev/docs/architecture.md> | 线程模型、commit 与 MountBatch、渲染管线、crate 清单 |
| 3 | <https://nsh.dev/docs/platforms.md> | 平台清单与最低版本、构建机要求、嵌入方式 |
| 4 | <https://nsh.dev/docs/performance.md> | 五条性能规则、QuickJS 约束、Rust vs TSX 对比数字 |
| 5 | <https://nsh.dev/docs/performance-report.md> | 基线数字、四平台帧/内存/体积、测试条件 |
| 6 | <https://nsh.dev/docs/comparison.md> | 与 React Native/Flutter/Qt/GPUI/Slint/Electron/Tauri 的能力矩阵、「When another option fits better」 |
| 7 | <https://nsh.dev/docs/goals.md> | 设计原则、Windows 自研编辑器说明 |
| 8 | <https://github.com/longbridge/nsh/blob/main/CONTRIBUTING.md> | 「not an all-in-one application platform in the manner of Electron」范围声明 |
| 9 | <https://nsgo.dev/docs/index.md> | NSGo 定位、逐平台绘制表、Status（early、0.1.0、API 不稳定） |
| 10 | <https://nsgo.dev/> | 首页平台清单、Early preview 标注、HarmonyOS Preview、小程序 Experimental |
| 11 | <https://nsgo.dev/docs/comparison.md> | Strengths / Weaknesses 全列、Choose NSGo / Choose NSH |
| 12 | <https://nsgo.dev/benchmarks/> | 五框架同机基准、测试条件、Counter/Streaming/Scrolling 数据、二进制体积 |
| 13 | <https://nsgo.dev/docs/terminal.md> | terminal 组件：桌面端运行本地程序 |
| 14 | <https://github.com/nsgo-dev/nsgo/blob/main/docs/architecture/nsh.md> | NSGo 与 NSH 的关系、语言与运行时差异表、Go 的 API 形状、平台与嵌入差异、What NSGo leaves out |
| 15 | <https://github.com/nsgo-dev/nsgo/blob/main/docs/roadmap.md> | 落后于 NSH 的性能条目与实测数字、以 NSH 0.5.0 为参照 |
| 16 | GitHub API `repos/longbridge/nsh`、`repos/nsgo-dev/nsgo` | star 数、仓库创建时间、release 列表与日期 |

---

## 附：两家在本次对比维度上的速览

| 维度 | NSH | NSGo |
|---|---|---|
| 语言 | Rust（+ TSX） | Go（+ TSX） |
| TSX 运行时 | QuickJS（C 库，有字节码与堆上限） | goja（纯 Go，无字节码、无堆上限） |
| 原生依赖 | 有 C | 全平台无 cgo |
| 桌面渲染 | AppKit / Win32+Direct2D / GTK 4 | AppKit / Direct2D / GTK 4 |
| Windows 文本输入 | 自研编辑器 + IMM32 | 官网未单列，未写明 |
| 平台数 | 9（含 TUI、GPUI） | 14（含 watchOS/tvOS/鸿蒙预览/小程序实验） |
| 构建机 | 各桌面目标在各自系统上打包 | 一台 Mac 交叉编译全部 |
| Star | 3,337 | 743 |
| 稳定版 | 9 个 / 34 天，5 个含 breaking changes | 3 个 / 7 天，API 官方声明不稳定 |
| Counter 内存（同机同 App） | macOS 21.3 / Windows 60.3 / Linux 50.0 MB | macOS 24.9 / Windows 59.2 / Linux 47.6 MB |
| Counter 启动（同机同 App） | 324 / 161 / 90 ms | 285 / 161 / 81 ms |
| Counter 体积（同机同 App） | 33.0 / 45.4 / 40.1 MB | 7.9 / 8.4 / 7.9 MB |
| Hello world 体积（官方） | macOS 12.4 MB / Win 25.3 MB / Linux 21.5 MB（Rust 模板） | 官网未给 hello world，只给 counter 7.9–8.4 MB |
