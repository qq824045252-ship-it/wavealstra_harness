## Windows / Git Bash 运行备忘

以下为本机(Windows + MyBuddy/pi)实测踩过的坑,执行任何操作前先扫一遍:

### Daemon 启动(Windows 特有)
`easyeda daemon start` 是**前台阻塞进程**(按 Ctrl+C 或关窗口退出)。在 cmd 中直接执行会一直挂着日志。

**本机准备了双击运行的脚本(已在运行则跳过,不杀不重启):**
`C:\Users\servi\.mybuddy\bin\easyeda-daemon.ps1`
或桌面快捷方式 `easyeda-daemon.lnk`

仅此 launcher 通过显式 PowerShell backend 启动；普通 CLI 使用 Git Bash：
```powershell
# 已运行就跳过,不会杀旧进程
& "C:\Users\servi\.mybuddy\bin\easyeda-daemon.ps1"
# 或手动检查:
easyeda health  # status: found → 已在运行,跳过
```

### health 偶发 `not_found` 假阴性
daemon 实际在运行(PID 存在、端口 60832 LISTENING)时 `easyeda health` 可能返回 `not_found`。**这不是 daemon 死了**——是 daemon 的 HTTP server 有短暂窗口不响应。再次 health 即可恢复。
pi 的「Daemon not found — retrying in the background; just start the daemon.」是平台自动重试文案,不代表 daemon 真的挂了。

### 多窗口消歧(最常见卡点)
嘉立创EDA 专业版在 Electron 中会启动**多个 `lceda-pro` 进程**(多标签页架构),连接器附着到其中数个窗口。`easyeda health` 输出 `windows[]` 有多个条目时:
```
# ❌ 这样会报 "3 windows connected — pass --window <id>"
easyeda doc ls --project lmc6062-fix_copy
easyeda sch read --project lmc6062-fix_copy --doc P1

# ✅ 正确做法:从 health 输出取一个 windowId,所有命令加 --window
easyeda health
# 从输出匹配目标工程的 windowId，以下替换成实际值
win="目标窗口ID"
easyeda doc ls --project <name> --window "$win"
easyeda sch read --project <name> --window "$win" --doc <page_uuid>
```
**`--project` 在单窗口时够用,多窗口时必须 `--window <id>`。**

### 连接器升级(CLI 自动,连接器手动)
- CLI + Skill: `easyeda update` 一键升
- 连接器 `.eext`: **无自动更新**,必须手动 ①卸载旧版(扩展管理→已安装→卸载)→②导入新版 `.eext`→③完全退出重启 EasyEDA(否则旧窗口代码继续跑、抢 daemon)
- 版本对齐检查: `easyeda update --check` (无副作用)

### sch check 常见警告(非致命,但影响门禁)
| 警告 | 根因 | 处理 |
|---|---|---|
| 零长度导线(zero-length-wire) | 挪件/删件后残留,首尾坐标相同 | `sch prim-delete --ids <id>` 删除 |
| 导线交叉(wire-crossing) | 两根导线交叉未连接 | 调整导线路径 |
| 极性约定异常(polarityConventionOutliers) | 电容/二极管方向与库约定不一 | 检查后按需修正 |
| 悬空脚(floating-pin) | 芯片未用脚(含 NC) | NC 脚用 `sch no-connect` 标记可消除 |

这些警告不一定是设计错误,但 `sch gate --strict` 会拦截——进交付前应逐项审阅。
