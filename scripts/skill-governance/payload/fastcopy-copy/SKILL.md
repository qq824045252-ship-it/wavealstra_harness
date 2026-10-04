---
name: fastcopy-copy
description: "Use FastCopy on Windows for copying, moving, deleting or synchronizing a whole directory tree or at least 30 files. Single files and smaller batches use ordinary file operations. Invoke the Node wrapper from Git Bash."
---

# fastcopy-copy — 用 fcp.exe 复制/移动/删除/同步文件(仅限文件夹或批量)

> **适用条件(强制门槛):只有满足下列任一情形,本技能才可启用(fcp.exe):**
> - **复制/移动/删除/同步的对象是一个文件夹(整个目录树)** —— 不管内部文件多少;
> - **单次处理的文件数量 ≥ 30 个**。
>
> **单文件或一次性文件数少于 30 个时,禁用本技能**,直接用普通复制即可,不再调用 fcp.exe。
>
> 在符合上述条件的前提下,禁止使用 shell 内置 copy / xcopy / robocopy / cp / mv / rm / del,
> 也禁止 PowerShell 的 Copy-Item / Move-Item / Remove-Item 等(个人文件安全规则中的
> 回收站/确认流程仍然有效,先与用户确认再执行删除)。

## 什么时候用(先过适用门槛,满足其一才用)

**可使用本技能的两种情况:**
1. 处理对象是**整个文件夹(目录树)** —— 如备份目录、绿色软件搬家、复制整个软件安装目录、U 盘增量同步;
2. 单次要复制/移动/删除/同步的**文件数量 ≥ 30 个**。

**禁用本技能的场景(直接普通复制即可):**
- 单文件复制/移动(如单个 docx、单个图片);
- 一次性文件数少于 30 个;
- 用户提到 FastCopy / fcp 字样时:先判断是否满足上述门槛,满足才调用本技能,不满足则说明原因并改用普通方式。

> 补充:若因路径超 260 字符 / Unicode 文件名导致普通复制报错,即便属单文件/少量文件,
> 也需先确认普通方式确实无法完成,再人工评估是否借用 fcp.exe(此情形不算常规启用条件)。

## 工具路径

```text
fcp.exe    = C:\Users\servi\Documents\FastCopy\App\FastCopy64\fcp.exe
FastCopy.exe = C:\Users\servi\Documents\FastCopy\App\FastCopy64\FastCopy.exe  (GUI,不推荐)
帮助文档   = C:\Users\servi\.mybuddy\skills\fastcopy-copy\references\FastCopy_USAGE.md
```

## Workflow — Git Bash

确认目录/批量门槛和用户授权 → 解析源、目标绝对路径 → 选择复制/移动/同步模式 → 执行 Node wrapper → 检查退出码和实际结果。移动、删除、同步删除之前必须核对解析后的目标范围；已有授权无需反复询问。不能用门槛要求扩大用户操作范围。

```bash
SKILL_DIR="$HOME/.mybuddy/skills/fastcopy-copy"
node "$SKILL_DIR/scripts/fcopy.mjs" --src 'C:/source folder' --dst 'D:/target folder' --mode force_copy
# 增量复制，过滤临时文件
node "$SKILL_DIR/scripts/fcopy.mjs" --src 'C:/source folder' --dst 'D:/target folder' --mode diff --exclude '*.tmp;*.log'
```

Node 用 shell:false 调用 fcp.exe，避免 MSYS 对 /cmd 和 /to 参数自动转换。路径含空格、中文、单引号时分别引用各参数。传入 Windows 路径（C:/...），不要把 /c/... 藏在字符串中交给 Node。

参数：--src 必填；--dst 除 delete 外必填；--mode 默认 force_copy；--include/--exclude 使用分号分隔过滤器；--log-file 指定日志；--no-confirm-del 仅用于已获授权的 delete。

模式包括 force_copy、noexist_only、update、diff、exist_diff、exist_update、sync、sync_update、move、move_noexist、delete、verify、verify_read、verify_check。**sync 是从源到目标的单向镜像，会删除目标多余文件；不是双向同步。sync_update 也可能删除目标多余文件，不能当非破坏性更新使用。**

## Output Contract

退出码 0 且文件数、文件名、必要时内容哈希符合预期才算成功；非 0 保留 stdout/stderr 与日志位置，不能只看进度。Git Bash 用 $? 读取退出码，wrapper 透传子进程退出码，输入验证失败为 2。

产物是请求范围内的文件变更及操作摘要（源、目标、模式、验证结果）。源/目标错误或占用文件报错时停止，修正原因后再继续。默认日志目录为 C:/Users/servi/Documents/FastCopy/App/FastCopy64/Log/。

## Compatibility / References

旧 scripts/fcopy.ps1 保留供现有调用方兼容，不是默认入口。需要详细 FastCopy 选项时读 references/FastCopy_USAGE.md。直接 Bash 调 exe 时必须设置 MSYS2_ARG_CONV_EXCL='*'，日常优先 wrapper。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
