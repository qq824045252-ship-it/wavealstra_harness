---
name: projectlibre-gen
description: |
  将任务清单 JSON 转换为 ProjectLibre 可打开的 MSPDI XML 项目文件。纯 Python
  标准库实现，支持任务依赖（FS/SS/FF/SF）、资源分配、概要任务分组、里程碑、
  工作日自动排程。生成后可直接用 ProjectLibre 打开查看甘特图。触发词：项目管理、
  甘特图、ProjectLibre、排程、任务清单、项目计划、project file、.pod、MSPDI。
---

# projectlibre-gen — 任务清单 → ProjectLibre 项目文件

## 什么时候用

- 用户给出**任务清单**（文字/表格/JSON），要求生成可打开的项目文件；
- 需要生成 **ProjectLibre / Microsoft Project** 兼容的 MSPDI XML；
- 用户说"生成甘特图/排一下进度/做个项目计划"；
- 需要从 JSON 数据自动前向排程并输出可视化项目文件。

> 输出格式为 MSPDI XML（`.xml`），ProjectLibre 直接打开，也兼容 MS Project。

## 工具路径

```text
脚本 = "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py"
ProjectLibre = C:\Program Files\ProjectLibre\ProjectLibre.exe
依赖 = Python 3.14+ (uv run)，无第三方库
```

## 使用方法

### 1) 准备 JSON 文件

```json
{
  "name": "项目名称",
  "start_date": "2025-01-06",
  "hours_per_day": 8,
  "resources": [
    { "name": "张伟", "initials": "ZW", "max_units": 100, "rate": "50.00/h" },
    { "name": "李娜", "initials": "LN", "max_units": 100, "rate": "60.00/h" }
  ],
  "tasks": [
    { "id": 1, "name": "需求与设计", "summary": true },
    { "id": 2, "name": "需求分析", "duration_days": 5, "parent": 1 },
    { "id": 3, "name": "原型设计", "duration_days": 5, "deps": [2], "parent": 1, "assignments": ["李娜"] },
    { "id": 4, "name": "UI 设计", "duration_days": 10, "deps": [3], "parent": 1, "assignments": ["李娜"] },
    { "id": 5, "name": "开发阶段", "summary": true },
    { "id": 6, "name": "前端开发", "duration_days": 15, "deps": [4], "parent": 5, "assignments": ["张伟"] },
    { "id": 7, "name": "后端开发", "duration_days": 15, "deps": [3], "parent": 5, "assignments": ["张伟"] },
    { "id": 8, "name": "测试与上线", "summary": true },
    { "id": 9, "name": "测试验收", "duration_days": 7, "deps": [6, 7], "parent": 8, "assignments": ["张伟"] },
    { "id": 10, "name": "上线发布", "duration_days": 0, "deps": [9], "parent": 8 }
  ]
}
```

### 2) 运行命令（Git Bash）

```bash
# 基本用法：生成 XML 并打印排期摘要
uv run --no-sync "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py" input.json

# 指定输出路径
uv run --no-sync "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py" input.json -o output.xml

# 生成后自动用 ProjectLibre 打开
uv run --no-sync "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py" input.json --open

# 指定每日工时（默认 8）
uv run --no-sync "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py" input.json -t 8

# 安静模式（只输出 XML 文件，不打印摘要）
uv run --no-sync "C:/Users/servi/Documents/ProjectLibre-Demo/generate_project.py" input.json --quiet -o output.xml
```

### 3) ProjectLibre 自动打开

`--open` 参数会在生成后启动 ProjectLibre 并加载 XML，可直接查看甘特图。

## JSON 字段速查

### 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 项目名称（默认"未命名项目"） |
| `start_date` | 否 | 开工日期 YYYY-MM-DD（默认今天） |
| `hours_per_day` | 否 | 每日工时（默认 8） |
| `resources` | 否 | 资源列表 |
| `tasks` | 是 | 任务列表（非空） |

### resources[] 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 资源名称 |
| `initials` | 否 | 首字母缩写（默认取 name 前 2 字符） |
| `max_units` | 否 | 最大可用率（默认 100） |
| `rate` | 否 | 标准费率，如 "50.00/h" |

