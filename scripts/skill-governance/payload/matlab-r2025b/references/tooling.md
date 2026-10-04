# MATLAB R2025b 本机调用参考

## 本机环境

- MATLAB：`C:\Program Files\MATLAB\R2025b\
- MATLAB 可执行文件：`C:\Program Files\MATLAB\R2025b\bin\matlab.exe\
- MATLAB 版本：R2025b / 25.2.x
- uv Python 3.12 环境：`C:\Users\servi\.venvs\matlab-r2025b\Scripts\python.exe\
- MATLAB Engine for Python：已安装，可用于确实需要 Python↔MATLAB 互操作的任务

## 默认调用路径

本 Skill 的默认路径是：

```text
MyBuddy Git Bash → Node（shell:false）
        ↓
scripts/matlab-run.mjs
        ↓
C:\Program Files\MATLAB\R2025b\bin\matlab.exe -batch
        ↓
MATLAB R2025b
``\

这条路径不依赖 PC MCP、PC Bridge 或 `matlab_exec`。

## 推荐调用

### 短代码

```bash
node "$HOME/.mybuddy/skills/matlab-r2025b/scripts/matlab-run.mjs" \
  --code "x = mean([1 2 3 4 5]); fprintf('%.6f\n', x);"
``\

### 项目脚本

```bash
node "$HOME/.mybuddy/skills/matlab-r2025b/scripts/matlab-run.mjs" \
  --script 'C:\path\to\analysis.m' \
  --cwd 'C:\path\to\project'
``\

复杂分析优先写成 `.m` 脚本或函数后用 `--script` 执行，避免长命令、引号转义和难以复现的问题。

## matlab-run.mjs 行为

- 校验 MATLAB R2025b 可执行文件是否存在
- 支持 `--code` 或 `--script` 二选一
- `--code` 会先写入临时 `.m` 文件，再通过 `run(...)` 执行，避免 shell 引号地狱
- `--cwd` 会在 MATLAB 执行前切换到目标项目目录
- MATLAB stdout/stderr 直接返回给 MyBuddy
- 退出码原样透传；非 0 视为执行失败
- 临时脚本在执行结束后清理

## Python Engine 的使用边界

已安装的 Python 3.12 + MATLAB Engine 是可选能力，不是默认路径。

只有以下情况才考虑使用：

- Python 代码需要直接调用 MATLAB 函数并取回 Python 对象
- 需要在一个 Python 驱动进程中连续完成多步 MATLAB 交互
- 现有业务逻辑本身已经以 Python 为主，MATLAB 只是计算后端

不要为了普通 MATLAB 分析再额外写 Python 桥接层。

## 文件与输出

- 大数组不要直接 `disp` 到对话。
- 需要保留的结果优先保存：`.mat`、`.csv`、`.m`、`.fig`、`.png`。
- 复杂任务把核心分析代码落到项目内 `.m` 文件，方便复现、版本管理和后续修改。
- 用户明确说“不要出图”时，不生成图；用数值、表格或保存数据结果替代。

## 故障处理

### MATLAB 找不到

检查：

```bash
test -f 'C:/Program Files/MATLAB/R2025b/bin/matlab.exe'
``\

不要自动切换到其他 MATLAB 版本，除非用户允许。

### MATLAB 返回非 0

先看 MATLAB 错误本身，修正脚本、数据路径或函数调用。不要因为一次报错就改成 PC MCP/Bridge 路线。

### Toolbox 不确定

只在确实需要时检查一次：

```matlab
ver
which('functionName')
license('test', 'Signal_Toolbox')
``\

一旦当前任务已确认某工具箱可用，不要重复探测。

Legacy matlab-run.mjs remains for compatibility only.

Legacy matlab-run.mjs remains for compatibility only.

Legacy matlab-run.mjs remains for compatibility only.

Legacy matlab-run.ps1 remains for compatibility only.
