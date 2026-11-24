# Electron / NSH / NSGo 三方横向对比（仅依据各自官网与官方文档）

编制日期：2026-11-24
数据来源限定：`electronjs.org`（官方文档）、`nsh.dev`、`nsgo.dev`，以及三个项目的官方仓库（GitHub `electron/electron`、`longbridge/nsh`、`nsgo-dev/nsgo`）。
本文不使用第三方博客、论坛、独立基准网站或其他框架的数据。某一格官网没给的，写「官方无数据」，不填第三方数字。

---

## 一句话结论

三方在官方资料层面**没法放进同一张内存表**：Electron 官方根本不公布内存和启动数字（Performance 页是优化清单，不是基准报告），NSH 与 NSGo 各自公布了一套，但机器、应用、内存口径都不一样。能三方并列的只有包体积，而包体积三家的口径又不一致（Electron 给的是运行时压缩包，另两家给的是含应用的完整程序）。**唯一能直接横比的官方数字是 NSGo 基准页上的 NSH vs NSGo 同机同 App 那一组。**

---

## 一、三方是什么关系

| | 定位 | 官方原话 |
|---|---|---|
| Electron | 在二进制里嵌入 Chromium 与 Node.js，用 JS/HTML/CSS 写桌面应用 | 「By embedding Chromium and Node.js into its binary, Electron allows you to maintain one JavaScript codebase and create cross-platform apps that work on Windows, macOS, and Linux」（`electronjs.org/docs/latest/`） |
| NSH | Rust 优先的原生视图框架 | 「a native UI framework for every platform… each time as an app of that platform: made of its own views」（`nsh.dev/docs.md`） |
| NSGo | NSH 设计的 Go 移植 | 「NSGo ports the design of Native Shell (NSH) to Go. The architecture, the names and the behavior apps see are NSH's」（`nsgo-dev/nsgo` 仓库 `docs/architecture/nsh.md`） |

Electron 与另外两家不是同一类东西：前者的 UI 是网页、引擎是自带 Chromium；后两家的 UI 是平台视图（Windows 例外，见 2.2）、引擎是自己写的 Rust / Go 运行时。

---

## 二、架构与渲染方式

### 2.1 Electron 官方怎么描述自己的架构

全部来自 `electronjs.org/docs/latest/tutorial/process-model`：

- **继承 Chromium 的多进程模型**：「Electron inherits its multi-process architecture from Chromium, which makes the framework architecturally very similar to a modern web browser.」
- **主进程**：「Each Electron app has a single main process, which acts as the application's entry point. The main process runs in a Node.js environment, meaning it has the ability to `require` modules and use all of Node.js APIs.」
- **主进程的职责**：创建与管理窗口（`BrowserWindow`）、控制应用生命周期（`app` 模块）、提供原生桌面能力（菜单、对话框、托盘）。
- **renderer 进程**：「Each Electron app spawns a separate renderer process for each open `BrowserWindow` (and each web embed).」——**每个窗口一个 renderer 进程**。
- **窗口销毁连带 renderer**：「When a `BrowserWindow` instance is destroyed, its corresponding renderer process gets terminated as well.」
- **renderer 默认拿不到 Node**：「the renderer has no direct access to `require` or other Node.js APIs」；需要能力时走 preload + `contextBridge`（受 `contextIsolation` 约束）。官方注明 renderer 曾经默认带完整 Node 环境，「this feature was disabled for security reasons」。
- **utility 进程**：可以从主进程另起子进程，「The utility process runs in a Node.js environment… can be used to host for example: untrusted services, CPU intensive tasks or crash prone components」，并且能与 renderer 建立 `MessagePort` 通道。

对应到「多会话窗口 + 本地进程管理 + PTY」这类应用：**窗口数直接等于 renderer 进程数**（官方明文），Node 侧能力（PTY、文件监听、`child_process`）只能待在主进程或 utility 进程里，renderer 要用就得靠 IPC 桥过去。

### 2.2 NSH / NSGo 的逐平台实现

