# FastCopy 使用指南(给 AI Agent 的参考文档)

> 本文档供 AI 编码 Agent(Codex / Claude Code / Cursor 等)在需要复制、移动、删除、同步文件时使用。
> 所有示例均已在本机实测验证(标 ✅ 的为实测确认)。

## 0. Default runtime

Use the Node wrapper from Git Bash after the directory/batch threshold and authorized scope are established. The historical low-level option examples below use native Windows argument syntax, not executable Bash snippets. From Bash, invoke the wrapper or set MSYS2_ARG_CONV_EXCL='*'.

```bash
node "$HOME/.mybuddy/skills/fastcopy-copy/scripts/fcopy.mjs" --src "C:/source" --dst "D:/target" --mode force_copy
```

## 1. 软件位置与可执行文件

FastCopy 便携版根目录:`C:\Users\servi\Documents\FastCopy`

| 文件 | 用途 | 推荐度 |
|---|---|---|
| `App\FastCopy64\fcp.exe` | **纯命令行工具**(无界面、有退出码、输出日志到控制台) | ⭐ 首选 |
| `App\FastCopy64\FastCopy.exe` | GUI 版,也支持命令行参数(会弹出窗口) | 备选 |
| `FastCopyPortable.exe` | 便携版启动器(启动 GUI) | 不用 |
| `App\FastCopy64\doc\FastCopy_cn.chm` | 官方中文帮助 | 查阅 |

版本:fcp 5.11.2 / FastCopy 5.11.1 (2025-10)。

**结论:用 `fcp.exe` 即可完成"复制软件、备份目录"等一切需求,无需 GUI。**

完整路径:

```text
C:\Users\servi\Documents\FastCopy\App\FastCopy64\fcp.exe
```

## 2. fcp.exe 基本语法

```bat
fcp.exe /cmd=操作模式 源路径 [/to=目标路径] [其他参数...]
```

✅ 实测有效示例(来源 `C:\...\src` → 目标 `C:\...\dst`):

```bat
:: 复制(全覆盖,不跳过任何文件)
fcp.exe /cmd=force_copy C:\data\src /to=C:\data\dst

:: 增量同步(目标不存在/更新的文件才复制,目标多余文件删除)
fcp.exe /cmd=sync C:\data\src /to=C:\data\dst

:: 移动(剪切)
fcp.exe /cmd=move C:\data\src /to=C:\data\dst

:: 删除
fcp.exe /cmd=delete C:\data\src
```

## 3. /cmd 操作模式对照表

| 模式 | 说明 |
|---|---|
| `force_copy` | 复制,全覆盖(不管目标是否相同)✅ |
| `noexist_only` | 仅复制目标中不存在的文件 |
| `update` | 仅复制较新的文件 |
| `diff` | 复制大小/日期不同的文件 |
| `exist_diff` / `exist_update` | 目标已存在时按 diff / update 逻辑复制 |
| `sync` | 单向镜像:源复制到目标,目标多余则删除 ✅ |
| `sync_update` | 单向镜像更新较新的源文件；目标多余文件仍可能删除 |
| `move` | 移动(复制+删除源)✅ |
| `move_noexist` | 移动,仅目标不存在的文件 |
| `delete` | 删除源文件/目录 ✅ |
| `verify` / `verify_read` / `verify_check` | 复制后校验 / 只读校验 / 校验已复制内容 |

## 4. 常用参数

| 参数 | 说明 | 示例 |
|---|---|---|
| `/to=路径` | 目标目录(delete 不需要) | `/to=D:\backup` |
| `/include="模式"` | 只处理匹配的文件(UNIX 通配符) | `/include="*.txt"` ✅ |
| `/exclude="模式"` | 排除匹配的文件 | `/exclude="*.tmp;*.log"` |
| `/srcfile=文件` | 源列表写在文本文件里(每行一个路径) | `/srcfile=C:\list.txt` |
| `/no_confirm_del` | 删除前不确认 | 配合 `delete` 使用 |
| `/error_stop` | 出错时停止 | |
| `/no_ui` | 完全无界面输出 | |
| `/open_window` | 显示 GUI 窗口(fcp 默认不显示) | |
| `/auto_close` | 完成后自动关闭(GUI 模式用) | |
| `/bufsize=N` | 缓冲区大小 MB,默认按磁盘自动 | `/bufsize=64` |
| `/speed=full\|autoslow\|9-1\|suspend` | 限速 | `/speed=autoslow` |
| `/log` `/filelog` `/logfile=文件` | 写日志 / 文件日志 / 指定日志路径 | `/logfile=D:\copy.log` |
| `/utf8` | 日志用 UTF-8 编码 | |
| `/acl` `/stream` `/reparse` | 复制 ACL / NTFS 流 / 符号链接(默认已含) | |
| `/verify` | 复制后校验 | |
| `/recreate` | 保持源目录结构 | |
| `/wipe_del` | 删除时覆写(防恢复) | |
| `/job=任务名` | 使用已保存的 FastCopy 任务配置 | |
| `/ini=文件` | 指定 ini 配置(便携版默认 `Data\FastCopy2.ini`) | |

