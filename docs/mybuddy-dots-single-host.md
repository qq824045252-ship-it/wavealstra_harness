# Dots 单机常驻与恢复

## 让一台电脑持续处理工作

1. 在固定的 Windows 或 Linux 桌面用户会话中启动 MyBuddy，使用同一系统账号、同一份本地数据目录和原有工作空间。开发环境在仓库运行 `pnpm dev`。调用在线模型或远程工具时，需要可用的网络、账号和权限。Linux 使用项目支持的实际桌面会话与已解锁的系统密钥环。
2. 在设置里打开「退出界面后保持助理在线」。平时用「关闭时最小化到托盘」收起窗口。需要退出界面时，从托盘选择「退出界面，助理保持在线」。第一次交接会关闭原主进程，再启动接管同一数据目录的常驻宿主。再次启动同一份 MyBuddy 可回到界面，打开首页 Dots 查看原对话。
3. 需要完全停止时，从托盘选择「停止助理并退出」。在本地日志 `~/.mybuddy/logs/main-YYYYMMDD.log` 查看主进程启动记录。开发模式的交接输出另在 `~/.mybuddy/logs/resident-launcher.log`。托盘不可用时，Windows 应保持窗口打开。Linux 支持关窗降级驻留，可重新启动同一应用找回界面。

常驻依赖这台电脑运行。关机、休眠或系统会话终止期间，Dots 不会执行本机任务或产生新的执行回执。断网期间，本地界面和已有记录仍可用，在线模型与远程工具要等连接恢复，执行结果以原任务记录为准。开机后由用户启动 MyBuddy，或者使用运维方已有的桌面登录启动配置。这里的设置只负责已经启动的宿主。

同一台电脑上的普通二次启动走 Electron 单实例机制。不同 Electron 配置目录若指向同一份 MyBuddy 数据，第二个主进程会退出。底层互斥依赖本地 SQLite 文件锁。使用第二台机器前应停止第一台宿主并完成一致性恢复，避免用共享盘或云同步目录同时运行两份活动数据库。[主机所有权](../src/main/host/HostDataLease.ts) · [常驻交接](../src/main/host/ResidentLifecycle.ts) · [关闭窗口的平台策略](../src/main/platform/tray/residency.ts)

## 重启后检查什么

打开 Dots 查看待处理事项的状态和本次结果。宿主先恢复原生会话，再用委派时持久化的输入 ID 查原任务回执。原生已经接收的输入沿原任务处理。只有确认输入尚未接收，且任务、空间、目录与暂停状态仍符合交办时的条件，才重新提交同一个输入。暂时无法读取回执时，宿主会短暂重试，仍无法确认则保留该请求供下次启动核对。外部系统已发生的业务操作能否安全重试，取决于原工具自身的执行记录。收到「需要你回复」时可以留在 Dots 直接回答。需要查看执行细节时再打开来源任务。[委派恢复](../src/main/dots/DotsDelegations.ts) · [重启验收](../scripts/dots-delivery-test.ts)

定时交办支持两种错过触发的处理方式。`coalesce` 把离线期间错过的触发合并为一次，Dots 的一次性计划默认采用这一项。`skip` 跳过错过的触发。超过计划指定的截止时间后不补执行。文件监听在重启时也会检查当前文件状态，离线期间连续变更不保证逐次重放。[定时与文件触发验收](../scripts/dots-delivery-test.ts)

## 冷备份与还原

停止宿主后，从工作树使用与项目一致的 Node 和 pnpm。目标的父目录须已存在。下面以 Windows 的本地备份盘为例。

```powershell
pnpm dots:profile backup "$env:USERPROFILE\.mybuddy" "D:\备份\MyBuddy-1122"
pnpm dots:profile verify "D:\备份\MyBuddy-1122"
pnpm dots:profile restore "D:\备份\MyBuddy-1122" "D:\恢复\MyBuddy" --known-profile "$env:USERPROFILE\.mybuddy"
```

命令与宿主使用同一把资料目录写锁。备份把 SQLite 已提交的数据合入一份独立数据库，记录目录、内部链接以及每个文件的长度与 SHA-256。恢复先核对清单与数据库，再将副本放入新目录。资料目录内指向外部的文件链接会报告原路径，须单独安排备份。普通空间绑定指向的外部目录同样按下文保存。快照含私人对话和配置，请保存在该账号控制的介质中。

有较新的完整资料副本时，用 `--known-profile` 对照该副本的遗忘记录与私人入口授权。缺少已知遗忘记录或仍带已撤销绑定的快照会被拒绝。只剩一份旧快照时可省去此选项，先恢复到隔离目录。输出时间是副本所知的最后时点。恢复至原绝对路径并重新联机前，按下文核对该时点后的遗忘和授权变化。

