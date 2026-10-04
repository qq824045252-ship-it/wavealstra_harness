---
name: matlab-r2025b
description: 使用本机 MATLAB R2025b 直接完成工程数值计算、信号处理、FFT/PSD、滤波、拟合标定、参数扫描、仿真、Simulink 与算法验证；仅在明确需要 MATLAB/Simulink 或其数值/建模能力时触发，不经 PC MCP/PC Bridge 中转。
version: 1.0.0
---

# MATLAB R2025b 工程分析

## Intent

把需要 MATLAB/Simulink 的重复工程分析任务，稳定地交给本机 MATLAB R2025b 直接执行，并返回可核验的数值结果、方法、检查项和必要产物。

## Trigger

当任务明确需要 MATLAB/Simulink，或明显受益于 MATLAB 的数值、信号、控制、拟合、仿真能力时使用本 Skill。

正例：
- “用 MATLAB 2025b 分析这组 16.7 Hz 采样数据，先看频谱再设计滤波。”
- “用 Simulink 验证这个锁相/IQ 算法，看看响应时间和噪声折中。”
- “把这组 KF 与传感器原始值用 MATLAB 做标定和温度补偿。”

## Boundary

以下场景不要触发本 Skill：

- 简单四则运算、普通代码编写、纯文本解释，不需要 MATLAB。
- 用户明确要求只用 Origin、Excel 或其他指定软件完成任务。
- 用户在排查 PC MCP / PC Bridge / `matlab_exec` 工具本身是否工作；那是工具链/Bridge 调试，不是 MATLAB 工程分析。
- 任务只要求生成 MATLAB 代码片段而不需要本机执行时，可直接写代码，不必强制调用本机 MATLAB。

负例：
- “帮我解释一下 FFT 是什么。”
- “通过 PC MCP 看一下 matlab_exec 为什么没出现在工具列表。”
- “只用 Origin 打开这个 Excel，不要 MATLAB。”

## Workflow

1. **明确任务**：先确定输入数据、单位、采样率/时间基准、目标输出和成功判据；未知的关键业务事实先检查或明确说明，不编造。
2. **选择直接执行方式**：优先使用 `scripts/matlab-run.mjs`，由 MyBuddy Git Bash 通过 Node（shell:false）直接调用 `C:\Program Files\MATLAB\R2025b\bin\matlab.exe`。禁止为了本 Skill 绕到 PC MCP、PC Bridge 或 `matlab_exec`。
3. **组织 MATLAB 代码**：短任务可直接传 `--code`；复杂任务优先把可复用逻辑写成项目内 `.m` 脚本/函数，再用 `--script` 执行，避免长命令和引号错误。
4. **保持原始数据**：原始数据不覆盖；清洗、滤波、补偿、拟合结果使用新变量或新文件。文件读写应以用户指定项目目录为 `cwd`。
5. **工程计算**：按任务选择 FFT/PSD、数字滤波、IQ/锁相、拟合标定、参数扫描、仿真、Simulink 等流程。需要具体流程时读取 `references/workflows.md`。
6. **数值验证**：至少做与任务匹配的一项检查，例如维度/单位、Nyquist、残差、RMSE、频响、稳定性、边界值、已知点或前后对比。代码无报错不等于算法已验证。
7. **控制输出**：不要把大数组全部打印到对话；大结果保存为 `.mat` / `.csv` / `.m` / `.fig` / 图片，并在回复中给关键数值摘要。
8. **交付**：按 `templates/engineering-result.md` 的结构简洁汇报结果、方法、检查、产物和必要假设。

## Resources

- `references/tooling.md`：本机 MATLAB R2025b 路径、直接调用方式、Python 3.12 / MATLAB Engine 的可选使用边界。
- `references/workflows.md`：FFT/PSD、滤波、IQ/锁相、低速仪表数据、标定补偿、仿真、Simulink、嵌入式算法流程。
- `scripts/matlab-run.mjs`：MyBuddy 本机直接调用 MATLAB R2025b 的确定性封装；优先使用。
- `templates/engineering-result.md`：工程分析结果的简洁输出骨架。


## Output Contract

交付数值、单位、方法、检查项与绝对产物路径。原始数据不覆盖；MATLAB 退出成功不等于数值正确。输入/许可/工具箱失败时保留错误并报告阻塞，禁止伪造计算结果。短代码临时文件自动清理，项目脚本保留以便复现。