| 平台 | NSH 官方描述 | NSGo 官方描述 |
|---|---|---|
| iOS | UIKit 视图；CoreText；系统文本框与 TextView | UIKit 与 CoreText |
| Android | Android views；`StaticLayout`；`EditText` | Android Views |
| macOS | AppKit + Core Animation；CoreText；`NSTextField`/`NSTextView` | AppKit 与 CoreText |
| Windows | **Win32 窗口，用 Direct2D 绘制**；DirectWrite；**文本框是 NSH 自己的编辑器 + 系统输入法（IMM32）** | **Direct2D 与 DirectWrite** |
| Linux | GTK 4；Pango；GTK `Text`/`TextView` | GTK 4、Pango 与 Cairo |
| Web | HTML 元素 + CSS；浏览器字体；浏览器输入框 | WebAssembly 与 DOM 元素 |

出处：`nsh.dev/docs.md`「What native means」表；`nsgo.dev/docs/index.md`「How it works」表。

**要说明的一点**：Windows 上两家都不是系统原生控件，都是自己画。NSH 写得最直白，连文本输入都注明是自研编辑器；NSH 的 `docs/goals.md` 也重申「including NSH's own editor on Windows」。

### 2.3 三方架构对照

| | Electron | NSH | NSGo |
|---|---|---|---|
| UI 由谁绘制 | 自带 Chromium | 平台视图（Windows 为 Direct2D 自绘） | 平台视图（Windows 为 Direct2D 自绘） |
| 后端语言 | Node.js（JavaScript） | Rust | Go |
| 进程/线程模型 | 1 个主进程 + 每窗口 1 个 renderer + GPU/utility 等 | 每个 app 两条线程：引擎线程 + 主线程 | 官网未单列（无架构页） |
| 跨线程方式 | IPC（`ipcRenderer`/`ipcMain`、`contextBridge`） | 一次 commit 一批 mount items，一跳过线程 | 「each update crosses to the main thread once, as one batch of only what changed」 |
| 官方是否声明「主线程不阻塞」 | 是（Performance 页第 3 条，见第三节） | 是（「The main thread never waits for JS.」） | 官网未写明 |

---

## 三、Electron 官方 Performance 页：承认的开销与官方建议

页面：`electronjs.org/docs/latest/tutorial/performance`

### 3.1 官方自己承认的开销来源

这一页没有基准数字，但把「哪里会变慢」说得很直白。以下均为原文要点：

- **`require()` 本身很贵**，而且官方点名平台差异：「Loading modules is a surprisingly expensive operation, especially on Windows.」
- **模块依赖链可能吃秒级时间**：官方举了一个网络连通性检测模块的例子，它依赖一个十万多行的 JSON 端口表，「Whenever the module was loaded… it would load all its dependencies and eventually read and parse this JSON file. Parsing many thousands lines of JSON is a very expensive operation. On a slow machine it can take up whole seconds of time.」
- **启动初期抢资源**：「many applications tend to do a large amount of work immediately after the app has launched – like checking for updates, downloading content used in a later flow, or performing heavy disk I/O operations.」
- **主进程被阻塞会冻结整个应用**：「The main process… houses the UI thread. Under no circumstances should you block this process and the UI thread with long-running operations. Blocking the UI thread means that your entire app will freeze.」
- **同步 IPC 与 `@electron/remote` 容易踩坑**：「Avoid using the synchronous IPC and the `@electron/remote` module as much as possible… it is far too easy to unknowingly block the UI thread.」
- **主进程里的同步 I/O**：`fs`、`child_process` 有同步版本时要用异步版本。
- **polyfill 通常是负优化**：「It is rare for a JavaScript-based polyfill to be faster than the equivalent native feature in Electron.」

官方同时说明了自己的责任边界：「performance is largely your responsibility」——Electron 提供能力，性能取决于应用怎么写。

### 3.2 官方优化清单（原文八条）

1. 谨慎引入模块（Carelessly including modules）
2. 不要过早加载和运行代码（Loading and running code too soon）
3. 不要阻塞主进程（Blocking the main process）
4. 不要阻塞 renderer（Blocking the renderer）
5. 去掉不必要的 polyfill
6. 去掉不必要或会阻塞的网络请求
7. 打包你的代码（Bundle your code）
8. 不需要默认菜单时调用 `Menu.setApplicationMenu(null)`

官方给出的唯一实例化数字在第 1 条：「on the author's machine, we saw that loading `request` took almost half a second, whereas `node-fetch` took dramatically less memory and less than 50ms.」——**这是模块加载的对比，不是 Electron 本身的基线**。

