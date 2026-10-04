---
name: code-view
description: |
  代码库快速探索专用技能：先元信息、再骨架、后关键符号，单引擎直跑，
  不修环境、不交叉验证、不整读大文件。触发词：探索代码、分析项目、
  理解代码库、这是什么项目、梳理架构、代码结构、浏览代码、看下这个
  项目、熟悉一下代码。目标：3-5 轮工具调用内产出结构化探索报告。
---

# code-view — 代码库快速探索（已验证流程，勿再乱试）

> 本技能沉淀自 2026-08 实战教训：探索慢的根源不是工具不够，而是
> 「修环境 + 多引擎交叉 + 无输出模板」。以下是历史环境记录；先确认入口文件存在，索引提交落后时降级文件系统。

## 铁律（违反=回到无头苍蝇模式）

1. **探索 ≠ 修复环境**。MCP 连不上、命令缺失 → 记一笔风险，直接降级到
   文件系统继续，绝不现场安装/配置/冒烟测试（那是独立任务，用户没要求
   就不做）。
2. **单引擎原则**。同一问题只跑一个引擎 + 文件系统辅助，禁止 GitNexus
   CLI / codegraph / serena 三套交叉跑同一个概念——同一批文件被三个引擎
   各输出一遍是最大的 token 浪费。
3. **不整读大文件**。>30KB 的文件（appStore 83KB、HubPage 80KB、
   AgentService 60KB）一律用符号概览或按段读，绝不整文件读。
4. **资源目录不是源码**。`mybuddyskills-main/`、`.wb-ref/`、`app/`
   （旧骨架 demo）、`node_modules/`、`out/` 是数据/构建物，不进探索主线。
5. **有模板就填模板**。输出固定用文末模板，不要每次重新组织语言。

## 已验证环境事实（2026-08，使用前按当前索引状态判断）

| 引擎 | 状态 | 用法 |
|---|---|---|
| GitNexus CLI | ✅ 首选 | 项目根目录 `node .gitnexus/run.cjs <cmd>`；索引在 `.gitnexus/meta.json`（check `lastCommit` vs `git rev-parse HEAD`） |
| serena MCP | ✅ 可用 | 29 工具，符号级导航；已注册 `~/.pi/agent/mcp.json`（绝对路径 `C:\Users\servi\.local\bin\serena.exe` v1.6.1） |
| codegraph MCP | ✅ 可用 | 1 工具 `codegraph_explore`（输出全但量大）；已注册（`codegraph.cmd serve --mcp`，索引 155 文件） |
| 文件系统 | 兜底 | Git Bash：`rg --files` / `head -n N` / `rg -n`；无 rg 时 `find` / `grep` |

引擎优先级：**GitNexus CLI（轻、索引全）> serena（要符号级时）> codegraph（要源码直出时）> 文件系统**。
MCP 连接失败 → 直接跳过该引擎，用 GitNexus CLI 或文件系统，不修。

## 流程（目标 3-5 轮调用，每轮并行发独立请求）

### 第 1 轮 · 元信息快照（并行 2-3 个调用）
```bash
# 并行执行：
head -n 30 package.json      # 身份/技术栈/scripts
test ! -f STATUS.md || head -n 80 STATUS.md   # 架构文档（有就看，没有跳过）
git log --oneline -5; git status -s          # 近期动向 + 未提交改动
git rev-parse HEAD                           # 与 .gitnexus/meta.json 的 lastCommit 对比索引新鲜度
```
- STATUS.md / 架构分析.md 这类文档**先读**，它们是项目作者写的导航，比任何引擎都快。

### 第 2 轮 · 目录骨架 + 规模
```bash
find src -type d
# 文件数、行数与最大文件（NUL 分隔保证空格路径安全）
rg --files src -g "*.ts" -g "*.tsx" | wc -l
rg --files -0 src -g "*.ts" -g "*.tsx" | xargs -0 wc -l | tail -n 1
find src -type f \( -name "*.ts" -o -name "*.tsx" \) -printf "%s %p\n" | sort -nr | head -n 8
```

### 第 3 轮 · 关键符号（只用 ONE 引擎，首选 GitNexus CLI）
```bash
node .gitnexus/run.cjs context <核心类名>      # 360° 视图：callers/callees/processes
node .gitnexus/run.cjs query "<概念>"          # 找执行流（参数带引号，一个短语）
node .gitnexus/run.cjs impact <符号名>          # 改动影响面（探索阶段可省）
```
- 需要符号级细节（方法清单、行号）→ serena `get_symbols_overview`（`relative_path` 必填）。
- 需要源码直出（懒得多层跳转）→ codegraph `codegraph_explore`，但注意它一次能吐几百行，只对核心文件用。
- 只跟一条主线走：入口（index.ts/App.tsx）→ 装配 → 数据流 → 1-2 个代表性实现细节。

### 第 4 轮 · 按需补洞（≤1 轮）
- 未覆盖的模块：`find "<dir>" -maxdepth 1` + 读 1 个代表文件头部（前 60 行注释/接口）。
- 有疑问的符号：`node .gitnexus/run.cjs context <symbol>` 单发。

## 输出模板（直接填，不要自由发挥）

```markdown
## 📦 项目身份
名称/形态/技术栈/唯一仓库路径（1-2 行）

## 🏗️ 架构骨架
顶层目录树（3-4 层）+ 每模块一句话职责；标明入口文件与装配方式

## 🔄 核心数据流
1-2 条主线：入口 → 关键类 → IPC/存储 → UI（符号级）

## 📊 规模
文件数 / 总行数 / 最大文件 Top3 / 索引新鲜度（lastCommit vs HEAD）

## ⚠️ 风险点
- 无测试覆盖的核心符号（用引擎的 blast radius 信息）
- 未提交改动、未跟踪文件
- 环境问题（MCP 不可用等）→ 只记录不修复

## 🎯 下一步建议
≤3 条可执行选项，让用户挑
```

## 反模式清单（本会话真实踩过的坑）

- ❌ 现场修 MCP：npm 搜索包名、pip 查索引、GitHub API、杀进程、重装……探索任务里一律不做
- ❌ `gitnexus query` 传多词不带引号（报 too many arguments）——一个引号短语
- ❌ serena `get_symbols_overview` 漏 `relative_path`（pydantic 报错）——参数必填
- ❌ spawn `.cmd` 不带 shell（Windows EINVAL）——探针脚本才需要，探索阶段不做探针
- ❌ 三引擎输出同一批文件后还要"汇总去重"——从一开始就选一个
- ❌ 把 codegraph 输出里的骨架 demo（`app/renderer/src/App.tsx`）当主应用——先看 `src/` 与 `app/` 的区别

## 何时不适用

- 用户明确要求"修复 MCP / 装工具 / 分析某个引擎索引"→ 这是环境任务，出本技能
- 用户要改代码 → 出本技能，进代码开发流程（先 impact 后改）
- 用户要看技能市场资源（mybuddyskills-main 等）→ 那是数据目录，单独处理

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
