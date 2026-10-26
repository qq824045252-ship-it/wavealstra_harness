# SIGILL 崩溃诊断：2026-10-26 17:26–17:30 四次主进程 core dump（§5-7 证据）

> 对应 shared task `task-9` 第 5 项；审计来源 `artifacts/audit-2026-10-26/product-runtime.md` F2.1/F2.2。
> 本文件只做**诊断与证据留档**，不修根因；修复建议在 §6。
> 采集方式：只读 `coredumpctl` / `journalctl` / gdb / eu-stack；未重启或干扰任何实例。

## 1. 事实

| # | PID | 时间（CST） | 信号 | si_code | core 大小 | 命令行 |
|---|---|---|---|---|---|---|
| 1 | 215771 | 17:26:36 | SIGILL | `ILL_ILLOPN` | 26.1 MB | `electron --disable-component-update --disable-background-networking .` |
| 2 | 218605 | 17:28:10 | SIGILL | `ILL_ILLOPN` | 25.8 MB | 同上 |
| 3 | 222056 | 17:29:22 | SIGILL | `ILL_ILLOPN` | 25.3 MB | `electron .` |
| 4 | 223348 | 17:30:15 | SIGILL | `ILL_ILLOPN` | 27.6 MB | 同上（带两个 disable flag） |

- 四份 core 都是 **Electron 主进程**（无 `--type=`），不是 GPU/renderer 子进程。
- 内核消息：`traps: electron[<pid>] trap invalid opcode ip:<addr> sp:... error:0 in electron[...]`。
- 四份 core 的**主线程栈逐帧同偏移**（ASLR 后同一地址布局），即同一崩溃点，不是随机硬件/指令集问题。
- 时间点精确落在 `.tools/mybuddy.sh restart` 的 stop 阶段：journal 可见 17:26:36 / 17:28:09 / 17:29:22 的 restart 调用，以及每次 app scope 的存活统计（215771 存活 2min07s、218605 59.8s、222056 36.8s、223348 18.5s，均在 restart 时刻被 `pkill -f` 发 SIGTERM 结束）。即**崩溃发生在被 stop/退出时，不是启动即崩**。
- 崩溃前已在运行的实例（如 215771 起于 17:24:31）在 restart 时崩溃；17:30:49 起的当前实例此后稳定运行（>4h），**当前实例未复现**。
- 四份 dump 中唯一缺 build-id 的模块是 `keyring.linux-x64-gnu.node`（每次都是这一条 Module 提示）。

## 2. 崩溃点反汇编（223348 / 215771 两份 core 一致）

从 core 取 `rip` 并反汇编（`gdb -batch -ex 'x/6i $rip-12' <electron> <core>`）：

```text
0x...d514: 48 8d 3d 00 bb d7 f7   lea  -0x8284500(%rip),%rdi   # 0x10fb01b
0x...d51b: e8 f0 c5 e8 fb         call 0x520bb10
0x...d520: cc                     int3
0x...d521: 0f 0b                  ud2          <-- rip，SIGILL
0x...d523: cc                     int3
```

- `0x937f521`（相对 electron 基址）即 `ud2`；`int3; ud2` 是 Chromium/V8 的 **`IMMEDIATE_CRASH` / `FATAL` 序列**（先 breakpoint，再非法指令），不是 CPU 真的执行了不支持的指令。
- `lea` 的字符串地址 `0x10fb01b` 在二进制 .rodata 中内容是 **`"string_view::substr"`**；该函数体内相邻引用还包括：
  - `0x10fa18b` = `"%s:%d: %s"`（`file:line: function` 风格 fatal 日志格式）
  - `0x157f606` = `"NOTREACHED hit. "`
  - `0x121099c`/`0x1210c66`/`0x11329b5` = `"function_name"` / `"file_name"` / `"line_number"`
  - `0x11b7bd4` = `"debug.log"`
- 因此可以确定：**这是一处 Chromium/V8 的 `NOTREACHED()` / `CHECK`/`FATAL` 主动触发的 `ud2`，不是 CPU 指令集不兼容**。trap 前传入的 `"string_view::substr"` 是 fatal 日志记录的函数名/标签。
- `call 0x520bb10` 是通用 fatal 日志 helper：全二进制共有 **851** 个 `call 0x520bb10` 调用点，符合 `LOG(FATAL)`/`NOTREACHED` 这一类公共实现。

## 3. 主线程栈（223348；215771/218605/222056 同偏移）