官方还建议先测量再优化，并点名「Experience from working with major apps like Visual Studio Code or Slack has shown that this practice is by far the most reliable strategy to improve performance.」

### 3.3 Electron 官方有没有内存和启动时间的数字

**没有。**

- 官方 Performance 页通篇是建议与陷阱清单，**不含任何 Electron 空应用的内存占用或冷启动时间**。
- 官方 Process Model 页、Introduction 页、Distribution 系列页同样没有这两项数字。
- 在 `electronjs.org` 域内检索「memory usage / startup time / benchmark」，命中的只有上述 Performance 页的模块加载例子和一篇讲网站国际化的博客，**没有官方基准数据**。

结论：**在官方资料范围内，Electron 的内存与启动时间无法参与任何对比表。** 想比只能靠第三方测量，而本文不用第三方数据。

---

## 四、三方是否公布内存/启动数字（逐一核对）

| | 官方是否公布「单窗口静置内存」 | 官方是否公布「启动时间」 | 官方是否有专门基准页 |
|---|---|---|---|
| Electron | **否** | **否** | 否（有 Performance 优化指南） |
| NSH | 是（`nsh.dev/docs/performance-report.md`「Memory」，分成 macOS / Windows / Linux / iOS 四节） | 部分（引擎启动 ~75–155 µs、Mac Catalyst 首帧 ~1.05–1.15 ms；**不含整机冷启动到窗口出现**） | 是（同一页 + 独立 `nsh-perf-bench` 仓库） |
| NSGo | 是（`nsgo.dev/benchmarks/`「Memory」） | 是（「Startup」，定义为启动到首帧） | 是（`nsgo.dev/benchmarks/`） |

---

## 五、NSH 与 NSGo 官网/官方文档里提到 Electron 的地方

### 5.1 NSH（共 3 处）

| 页面 | 原文 | 性质 |
|---|---|---|
| `nsh.dev/docs.md`（Introduction → How it compares） | 「For whole apps, NSH sits among cross-platform frameworks such as React Native, Flutter, Qt, GPUI, Slint, **Electron** and Tauri… Its choice is each platform's own UI and interaction under one app model, with Rust as the app language and TSX beside it.」 | 只把 Electron 列进同类框架名单，不做对比 |
| `nsh.dev/docs/comparison.md`（`### Electron and Tauri`） | 「**Electron** bundles Chromium and Tauri uses the system's web view: both build desktop apps (and, with Tauri, mobile apps) from web content, with the browser's text and input. NSH builds each platform's own views instead, and renders HTML only on the web itself.」 | 定性对比，无数字 |
| `longbridge/nsh` 仓库 `CONTRIBUTING.md`（Scope） | 「It is **not an all-in-one application platform in the manner of Electron**. Small binaries, fast builds and fast start-up are part of its design…」 | 划范围时以 Electron 作反例，无数字 |

### 5.2 NSGo（共 3 处）

| 页面 | 原文 | 性质 |
|---|---|---|
| `nsgo.dev/docs/comparison.md`（At a glance 表） | 「\| **Electron**, Tauri \| Web pages; Rust for Tauri \| A bundled Chromium; the system webview for Tauri \| Desktops; phones for Tauri \|」 | 归类，无数字 |
| `nsgo.dev/docs/comparison.md`（Weaknesses → TSX is interpreted） | 「…slower than the engines React Native or **Electron** use.」 | 拿 Electron 的 JS 引擎当性能上限参照，无数字 |
| `nsgo.dev/docs/comparison.md`（其他框架一节） | 「**Electron and Tauri** show web pages: the web's tools and libraries in full, at the cost of a browser's memory, **Electron's above all**, and an interface that feels like a web page.」 | 定性判断「Electron 的内存代价最大」，**无数字支撑** |

### 5.3 小结

- 两家都**没有**在自己的官方文档里给出 Electron 的任何实测数字。
- 两家都**没有**把 Electron 放进自己的基准页。NSGo 的基准页比的是 NSGo / NSH / MyGo / GPUI Kit / GPUI Fast，**Electron 不在其中**。
- NSGo 那句「Electron's above all」是**定性判断**，官方没有提供测量依据；本文不把它当数据用。

