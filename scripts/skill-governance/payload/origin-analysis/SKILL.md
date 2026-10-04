---
name: origin-analysis
display_name: Origin 数据分析 · Origin Analysis
description: "Use Origin/OriginPro as a local scientific analysis engine: import large datasets inside Origin, choose Origin-native statistics/fitting/signal-processing/plotting workflows, execute them through a persistent broker, and return compact results without pushing whole tables into the model context."
version: 1.1.0
---

# Origin 数据分析 · Origin Analysis

## Intent

把 Origin/OriginPro 当作本地科学计算与绘图引擎，而不是只当 Excel 查看器。AI 负责理解用户的分析目标、选择合适的 Origin 原生能力、组织工作流并读取紧凑结果；大体量原始数据、计算和图形都尽量留在 Origin 内部。

## Trigger

Use this skill whenever the user wants AI to use Origin/OriginPro for experimental-data analysis, large-table analysis, statistics, plotting, fitting, signal processing, peak/baseline analysis, calibration, compensation, correlation, FFT, or other Origin-native analysis.

Positive examples:
- 用 Origin 打开这个 Excel，别让 AI 自己读文件，帮我分析
- 帮我看 Origin 当前工作表有哪些列
- 这几万行数据让 Origin 自己算，你只拿结果
- 把两路静电信号做互相关，找时间延迟
- 对这一列做 FFT，看主频
- 做 Savitzky-Golay 平滑，再叠加原始曲线
- ppm 和电容做线性标定，给我斜率、截距和拟合质量
- 看温度和测量值有没有相关性，能不能做温度补偿
- 自动找峰、峰宽和峰面积
- 判断哪些是真信号，哪些是基线

## Boundary

Do not invoke this skill for unrelated spreadsheet editing, generic coding, or when the user explicitly chooses another engine such as MATLAB or Python.

Negative examples:
- 直接用 pandas 把 Excel 全读出来分析
- 帮我修改 Excel 单元格格式
- 用 MATLAB 做 FFT
- 写一个网页折线图
- 只解释 Origin 菜单是什么意思，不需要控制软件
- 帮我安装 Origin

Important boundaries:
- User instructions override this skill.
- If the user says “不要读文件 / 不要自己打开 Excel”, do not use pandas/openpyxl/file-content tools on the source. Pass the path to Origin and let Origin import it.
- Do not infer physical meaning from column names alone.
- Do not invent Origin commands. If syntax is uncertain, consult `references/origin-capabilities.md`, Origin help, or authoritative Origin documentation before executing.
- Do not create a fresh COM object for every action. On this machine, repeated short-lived COM create/release was reproduced to spawn `Origin64.exe -Embedding` and crash when the client released it.
- Do not use generic LabTalk for filesystem/process/shell operations unless the user explicitly asked for such behavior. Generic LabTalk is for Origin-side data analysis and visualization.
- **Runtime self-modification is forbidden.** During a normal Origin analysis task, treat this entire Skill package (`SKILL.md`, `references/`, `scripts/`, `templates/`, `evals/`, metadata) as read-only. Do not hot-patch the broker/client or rewrite the Skill to make one request pass. Only modify this Skill when the user explicitly asks to review, repair, upgrade, or edit the Origin Skill itself.

## Capabilities

For analysis beyond import/status/headers/stats, read references/origin-capabilities.md. Capability families and intent examples: [references/capability-overview.md](references/capability-overview.md).

## Execution Model

There are three execution levels.

### Level A — Fixed helper actions

Use `scripts/origin_tool.ps1` for common deterministic operations:

```text
status        -> current Origin book/page/rows/cols
import        -> let Origin import a file
headers       -> get compact column names
stats         -> N/mean/SD/min/max for one column
plot          -> simple line plot
corr          -> Pearson correlation for two columns
scatter       -> XY scatter/line+symbol relationship plot
capabilities  -> broker protocol/capability summary
ping          -> broker health
```

Examples:

```powershell
origin_tool.ps1 -Action status
origin_tool.ps1 -Action capabilities
origin_tool.ps1 -Action import -FilePath "C:\data\test.xlsx"
origin_tool.ps1 -Action headers -HeaderRow 3
origin_tool.ps1 -Action stats -Column 11
origin_tool.ps1 -Action corr -ColX 3 -ColY 11
origin_tool.ps1 -Action scatter -ColX 14 -ColY 3
```

### Level B — Origin-native X-Functions through `labtalk`

For analysis that Origin already supports but has no fixed helper action, use the persistent broker's generic Origin command path:

```powershell
origin_tool.ps1 -Action labtalk -Script '<Origin LabTalk / X-Function command>'
```

If numeric or string results are stored in LabTalk variables, request only those compact values:

```powershell
origin_tool.ps1 -Action labtalk `
  -Script 'fitLR iy:=(wcol(1),wcol(2)) a:=__a b:=__b r:=__r pts:=__n;' `
  -Vars '__a,__b,__r,__n'
```

#### Quoting

Nontrivial LabTalk must use a UTF-8 `-ScriptFile`. Before inline `-Script`, read [references/origin-automation.md](references/origin-automation.md).