```text
TID 223348（coredumpctl info 原文，仅保留 electron/glib 帧）:
#0  electron + 0x937f521   ud2
#1  electron + 0x55ce04d
#2  electron + 0x53a3e49
#3  electron + 0x83d4767
#4  electron + 0x54782cb
#5  electron + 0x83d477e
#6  electron + 0x83d2f4b
#7  electron + 0x83d8ed2
#8  electron + 0x83d93d7
#9  electron + 0x823a6b2
#10 electron + 0x587a1c2
#11 electron + 0x587a043
#12 electron + 0x5879f16
#13 electron + 0x3546682
#14 electron + 0x35406c0
#15 libglib-2.0.so.0 + 0x6175e   (g_main_dispatch.lto_priv.0)
#16 libglib-2.0.so.0 + 0x6ac50   (g_main_context_iterate_unlocked.isra.0)
#17 libglib-2.0.so.0 + 0x6adb5   g_main_context_iteration
#18 electron + 0x354a286
#19 electron + 0x5085a7f
#20 electron + 0x50851b1
#21 electron + 0x5410bb1
#22 electron + 0x5b279a3
#23 electron + 0x5b27aeb
#24 electron + 0x5b27097
#25 electron + 0x5b27e61
#26 electron + 0x5b2acf3
#27 electron + 0x5b2a5aa
#28 electron + 0x5b2a3c7
#29 libc.so.6 + 0x27781
#30 libc.so.6 + 0x278b9   __libc_start_main
#31 electron + 0x5de274a  _start
```

解读：崩溃发生在 **GTK/Chromium 主消息循环（frame #15 `g_main_dispatch`）派发的任务里**，属于主进程正常运行/收尾路径，而不是子进程或 GPU 线程；栈上方是 V8/Chromium 内部帧（#1–#14 都在 electron 自身 .text，未导出符号）。

## 4. 符号化尝试与结果（为什么没法给到 file:line）

| 尝试 | 结果 |
|---|---|
| `coredumpctl dump <pid> -o core` | 成功，可读 1.0 GB core（4 份 dump 均在 `/var/lib/systemd/coredump/`，zstd 压缩 25–28 MB） |
| `gdb -batch -ex 'bt'`（electron 44.5.1） | 仅解析出 `?? ()`；`info registers`/`x/i`/`x/s` 可用（本报告 §2 即由此得到） |
| `eu-stack -e electron --core core` | 主线程 32 帧、可解析 libc/glib 帧；electron 内部帧只有地址 |
| `addr2line -Cfipe electron 0x937f521` | 命中 dynsym 最近导出符号 `rust_bmp$cxxbridge1$197$Reader$image_data_loaded`（偏移 60 KB），**无意义**——Chromium 内部符号已 strip |
| binary 本身 | `ELF ... stripped`，`.gnu_debuglink = electron.debug`；npm electron dist **不附带** `electron.debug`；`/usr/lib/debug/.build-id/b2/ea5067...debug` 不存在 |
| dynsym 映射（`nm -D -S`） | 栈帧偏移距最近导出符号 27,766–6,314,263 字节（约 27 KB–6.3 MB），全部不可用；说明该二进制只保留少量导出符号 |
| 结论 | **当前机器无法把 Chromium 内部帧解析到 file:line**；需要 Electron 官方 debug symbols（见 §6）才能确认 `NOTREACHED` 的源码位置 |

补充：静态反汇编 + `.rodata` 字符串提取（objdump/gdb）足以定位"trap 机制 + fatal 日志标签"，这在没有符号的情况下是本报告最有价值的结论。

## 5. 结论（区分已验证/推测）

**已验证**
1. 四次 SIGILL 是同一崩溃点、同一 `ud2` fatal trap（`int3; ud2` 序列），不是 CPU/内存随机错误，也不是 GPU/renderer 崩溃。
2. trap 处打印的标签是 `"string_view::substr"`，同函数体内有 `"NOTREACHED hit. "` / `"%s:%d: %s"` / `"function_name"/"file_name"/"line_number"` 字符串 —— 可判定为 Chromium/V8 的 `NOTREACHED()`/`CHECK` 主动 fatal。
3. 四次崩溃都发生在 `mybuddy.sh restart` 的 stop 阶段（`pkill` → SIGTERM → 应用退出/重启流程），每次 crash 时间戳与该次 restart 调用重合；进程都是先正常跑过 18–127 秒再在退出时崩溃。当前实例（17:30:49 起）之后未再崩溃。
4. 崩溃发生时主线程在 GTK 主循环（`g_main_dispatch`）派发的任务中。

**推测（未证实，需 debug symbols / 复现验证）**
1. 触发条件与**退出/重启路径**相关（SIGTERM → Chromium 优雅关闭 → 某处 `NOTREACHED()`）；可能由"关闭时仍在处理字符串/路径相关回调"引起（函数体里有 `strrchr('/')`、0x400 路径缓冲、`errno==EINTR` 等路径处理迹象）。
2. `keyring.linux-x64-gnu.node` 是唯一无 build-id 的模块，且崩溃与退出重合，但它**没有出现在任何栈帧**里；更像"退出时原生模块析构"的间接关联，不能据此定性。
3. 可能与 dev 模式（HMR/热重载）+ 退出并发有关；打包版是否复现未知。