---

## 六、官方性能数据

### 6.1 NSGo 基准页：NSH 与 NSGo 同机同 App（Electron 无数据）

页面：`nsgo.dev/benchmarks/`（2026-11-10 测）

**测试条件（官网原文）**：
- 三个小应用（Counter / Streaming quotes / Scrolling list），每个框架按各自惯用方式各写一份，release 构建，轮流跑
- 三台机器：**Apple M1 Max，34.36 GB**；**Intel Core Ultra 9 285K，67.94 GB**；**AMD Ryzen 9 6900HX，31.25 GB**
- 每组「3 次运行、每次 10 s 的中位数」
- 内存口径逐平台不同：「the physical footprint on macOS, the proportional set size on Linux, the working set on Windows」
- CPU 为「percent of one core」，并额外计入合成器
- release 构建：「`go build -ldflags "-s -w"`，and `cargo build --release` with symbols stripped」
- 版本：NSGo 03896f1、NSH 0.4.0

**Counter（一个计数器和两个按钮，放着不动）**。注意：Electron 不在该基准页里，这一项对 Electron 无数据。

| 指标 | 平台 | NSH | NSGo |
|---|---|---:|---:|
| 启动（启动到首帧） | macOS | 324 ms | **285 ms** |
| | Windows | 161 ms | 161 ms |
| | Linux | 90 ms | **81 ms** |
| 内存 | macOS（footprint） | **21.3 MB** | 24.9 MB |
| | Windows（working set） | 60.3 MB | **59.2 MB** |
| | Linux（PSS） | 50.0 MB | **47.6 MB** |
| 二进制体积 | macOS | 33.0 MB | **7.9 MB** |
| | Windows | 45.4 MB | **8.4 MB** |
| | Linux | 40.1 MB | **7.9 MB** |

**Streaming quotes（40 行报价表，其中 10 行每帧变化）与 Scrolling list（10,000 行，每帧滚动一行）**

| 指标 | 平台 | NSH | NSGo |
|---|---|---:|---:|
| 报价表 CPU | macOS / Win / Linux | **66.2% / 157.8% / 19.4%** | 75.8% / 175.6% / 24.0% |
| 报价表内存 | macOS / Win / Linux | **36.7 / 68.3 / 55.5 MB** | 47.9 / 76.2 / 61.1 MB |
| 万行列表 CPU | macOS / Win / Linux | **47.4% / 148.7% / 11.0%** | 52.3% / 154.9% / 13.4% |
| 万行列表内存 | macOS / Win / Linux | **31.3 / 64.9 / 52.1 MB** | 42.0 / 71.5 / 56.0 MB |
| 帧率 | 三平台 | 达到刷新率 | 达到刷新率 |

**这张表的性质**：由 NSGo 自己发布，却有多行显示 NSH 更省 CPU / 内存；若存在系统性偏向，方向应该相反。帧率两家都顶到刷新率，差别在同样帧数花了多少 CPU 和内存。

### 6.2 NSGo 路线图：承认仍落后于 NSH 的部分

`nsgo-dev/nsgo` 仓库 `docs/roadmap.md` 用 NSH 的同一批 gallery 场景在自己机器上量了两家：

| 场景 | 平台 | NSGo 实测 | NSH 实测 |
|---|---|---:|---:|
| DataTable 滚动 | Linux（GTK） | 5.5 ms/帧，51% 单核 | 1.6 ms/帧，22–23% |
| DataTable 滚动 | Windows | 41–44% 单核 | 30–32% |
| 堆叠视图滑动 | Windows | 28–29% 单核 | 20–22% |
| DataTable 滚动 | Android 模拟器 | 118–126% | 110% |
| 动画层 | macOS | 6–15% 单核，0.3–0.8 ms/帧 | 10–14%，0.6 ms（大体持平） |

同页结论：「Headless, in headless Chrome, on macOS for the DataTable and the stack, and in the iOS simulator, NSGo costs what NSH does or less.」
**Linux（GTK）和 Windows 上 NSGo 目前更费 CPU，这是 NSGo 官方写进待办的内容。**

### 6.3 NSH 性能报告：自家绝对基线

页面：`nsh.dev/docs/performance-report.md`