### Level C — Multi-step Origin workflow

For real engineering analysis, do not force the task into one command. Compose several Origin operations and verify each stage.

Example: “判断真信号和基线”

```text
headers
  ↓
identify Base Signal / Baseline / candidate state channels
  ↓
create/analyze DeltaSignal = Base Signal - Baseline
  ↓
distribution + quantiles
  ↓
time-aligned plots
  ↓
correlation / segmented statistics
  ↓
only then decide whether a threshold is defensible
```

Example: “两路静电信号算速度”

```text
confirm time axis / sampling interval
  ↓
corr1 cross-correlation
  ↓
find lag of correlation peak
  ↓
delay = lag × sample interval
  ↓
velocity = sensor spacing / delay
```

Example: “温度补偿”

```text
plot measurement vs temperature
  ↓
correlation screening
  ↓
linear or low-order polynomial fit
  ↓
compare residual/error before vs after compensation
  ↓
if heating/cooling differ, segment hysteresis instead of one global fit
```

## Workflow

1. **Understand the engineering question first**
   - Identify what the user actually wants: visualization, statistics, calibration, noise analysis, correlation, delay, FFT, filtering, compensation, peaks, baseline, etc.
   - Do not start by guessing an Origin command.

2. **Load the capability map**
   - For anything beyond basic import/status/headers/stats, consult `references/origin-capabilities.md`.
   - Route the request to the appropriate Origin capability family and X-Function.

3. **Use the persistent Origin Broker**
   - Normal invocation must not edit or regenerate the broker/client scripts. If an analysis capability is not a fixed helper action, use verified Origin-native `labtalk`; if that still cannot satisfy the task, report the capability gap instead of modifying the Skill.
   - All Origin actions go through `scripts/origin_tool.ps1`.
   - It communicates with long-lived `scripts/origin_broker.ps1` over a local named pipe.
   - Broker V2 owns one `Origin.ApplicationCOMSI` instance for its lifetime.
   - Never bypass it with per-action `Origin.ApplicationSI`, `ApplicationCOMSI`, external `originpro`, or `op.attach()` during normal use.

4. **Load data inside Origin**
   - Let Origin import the source.
   - Preserve original source data.
   - Confirm Origin-side rows/columns/book/sheet after import.
   - If import reports ok but stays on a graph with zero columns, do not run stats or claim success. Through the same broker, use a UTF-8 LabTalk file containing `newbook;` to establish a worksheet, then retry import once and verify the expected N/mean. Never create another COM owner or reset the broker just for this condition.

5. **Discover data structure before analysis**
   - Get column names, units/designations where available.
   - If headers are embedded in worksheet rows, read only the minimal header cells needed.
   - Do not transfer full columns into model context by default.

6. **Choose an execution level**
   - Fixed helper action when sufficient.
   - `labtalk` for verified Origin-native X-Functions.
   - Multi-step workflow for engineering analysis.

7. **Keep computation in Origin**
   - Perform smoothing, FFT, fitting, correlation, peak analysis, statistics, etc. inside Origin.
   - Prefer new output columns/sheets/graphs rather than overwriting imported raw data.

8. **Read back compact results**
   - Prefer parameters and summaries: N, mean, SD, quantiles, correlation, lag, frequency, fit coefficients, R²/fit quality, peak positions/widths/areas, error metrics.
   - Only read raw rows when the user explicitly needs them.

9. **Verify the visible/Origin-side result**
   - `Execute(...) == True` alone is insufficient.
   - Verify workbook/worksheet/graph/result variables.
   - Distinguish programmatic confirmation from what the user has visually confirmed.

10. **Interpret with physical context**
   - Separate data observation from engineering interpretation.
   - Do not turn correlation into causality.
   - Do not create thresholds or compensation formulas unless the data and physical meaning support them.

## Output Contract

For normal analysis, report compactly:

- **Task interpreted as**: e.g. FFT / calibration / baseline classification / temperature compensation
- **Origin capability used**: X-Function/workflow
- **Origin session**: Broker V2 / visible
- **Data handling**: loaded and computed in Origin; whether AI directly read the source
- **Operations performed**
- **Compact results**
- **Engineering interpretation**
- **Verification status**

## Resources

- **Capability map and task routing**: `references/origin-capabilities.md`
- Stable automation rules and known pitfalls: `references/origin-automation.md`
- Persistent COM owner: `scripts/origin_broker.ps1`
- Deterministic broker client + generic LabTalk gateway: `scripts/origin_tool.ps1`
- Reusable compact analysis report: `templates/analysis-report.md`
- Trigger/boundary eval cases: `evals/trigger.json`

`SKILL.md` is the runtime entry point. Load `origin-capabilities.md` whenever the user's request involves analysis beyond the simple fixed actions.

## Shell boundary

MyBuddy ordinary bash/terminal uses Git Bash. This Skill alone invokes scripts/origin_tool.ps1 through an explicit PowerShell backend for Windows COM, .NET Named Pipe and ACL support. Preserve the existing persistent broker and COM owner; never launch a second broker or replace it with Bash/Node.