### tasks[] 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 任务 ID（默认按顺序编号，必须唯一且 >0） |
| `name` | 是 | 任务名称 |
| `duration_days` | 否 | 工期，工作日（默认 1，0 = 里程碑） |
| `deps` | 否 | 依赖列表（任务 id 或依赖对象） |
| `summary` | 否 | 概要任务标记（true = 概要任务） |
| `parent` | 否 | 父任务 ID（子任务必须指向概要任务） |
| `assignments` | 否 | 资源分配列表 |
| `start_date` | 否 | 显式开始日期（覆盖依赖计算） |
| `milestone` | 否 | 强制标记为里程碑 |

### 依赖格式

```json
// 简写：只传任务 id（默认 FS 完成-开始，无滞后）
"deps": [1, 2]

// 完整写法：指定依赖类型和滞后天数
"deps": [
  {"id": 2, "type": "FS", "lag_days": 1},
  {"id": 3, "type": "SS", "lag_days": 0}
]
```

依赖类型：
- **FS**（默认）：前序完成 → 后序开始
- **SS**：前序开始 → 后序开始
- **FF**：前序完成 → 后序完成
- **SF**：前序开始 → 后序完成
- `lag_days`：正数 = 滞后，负数 = 提前（单位：工作日）

### 资源分配格式

```json
// 简写：资源名字符串（默认 100% 投入）
"assignments": ["张伟", "李娜"]

// 完整写法：指定投入比例
"assignments": [
  {"resource": "张伟", "units": 50},
  {"resource": "李娜", "units": 100}
]
```

## ⚠️ 分组强制规则

**所有任务必须有明确归属**，否则脚本报错：
- 概要任务：加 `"summary": true`
- 子任务：加 `"parent": 概要任务id`
- 概要任务不能有 parent
- 概要任务的日期/工期由子任务自动聚合

```
❌ 任务"需求分析"未归属任何概要任务
✅ { "id": 2, "name": "需求分析", "parent": 1 }
✅ { "id": 1, "name": "需求与设计", "summary": true }
```

## 排程规则

- **工作历**：周一至周五为工作日，周六日跳过
- **前向排程**：从项目开工日开始，按依赖关系依次推算
- **显式开始日期**：设置 `start_date` 的任务会从指定日期开始
- **里程碑**：`duration_days: 0` 的任务，结束时间 = 开始时间
- **关键路径/时差**：由 ProjectLibre GUI 内计算

## 产物说明

```text
{项目名}.xml    MSPDI XML 文件，ProjectLibre/MS Project 直接打开
```

同时会在控制台打印排期摘要表格：

```
项目: 网站改版项目    开工: 2025-01-06    每日工时: 8h
输出: C:\...\网站改版项目.xml

ID  任务                    工期(d)    开始          结束          分配
1   ▸ 需求与设计               20       2025-01-06  2025-01-31  -
2     需求分析                5        2025-01-06  2025-01-10  -
...
项目完工: 2025-03-05
```

## 已知限制

1. **日历**：仅支持标准周一-周五工作历，暂不支持节假日排除；
2. **资源冲突**：不检测同一资源在并行任务上的过载（由 ProjectLibre 内部处理）；
3. **层级**：仅支持两级结构（概要任务 → 子任务），不支持多层嵌套；
4. **输出格式**：仅 MSPDI XML，不直接输出 `.pod`（ProjectLibre 原生格式），但 XML 可正常打开和保存为 `.pod`。

## 验证过的行为（2026-08 实测）

- 10 任务（含 3 概要）+ 2 资源，生成 XML 并 ProjectLibre 打开 ✅
- 依赖关系（FS）自动排程正确，跳过周末 ✅
- 里程碑（duration=0）标记正确 ✅
- 资源分配在 ProjectLibre 内显示正确 ✅
- 概要任务日期由子任务聚合自动计算 ✅

## Boundary / Output Contract

普通待办清单、纯文字周计划不强制生成 MSPDI；需要可打开项目文件时触发。交付 XML、资源/依赖与排程摘要；保留用户日历/工期假设，缺关键事实先澄清，结构生成不等于软件已打开验证。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