| 场景 | 数值 |
|---|---|
| Counter 无头（debug） | 首帧 ~0.5–0.65 ms；一次点击 ~0.15 ms |
| Counter Mac Catalyst（release） | 首帧 ~1.05–1.15 ms；一次点击 ~0.12 ms |
| 引擎启动（release） | ~75–155 µs |
| 热重载 | 存盘到新版本运行 ~120 ms |

**静置内存（release）**

| 平台与口径 | Rust 应用 | TSX 应用 | 裸平台窗口参照 |
|---|---|---|---|
| macOS（footprint） | ~19 MB | ~20 MB | 裸 AppKit 窗口 ~17 MB（**窗口 480×640，应用为 1200×800，尺寸不同**） |
| Windows（私有工作集） | ~14 MB | ~15 MB | —（同机工作集 ~53–71 MB） |
| Linux（private dirty） | 41.6 MiB | 45.4 MiB | 裸 GTK 窗口 36.7 MiB（**三者同为 480×640**） |
| Linux（PSS） | 69.2 MiB | 78.6 MiB | 裸 GTK 窗口 48.8 MiB |

Linux 这一列是**唯一口径完全对齐的「框架自身开销」**：NSH Rust 应用比裸 GTK 窗口多 4.9 MiB（private dirty），TSX 应用多 8.7 MiB。

### 6.4 Electron

**官方无数据。** 见 3.3。

---

## 七、包体积与分发

### 7.1 Electron 官方说明

- **体积的根本原因**：官方 Introduction 原话——「By **embedding Chromium and Node.js into its binary**」。
- **官方没有给「空应用成品体积」的数字**。Distribution 系列文档（`/docs/latest/tutorial/distribution-overview`、`/tutorial/tutorial-packaging`）只讲流程，不给体积。
- **打包方式**：官方明说「Electron does not have any tooling for packaging and distribution bundled into its core modules.」需要额外工具（Electron Forge、`@electron/packager`）。Forge 的 `make` 做两件事：先 `package`「bundles your app code together with the Electron binary」，再按 maker 生成各平台安装包。
- **分发链路**（官方 Distribution Overview）：打包 → 代码签名 → 发布（直接下载，或 Mac App Store / Windows Store / Snapcraft 三种商店）→ 自动更新。
- **官方发布产物的实际大小**（GitHub Release `v45.4.1`，2026-11-19，见官方仓库资产列表）：

| 平台 | 官方发布产物 | 大小 |
|---|---|---:|
| macOS arm64 | `electron-v45.4.1-darwin-arm64.zip` | 115.4 MB |
| Windows x64 | `electron-v45.4.1-win32-x64.zip` | 151.0 MB |
| Linux x64 | `electron-v45.4.1-linux-x64.zip` | 118.2 MB |

**注意**：这是**Electron 运行时本体的压缩包，不含应用代码、不含 `node_modules`**。它不是「一个 Electron 应用的安装包体积」，官方没有公布后者。

### 7.2 NSH 官方数据

`nsh.dev/docs/performance-report.md`「App size」，hello world 由 `nsh init` 生成，release 构建，LTO + strip：

| 目标 | 模板 | 可执行文件 | 打包产物 |
|---|---|---:|---:|
| macOS arm64 | Rust | 12.4 MB | 6.0 MB（zip） |
| macOS arm64 | TSX | 19.8 MB | 9.5 MB |
| Windows x86_64 | Rust | 25.3 MB | 10.7 MB（zip） |
| Windows x86_64 | TSX | 28.6 MB | 12.4 MB |
| Linux x86_64 | Rust | 21.5 MB | 9.7 MB（`.tar.gz`） |
| Linux x86_64 | TSX | 25.7 MB | 11.6 MB |

### 7.3 NSGo 官方数据

`nsgo.dev/benchmarks/`「Binary size」，Counter 应用，release 构建：

| 平台 | NSGo |
|---|---:|
| macOS | 7.9 MB |
| Windows | 8.4 MB |
| Linux | 7.9 MB |

### 7.4 三方体积并排（口径不同，勿直接相减）

