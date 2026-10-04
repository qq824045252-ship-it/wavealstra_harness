# MyBuddy · Pi 0.99.2 升级与 Memory 专项验收

> 后续更正：宿主控制遗漏（2026-10-01）。本记录有关宿主执行控制收敛的结论存在遗漏，后续发现了 MCP 计划状态门禁及网页后台唤醒路径。修复和新包验收见 `MyBuddy-Pi-host-control-exit_2026-10-01.md`。本记录保留为历史，不代替新包证据。

生成时间（UTC）：2026-09-30T23:57:33.776Z

## 交付结论

**桌面已升级并切换至经验证的 Pi 0.99.2 新包。记忆缺陷修复与桌面验收完成。Android APK 已生成，ADB 未发现设备，本次未执行手机安装和真机验收。**

本轮保留此前 Pi 原生运行链收敛成果，没有恢复 Completion Gate、隐藏自动续跑或任务复杂度评分。所有记忆创建、修改、删除测试均使用隔离数据库／用户目录，不以用户真实记忆做破坏性测试。

## 升级范围

pi-ai、pi-agent-core、pi-coding-agent、pi-mcp、pi-codemode、pi-tui、pi-telemetry、chord，8 个实际安装包均为 0.99.2。lockfile 和生效的补丁引用同步更新。

0.99.2 的 MCP 发现与命名发生变化，因此本次同时处理 codemode-deferred → codemode、规范化名称冲突、description、OAuth clientName、provider auth，以及新的 Codemode Worker 入口。旧补丁首次直接应用失败的记录保留在 upgrade-before-rebase.json；已重做适配，不是忽略失败。

子代理的旧版本锁定已更新；构建校验改为从根 manifest 读取精确版本并核对 launcher，防止桌面与 Worker 混版。

上游依据：[Pi 官方 v0.99.2 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.99.2)。

## 记忆缺陷与修复

| 问题 | 修复 | 证据 |
|---|---|---|
| 异步召回等待期间删除、替代、解绑或过期，仍可能返回缓存的旧词法命中；语义失败回退亦然 | 返回前重读现有记录、范围、状态、有效期；范围变化则不返回旧结果，失败回退也重新检索 | memory-race-before.json / memory-race-results.json |
| 更新后，等待中的召回可能输出旧内容 | 返回时使用当前记录，而非 await 前的 DTO | memory-race-results.json |
| 较慢的旧 embedding 覆盖新版本；删除后迟到写入触发外键错误 | embedding 完成后核对记录仍存在、active、contentHash 一致，再写入索引 | memory-race-results.json |
| 任务解绑空间后，胶囊范围回退到创建会话时的旧空间 | 只取当前 task 归属，不再使用 opts.spaceId 回退 | memory-capsule-results.json；resolveTaskMemoryScope |
| 直接调用提取服务时可能遗漏调用方的归属复核 | 提取服务在模型返回后与提交候选前再次校验 task 范围 | memory-race-results.json |

最后一项是服务边界加固：AgentService 原有自动提取调用方已经检查任务归属，本轮把这一条件下沉到服务本身，不能把它表述为已证明现有主调用路径发生过错写。

关键实现：src/main/memory/MemoryService.ts、MemorySemanticProvider.ts、src/main/agent/MemoryContextProjection.ts 与 AgentService.ts。

## 记忆生效语义

普通修改保持当前逻辑轮的一致快照，下一用户轮读取新值。删除、撤销或范围收窄会在下一模型请求前复核，禁止继续发送旧来源。已发送到供应商的请求不能被倒回；已经出现在用户／助手聊天正文中的内容也不会因为删除长期记忆而自动删除。

胶囊是请求级补充，不写入 Pi 的 append-only 会话历史，不作为原生压缩输入，不通过压缩创造 L0/L1。以上使用真实 Pi AgentSession、真实 SQLite、可控的测试 provider 验证。

## 真实模型 Memory 验收

使用已配置的真实 provider/model，在隔离的实际打包桌面中通过 IPC、Memory 服务、Pi session 和历史回读验证。每个问题不携带答案；答案是本次随机生成的编号。

| 测试 | 结果 |
|---|---|
| 全局记忆自动召回 | 通过 |
| 项目 A 召回，不泄漏 B | 通过 |
| 项目 B 召回，不泄漏 A | 通过 |
| 修改后，新任务读取新值 | 通过 |
| 删除后，新任务返回 UNKNOWN | 通过 |
| 同项目兄弟任务不读取私有记忆 | 通过 |
| 关闭记忆后不自动注入 | 通过 |

报告：artifacts/pi0992-memory/memory-live/results.json。旧任务历史不用于证明删除效果；删除／更新验收使用新的任务会话，区分长期记忆召回与聊天历史。

## 其它验收

- 14 个 Memory 测试套件、10 个原生运行／压缩／远程套件、5 个集成套件，共 29 个套件通过。
- 10 个记忆竞态故障注入用例：修复前均复现失败，修复后均通过。
- 4 个真实 Pi 记忆胶囊场景通过：范围隔离、逐轮更新、删除、解绑及压缩排除。
- 8 个真实模型执行任务通过：仓库统计、随机数据计算、真实失败修复、Worker、列目录、缺文件、超时与非零退出。
- 122 个 Pi 0.99.2 核心文件与校验完整性的官方发布包逐字节一致。保留的本地补丁仅是 host/provider/打包适配，不声称整个产品完全没有补丁。
- 桌面、远程前端类型检查和构建通过；Android renderer 测试、Capacitor 同步与 Gradle assembleDebug 通过。

## 当前运行与回退

当前执行文件：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\release-pi0992-20260930234642464\win-unpacked\MyBuddy.exe

桌面现有 MyBuddy 快捷方式已切换。当前主进程 PID 7428；新进程监听远程 3352 端口，healthz 返回 200。

切换前确认无本次旧进程的活动任务记录／有效租约，已保存 SQLite 一致性备份并通过 quick_check：

    C:\Users\servi\.mybuddy\backups\pi0992-memory-20260930235315331\app.db

旧免安装包保留；旧快捷方式备份：artifacts/pi0992-memory/MyBuddy-shortcut-before.lnk。原有未提交修改保留，本轮未提交或推送 Git。

## Android 状态

APK 已验证为 com.mybuddy.remote，versionName=1.1.8，versionCode=10：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\artifacts\pi0992-memory\android\MyBuddy-Remote-1.1.8-pi0992.apk

使用 Windows SDK adb 多次复核后设备列表仍为空，记录在 android/adb-final.txt。本轮没有安装到手机，也没有真机截图验收。手机连接到更新后的 PC 服务时使用的是新后端，但手机内置前端仍需安装新 APK 才能更新。

## 指纹与记录

源码：`35f596821d6e0012f86e0409e3540061dc5954f22c0c41a1f7e84c29c92bf2fb`

app.asar：`c6e667d26325d40b7ec22e29ca1ea972bee449f3068fe8077fc8c2a8e78657a3`

APK：`8d9bafb826668a26d146490e9f587cde0d565b09f32dd0e67e549a26e3bf8dd5`

机器可读总记录：artifacts/pi0992-memory/closeout-summary.json。详细测试、构建、升级失败前记录均在同目录；没有用旧包通过结果代替新包验收。

本轮结论限于已复现问题和所列验收，不保证所有模型与外部工具永不出错。尤其不把 APK 编译通过等同于手机安装完成。