## 6. 下一步最小复现与根治建议（本任务不修根因）

**最小复现（不改代码，只观察）**
```bash
# 1) 正常起 dev，等主进程出现
.tools/mybuddy.sh start        # 或 pnpm dev
# 2) 只对主进程发 SIGTERM（模拟 restart 的 stop 阶段）
P=$(for p in $(pgrep -f 'electron/dist/electron '); do \
      tr '\0' ' ' < /proc/$p/cmdline | grep -q -- '--type=' || echo $p; done | head -1)
kill -TERM "$P"
# 3) 看是否新增 coredump（当前实例不受影响）
coredumpctl list --no-pager | tail -3
# 4) 想抓 stderr/日志：用 gdb 起进程，收到 SIGTERM 时停住看栈
gdb --args ./node_modules/.pnpm/electron@44.5.1_*/node_modules/electron/dist/electron .
#   (gdb) run
#   (gdb) handle SIGTERM stop
#   (gdb) bt
```

**拿到符号（关键一步，需要网络）**
- 从 Electron releases 下载 `electron-v44.5.1-linux-x64-debug.zip`（或 `*.debug` / `symbols` 包），把 `electron.debug` 放到 electron 可执行文件同目录（当前 `.gnu_debuglink` 期待的名字），然后重跑 §4 的 gdb 命令即可得到 `file:line`。
- 官方 debug symbols 的 build id 必须与当前二进制一致：`b2ea506795df6224232fcc64a7d9e7fc3775f920`（校验后使用）。

**观察点（若复现）**
- `ELECTRON_ENABLE_LOGGING=1`、`ELECTRON_ENABLE_STACK_DUMPING=1` 启动，观察 `NOTREACHED hit.` 前后的 Chromium 日志；
- 若拿到符号，重点看 `string_view::substr` 标签所在 `NOTREACHED()` 的调用方（frame #1–#4）；
- 对比打包版（无 HMR）是否同样在 SIGTERM 时崩溃，以区分 dev-only 问题。

## 7. 本次实施带来的可观测性（§5 其余项）

- `crashReporter` 已启动（`uploadToServer:false`，`crashDumps` → `~/.mybuddy/crashdumps`）：**下一次同类 `ud2` 崩溃会被 crashpad 以本地 dump 形式记录**（比只依赖 systemd coredump 更容易导出/上报）；启动时日志会打印 dump 目录。
- `~/.mybuddy/logs/main-YYYYMMDD.log` 会记录 `uncaughtException`/`unhandledRejection`（含栈与进程信息）与 `render-process-gone`/`child-process-gone`（含 reason/exitCode）；这两类 JS 层异常此前只能看 stderr。
- 注意：crashpad 只能捕获它自己接管的进程内崩溃；本次四份 core 是 **crashReporter 尚未装配时**产生的，历史 dump 无法补做，只能用于后续复现。

---

## 8. 2026-10-27 复验：修复后每次 stop 必现 + crashpad 已能抓到 dump

修复（§5-1/§5-7）落到 main 后，用 `.tools/mybuddy.sh restart` 做了一次真实桌面复验（06:23–06:24）：

1. **托盘修复生效**：新实例（PID 848886）的 SNI 项 `org.freedesktop.StatusNotifierItem-848886-1`
   现在有 `IconPixmap`（44×44，非空），此前旧实例只有空属性；启动日志为
   `[Tray] 系统托盘已初始化 (png)`。
2. **safeStorage 修复生效**：启动日志 `[safeStorage] linux backend=gnome_libsecret available=true`
   （此前是 basic_text 风险）。
3. **SIGILL 不是偶发**：`mybuddy.sh stop` 在 06:23:08 一次产生 3 份 SIGILL core
   （PID 224446 / 570992 / 573040，均为同一 exit 路径），06:24:07 对带 crashReporter 的新实例
   （PID 848886）再次 SIGILL → **每次 stop 必现**，不是启动崩溃或环境偶发。
4. **crashReporter 捕获成功**：新实例的 SIGILL 在本地 crashpad 留下
   `~/.mybuddy/crashdumps/pending/f6895012-0ef2-4529-b93b-341c614d6f25.dmp`（约 360KB）
   + `.meta`；`~/.mybuddy/logs/main-20261027.log` 同时记录了 shutdown 阶段的
   `child-process-gone`/`render-process-gone`（不再只有 console）。→ §5-7 的可观测性目标达成。
5. **下一步（仍未做）**：用 `minidump_stackwalk` / Electron 44.5.1 官方 debug symbols 符号化
   这份 dmp；最小复现已可稳定触发——启动应用后只对主进程 `kill -TERM`，观察 keyring
   linux 原生模块在 teardown 期的调用栈。修根因（不是加日志）需要一次单独的 Electron/原生模块
   排查窗口。