| 平台 | Electron（运行时 zip） | NSH（hello world 可执行文件） | NSGo（counter 二进制） |
|---|---:|---:|---:|
| macOS | 115.4 MB | 12.4 MB（Rust）/ 19.8 MB（TSX） | 7.9 MB |
| Windows | 151.0 MB | 25.3 MB（Rust）/ 28.6 MB（TSX） | 8.4 MB |
| Linux | 118.2 MB | 21.5 MB（Rust）/ 25.7 MB（TSX） | 7.9 MB |

**这一行必须带三个警告**：
1. Electron 的数字**不含应用代码**，另两家**含应用**。
2. 三个是**不同应用**（Electron 是空运行时；NSH 是 hello world；NSGo 是 counter）。
3. 三个数字**不是同一类产物**（压缩包 vs 已解压可执行文件）。

即使如此，量级差距仍然清楚：**Electron 光运行时就是另外两家完整应用体积的 4.6–18 倍。**

---

## 八、平台、语言与成熟度

| | Electron | NSH | NSGo |
|---|---|---|---|
| 官方支持平台 | Windows、macOS、Linux（Introduction 原文） | iOS 15+、Android 8+（含 32 位）、macOS 14+、Windows 10 1809+、Linux GTK 4.14+、Web、TUI、GPUI；Mac Catalyst 仅开发用 | iOS/App Clips、tvOS、watchOS、Android（不含 32 位）、macOS、Windows、Linux、Web、HarmonyOS（Preview）、四个小程序平台（Experimental） |
| 应用语言 | JavaScript / TypeScript + HTML/CSS | Rust（首选）、TSX | Go（首选）、TSX |
| 后端语言 | Node.js | Rust | Go |
| JS 引擎 | 自带 Chromium 的 V8 | QuickJS（C 库；Rust 应用不带引擎） | goja（纯 Go；无 C、无 cgo） |
| 当前版本 | v45.4.1（2026-11-19） | v0.6.1（2026-11-20）+ 每日 nightly | v0.3.0（2026-11-23） |
| API 稳定性 | 稳定版大版本 | 8 个后续版本中 5 个含 breaking changes | 官方原文「0.1.0 is its first release, its API is not stable yet」 |
| Star | —（未在本文核对） | 3,337 | 743 |

---

## 九、三方对比总表

规则：同一指标只有两家有官方数据时只填两家，缺的格写「官方无数据」。

| 指标 | Electron | NSH | NSGo |
|---|---|---|---|
| **单窗口静置内存** | **官方无数据** | macOS footprint ~19 MB；Windows 私有工作集 ~14 MB；Linux private dirty 41.6 MiB（自家模板 App） | macOS 24.9 MB；Windows 59.2 MB；Linux 47.6 MB（counter App） |
| **冷启动时间** | **官方无数据** | **官方无整机冷启动数字**；仅有引擎启动 ~75–155 µs、Mac Catalyst 首帧 ~1.05–1.15 ms | macOS 285 ms；Windows 161 ms；Linux 81 ms（启动到首帧） |
| **运行期 CPU / 帧成本** | **官方无数据**（只给优化建议） | 有：gallery 逐页 p95 0.1–4.8 ms、CPU 1–43%（按平台） | 有：5 框架对比中 counter/报价表/万行列表的 CPU 百分比 |
| **多窗口内存** | **官方无数据** | **官方无数据** | **官方无数据** |
| **包体积** | 运行时 zip 115.4 / 151.0 / 118.2 MB（macOS/Win/Linux，**不含应用代码**） | hello world 可执行文件 12.4 / 25.3 / 21.5 MB（Rust 模板） | counter 二进制 7.9 / 8.4 / 7.9 MB |
| **架构** | 自带 Chromium + Node 多进程；每窗口一个 renderer | 平台视图 + Rust 引擎；双线程，一批 mounts 过线程 | 平台视图 + Go 引擎；一批 mounts 过线程 |
| **官方是否给出与另两家的对比数据** | 否（官方从不与他人对比） | 否（只与 React Native/Flutter/Qt/GPUI/Slint/Electron/Tauri 做定性对比） | 是，但只与 NSGo 自己选定的原生框架对比；**基准页不含 Electron** |

---

## 十、三方口径不一致在哪里（这一节决定上面哪些格子不能相减）

### 10.1 Electron：没有基准，只有建议

官方 Performance 页的定位是「checklist」，作者自己写「not meant to be exhaustive. It is probably possible to build a slow Electron app that follows all the steps outlined below.」所以：