## 5. 退出码(重要!)

| 退出码 | 含义 | 判定方法 |
|---|---|---|
| `0` | ✅ 成功(ErrFiles: 0 / ErrDirs: 0) | `echo %ERRORLEVEL%` 或 PowerShell `$LASTEXITCODE` |
| `-1` | ❌ 失败(源不存在、初始化错误、有错误文件) | 同上 |

✅ 实测:源路径不存在 → 退出码 `-1`,输出 `FindFirstFileEx(...) : 系统找不到指定的文件。`,统计行 `Result : (ErrFiles : 0 / ErrDirs : 1)`。

**脚本中必须检查退出码,不要只看输出里的 `TotalFiles` 数字。**

## 6. 脚本集成示例

### Git Bash（默认）

```bash
node "$HOME/.mybuddy/skills/fastcopy-copy/scripts/fcopy.mjs" --src 'C:/Program Files/MyApp' --dst 'D:/backup/MyApp'
result=$?
if [ "$result" -ne 0 ]; then
  printf 'FastCopy failed: %s\n' "$result" >&2
  exit "$result"
fi
```

### 批处理

```bat
@echo off
set FCP=C:\Users\servi\Documents\FastCopy\App\FastCopy64\fcp.exe
"%FCP%" /cmd=sync C:\data\src /to=D:\data\dst /logfile=C:\data\sync.log
if errorlevel 1 (
  echo 同步失败!
  exit /b 1
)
echo 同步成功
```

### 定时备份(任务计划)

```bat
"%FCP%" /cmd=force_copy C:\Users\servi\Documents /to=D:\backup\Documents /exclude="*.tmp" /auto_close
```

## 7. GUI 版 FastCopy.exe 命令行方式(备选)

```bat
FastCopy.exe /cmd=copy /src="C:\data\src" /dst="D:\data\dst" /auto_close /force_start
```

- `/cmd=copy|move|delete|sync`(注意这里是 `copy` 不是 `force_copy`)
- 会弹出 GUI 窗口;`/auto_close` 完成自动关闭;`/force_start` 忽略"已有实例"直接启动。
- 需要无窗口场景一律用 `fcp.exe`。

## 8. 注意事项与坑

1. **fcp.exe 第一个位置参数是源路径**,目标用 `/to=`;`delete` 模式不需要 `/to`。
2. **路径含空格必须加引号**,例如 `/to="D:\My Backups\App"`。
3. **源路径不存在时退出码为 -1**,务必备份前检查源存在。
4. **默认日志位置**:exe 同级 `Log\` 目录(如 `App\FastCopy64\Log\时间戳-序号.log`),可用 `/logfile=` 改到指定位置。
5. **复制正在运行的软件/绿色软件**:占用中的文件会进入 ErrFiles 统计,退出码非 0;先退出目标软件再复制,或接受部分失败。
6. **长路径支持**:FastCopy 支持超过 260 字符的路径和 Unicode 文件名,`robocopy` 处理不了的长路径可以交给它。
7. **性能**:多线程、绕过系统缓存,大文件/大量小文件都远快于系统复制;同盘与跨盘自动选择最优策略。
8. **参数风格**:fcp 用 `/param=value`,大小写不敏感;`/include` 可多次指定。
9. **便携版配置**:设置在 `Data\FastCopy2.ini`(本目录),用 `/ini=` 可指定其他配置,不影响默认配置。
10. **禁止逆向工程 / 商用需 Pro 许可**(GPLv3,家庭个人免费)。

## 9. 速查:常见任务一句话

```bat
:: 复制整个软件目录(绿色软件搬家)
"%FCP%" /cmd=force_copy "D:\Software\GreenApp" /to="E:\Software\GreenApp"

:: 只备份文档和代码,排除缓存
"%FCP%" /cmd=update "C:\Users\servi\Documents" /to="D:\backup\Docs" /exclude="node_modules;.git;*.tmp"

:: 增量同步到 U 盘
"%FCP%" /cmd=sync "C:\Users\servi\Projects" /to="E:\Projects"

:: 清空临时目录
"%FCP%" /cmd=delete "C:\Users\servi\AppData\Local\Temp\oldcache" /no_confirm_del
```

---

*最后更新:2026-08-04,基于本机 fcp 5.11.2 实测。全局技能:fastcopy-copy*