- **备份时点。** 从托盘完全停止助理，确认对应的宿主主进程已退出后，再由文件系统快照或备份工具复制数据。使用仍运行的桌面做文件拷贝会让数据库、日志和文件处在不同时间点。记录 MyBuddy 版本、系统账号、原路径、快照时间，以及最近一次遗忘是否已经生效。
- **备份范围。** 保留整份 `~/.mybuddy`（Windows 通常为 `%USERPROFILE%\.mybuddy`），包括 `app.db` 及存在的 SQLite 辅助文件、`durable` 原生会话、执行目录、文件快照和配置。另存空间绑定的外部文件夹、资料库自定义位置，以及需要保留的 Electron 用户数据目录。现有任务文件历史备份仅能还原其清单中的文件。系统密钥环、登录凭据和文件系统权限须按原平台恢复，换机后可能需要重新登录。[数据路径](../src/main/paths.ts) · [任务文件备份范围](../src/main/agent/FileBackupService.ts)
- **还原顺序。** 保持所有宿主退出，保留当前数据的独立副本。选择与运行版本数据格式一致的整套快照，恢复原账号下的完整目录、原绑定路径和权限，然后只启动一份 MyBuddy。当前产品在确认 `app.db` 格式不匹配后会重建数据库。先核对 Dots 历史、来源任务、一个已交付文件和遗忘结果，再恢复正常使用。原会话绑定与文件引用包含绝对路径。[数据库格式策略](../src/main/db/AppDatabase.ts) · [原生会话目录](../src/main/agent/durable/DurableBotService.ts)
- **遗忘边界。** 已执行的精确遗忘依靠同一数据库里的有效事实、目标指纹和水位阻止旧提炼重新写入。恢复遗忘完成之后制作的快照，才能恢复当时的遗忘状态。早于遗忘的副本仍可能包含原事实。外部离线副本不会追溯更新。如果只剩这样的副本，先在断网且无法访问生产工作空间的隔离环境恢复。重新执行并核实后续遗忘，再决定是否将副本用于在线任务。[冷备份遗忘回归](../scripts/memory-correctness-test.ts)

`pnpm -s test:dots-host` 使用临时用户资料启动两个真实 Electron 主进程，检查目录争用、退出与接管，还会启动没有窗口的常驻宿主，恢复交办时尚未接收的一条 Dots 请求。`pnpm -s test:dots-desktop` 检查真实 Dots 委派与文件重开。备份验证覆盖当前格式数据库中的遗忘前后两种快照。跨机凭据、外部目录与整机灾难恢复需要结合实际备份介质验收。

## 在指定机器运行七天稳定性验收

在可连续运行的 Windows 或 Linux 桌面会话中，从这个工作树执行 `pnpm -s test:dots-host --soak-hours=168`，保持机器和用户会话在线。测试使用临时 HOME、独立的 Electron 配置和本机模拟模型服务。它检查第二个宿主遭到拒绝、无窗口宿主接回一次遗漏的委派，此后每小时由真实定时器在同一个 Dots 会话发起一次模型对话。另有三个一次性任务分别测试本机模拟模型连接被断开、模型明确拒绝请求、随后成功回答。测试从当前宿主的数据库核对失败原因和恢复回执，并等待常规定时器再次成功。较短的检查可以使用 `--soak-hours=0.0125`（至少 45 秒，定时器每 5 秒触发）。

长测的临时账号仅记录应用内通知，避免用户误点测试通知打开窗口。使用 `pnpm -s test:dots-host --soak-hours=0.018 --controlled-notifications` 可以在隔离的通知接收端区分送达和点击，核实只有点击才打开界面。要在真实系统桌面复核，运行 `pnpm -s test:dots-host --soak-hours=0.018 --desktop-notifications` 并等待完成，期间让通知自然消失。

测试会打印 `out/diagnostics/dots-host/<时间>/resident-soak.jsonl` 的位置。运行时最长每分钟追加一条记录，包含墙钟和单调时钟的累计时长、宿主 PID、所有权、主线程响应及原生定时执行次数。主进程更换、超过三分钟的采样空档、定时执行异常等都会使检查失败。只有最终 `report.json` 显示 `status: passed` 且 `soak.result` 为 `seven-day run completed`，才算完成七天验收。短测和中断留下的记录不能累计成七天结果。


在 Windows 日常使用的机器上，可用 `python scripts/start-dots-soak-desktop.py` 从同一工作树启动 168 小时长测。启动器用当前账户创建一个独立的 Win32 桌面，用缓存中与 package.json 相同版本的 pnpm 启动正式测试。Windows 保持当前交互桌面。启动目录写入 `out/diagnostics/dots-isolated-desktop/<时间和标识>/launch.json`，同目录的 `runner.log` 给出宿主证据路径。可从 `resident-soak.jsonl` 读取宿主 PID，PowerShell 中用 `(Get-Process -Id $residentPid).Threads.Id` 取得线程，再运行 `python scripts/start-dots-soak-desktop.py --desktop $desktopName --inspect $threadIds --output $outputFile` 核对实际 GUI 线程的桌面。保持当前 Windows 会话登录，最终以原测试的 report.json 判定是否跑满七天。