- **不能**从官方文档推出「Electron 空应用占多少内存/多久启动」。
- 官方唯一给出的数字是模块加载耗时（`request` 近 0.5 s vs `node-fetch` <50 ms），属于**应用代码层面**，不是框架基线。
- 结论：任何把 Electron 和 NSH/NSGo 放进同一张内存表的做法，都必须借用第三方测量。本轮不使用第三方数据，因此那几格只能写「官方无数据」。

### 10.2 NSGo 的基准页：机器、场景、口径都与 NSH 自报的不同

| 对比项 | NSGo 基准页 | NSH 性能报告 |
|---|---|---|
| 机器 | M1 Max / Ultra 9 285K / Ryzen 9 6900HX | MacBook Pro M3 / i7-13700KF+RTX 3060 Ti / x86_64 24 线程 |
| 被测应用 | Counter、40 行报价表、10,000 行列表（三家框架各写一份） | gallery 全部页面 + `nsh init` 模板 hello world |
| 迭代方式 | 每项 3 次运行取中位数，每次 10 s | 自动脚本逐页采集，Linux/Win/mac 分别为 120/144/120 Hz 屏 |
| Linux 内存口径 | **PSS** | 同时给 **private dirty / USS / PSS / RSS** 四个 |
| Windows 内存口径 | **working set** | 同时给 **私有工作集 / private bytes / working set** |
| macOS 内存口径 | **physical footprint** | **footprint**（一致）|

**最典型的坑**：同一个 NSH 应用在 Windows 上，
- NSGo 基准页按 working set 量到 **60.3 MB**
- NSH 自己报告按私有工作集量到 **~14 MB**，按 working set 量到 **~53–71 MB**

两个数字相差 4 倍，**不是谁测错了，是「working set」把共享的 Direct3D / Direct2D / DirectWrite / 显卡驱动页面都算进去了**。拿 NSH 的 14 MB 去对比 NSGo 的 59.2 MB，是错的；拿 NSGo 测的 NSH 60.3 MB 去对比 NSGo 59.2 MB，才是对的。

### 10.3 能直接横比的官方组合只有一组

- **NSGo 基准页里的 NSH vs NSGo**：同机器、同应用、同一时点、同一内存口径 → 可以直接比。
- **NSH 性能报告里的绝对值**：只能作为 NSH 自己的基线，不能和 NSGo 基准页的数字混列。
- **Electron 与任何一方**：官方无数据 → 不可比。

### 10.4 NSH 自报 19 MB 与 NSGo 测到 21.3 MB 不矛盾

两者是不同机器（M3 vs M1 Max）、不同应用（`nsh init` 模板 vs counter）、不同口径（NSH 自报 footprint vs NSGo 测 footprint）的结果，落在同一量级是正常的，**不能据此说谁更准**。

### 10.5 NSGo 的「Electron 内存代价最大」是定性判断

`nsgo.dev/docs/comparison.md` 写「at the cost of a browser's memory, Electron's above all」，但同一页面和其基准页**都没有提供支撑这一定性判断的测量**（基准页里根本没有 Electron）。这一句只能当观点，不能当数据。

---

## 十一、官网未写明项（不做推测，逐条列出）

1. **Electron 官方无内存、无启动时间、无多窗口资源数据**，只有优化建议清单。
2. **Electron 官方无「空应用成品体积」**，只有运行时压缩包的发布产物。
3. **NSGo 官网没有架构页**：`nsgo.dev/docs/architecture.md` 返回 Page not found，线程模型细节只在仓库 `docs/architecture/`。
4. **NSH 官网没有与 NSGo 的对比数据**；`nsh.dev/docs/comparison.md` 的对比对象不含 NSGo。
5. **NSGo 基准页不含 Electron**，因此不存在任何官方的「Electron vs NSGo」数字。
6. **三家都没有多窗口场景的性能数据**——这对「多会话窗口」类应用是最关键的空白。
7. **三家都没有 PTY / 长驻子进程的资源数据**：Electron 有 utility process 与 `child_process` 的官方用法说明但不给数字；NSGo 有 terminal 组件（「Desktops run local programs」）但不给多会话占用；NSH 文档无终端条目。
8. **NSGo 与 NSH 都不公布 Android 真机的完整性能表**（NSH 只有模拟器单行数据，NSGo 路线图承认 Android 表格滚动仍在追）。
9. **NSH 的 macOS 内存表基线窗口尺寸（480×640）与应用窗口（1200×800）不一致**，不能直接做减法；Linux 那张表三者尺寸一致，可以。

---

## 十二、来源清单

| # | 页面 | 用于 |
|---|---|---|
| 1 | <https://www.electronjs.org/docs/latest/> | Electron 定位、嵌入 Chromium + Node、支持平台 |
| 2 | <https://www.electronjs.org/docs/latest/tutorial/process-model> | 主进程 / renderer / utility 进程、每窗口一 renderer、preload 与 contextBridge |
| 3 | <https://www.electronjs.org/docs/latest/tutorial/performance> | 官方承认的开销来源、八条优化清单、唯一的模块加载数字 |
| 4 | <https://www.electronjs.org/docs/latest/tutorial/distribution-overview> | 分发链路：打包 / 签名 / 发布 / 更新 |
| 5 | <https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging> | 官方明说核心模块不含打包工具；Forge 把应用代码与 Electron 二进制打包在一起 |
| 6 | <https://github.com/electron/electron/releases>（v45.4.1，2026-11-19） | 官方发布产物实际大小（darwin-arm64 / win32-x64 / linux-x64） |
| 7 | <https://nsh.dev/docs.md> | NSH 定位、What native means 表、Rust/TSX 双路径、提到 Electron 的名单句 |
| 8 | <https://nsh.dev/docs/architecture.md> | 双线程模型、commit 与 MountBatch |
| 9 | <https://nsh.dev/docs/platforms.md> | 平台清单与最低版本、构建机要求 |
| 10 | <https://nsh.dev/docs/performance.md> | 性能规则、QuickJS 约束 |
| 11 | <https://nsh.dev/docs/performance-report.md> | 基线、四平台帧/内存、三平台 App size |
| 12 | <https://nsh.dev/docs/comparison.md> | 「Electron and Tauri」段原文、能力矩阵、When another option fits better |
| 13 | <https://nsh.dev/docs/goals.md> | 设计原则、Windows 自研编辑器说明 |
| 14 | <https://github.com/longbridge/nsh/blob/main/CONTRIBUTING.md> | 「not an all-in-one application platform in the manner of Electron」 |
| 15 | <https://nsgo.dev/docs/index.md> | NSGo 定位、逐平台绘制表、Status（early、0.1.0、API 不稳定） |
| 16 | <https://nsgo.dev/> | 首页平台清单、Early preview、HarmonyOS Preview、小程序 Experimental |
| 17 | <https://nsgo.dev/docs/comparison.md> | Strengths / Weaknesses、Choose NSGo / Choose NSH、三处提到 Electron 的原文 |
| 18 | <https://nsgo.dev/benchmarks/> | 五框架同机基准、测试条件、Counter/Streaming/Scrolling 数据、二进制体积 |
| 19 | <https://nsgo.dev/docs/terminal.md> | terminal 组件：桌面端运行本地程序 |
| 20 | <https://github.com/nsgo-dev/nsgo/blob/main/docs/architecture/nsh.md> | NSGo 与 NSH 关系、语言与运行时差异、Go 的 API 形状、What NSGo leaves out |
| 21 | <https://github.com/nsgo-dev/nsgo/blob/main/docs/roadmap.md> | 落后于 NSH 的性能条目与实测数字 |
| 22 | GitHub API `repos/electron/electron`、`repos/longbridge/nsh`、`repos/nsgo-dev/nsgo` | 版本号、发布产物大小、star、release 列表与日期 |

---

## 附：一句话记住三家的差别

- **Electron**：每个窗口一个 Chromium renderer 进程，Node 能力在主进程；官方不谈自家内存和启动数字，只教你怎么省。
- **NSH**：Rust 写整套，UI 挂在平台视图上（Windows 除外），官方公布了自己在四平台上的帧、内存、体积基线，但没和 Electron 比过。
- **NSGo**：把 NSH 换成 Go，包体积最小、启动略快；官方基准页承认在 Linux 和 Windows 的部分场景 CPU 仍高于 NSH，且这个基准页里没有 Electron。
