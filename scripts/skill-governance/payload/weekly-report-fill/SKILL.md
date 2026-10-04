---
name: weekly-report-fill
description: 周报系统 AI 填表工作流。当用户提供文件/聊天记录/口头材料，要求生成可导入周报系统的 JSON 时使用。原子能力：提取材料文本 → 按规则分段 → 调用 build_report_json.py 产出 _exports/周报_第N周_待导入.json。
---

# 周报 AI 填写工作流

用户**不手填**周报，而是把原始材料（文件 / 聊天记录 / 文本）丢给 AI，由 AI 解析并产出符合结构的待导入 JSON，用户再导入。本技能固化这一流程，保证每次一致、可复用。

## 何时触发
- 用户说「把这段聊天记录填进周报」「解析这个文件生成周报 JSON」「帮我填第 N 周」等。
- 用户引用 `_exports/` 下的备份或待导入 JSON，要求生成/补全内容。

## 工具位置（项目内）

已核实本机项目：C:/Users/servi/Desktop/周报系统。先定位用户指定的周报项目；本机默认从该目录执行，不要在 MyBuddy 仓库直接找 tools/。

```bash
cd "$HOME/Desktop/周报系统"
uv run --no-sync tools/build_report_json.py --help
```
- `tools/build_report_json.py` —— 把「紧凑填法 spec」转成合规待导入 JSON。
- `tools/extract_input.py` —— 把 docx/pdf/txt 等材料提取为纯文本供解析。

运行方式（项目内已配全局 venv，离线用 `--no-sync`）：
```
uv run --no-sync tools/extract_input.py 材料.docx
uv run --no-sync tools/build_report_json.py --spec spec.json
```

## 工作流（严格按序）

### 1. 确定目标周与范围
- 从用户指令解析：`weekNum`（必填）、`year`（默认 2026）。
- **范围规则**：用户说「填到周X」= 只填周一到周X，其余天不放进 spec。用户没说具体天，按材料里的日期推断。
- 若材料里出现具体日期，结合基准（2026 W1 周一=2026-02-23 北京）换算到对应周与星期。

### 2. 提取材料文本
- 若输入是文件且为 docx/pdf：先 `extract_input.py` 提取纯文本。
- 若是 txt/md/聊天记录文本：直接读取（大文件可用 `--max-chars` 预览，但尽量读全）。
- 若是图片/截图：用图像读取能力提取文字后再走本流程。

### 3. 分段解析（核心 AI 工作）
把材料按「天 → 时间段(slot)」拆解。规则（来自 AGENTS.md）：
- **一个材料/对话对应一天**，7 个 slot 拆该主题的不同环节，按时间顺序排列。
- **project**：精简中文项目名，例 `MFM4000静电传感器现场调试`、`甲苯微量水分在线测量比对验证结题报告(北京中石化催化剂)`、`珠海联邦项目`。
- **content**：写具体技术动作，不要虚话。例 `指导屏蔽线拉出焊至铁壳体` 而非 `处理屏蔽问题`。
- **issues**：记录遇到的问题。例 `信号值800+pA，正常应约10pA`。
- **verification**：记录验证结果。例 `拔掉充电器后信号降至250pA`。
- 每格 content 控制在 50–100 字，简洁明确。
- 空格子也在 spec 里写全（project/content/issues/verification 为空），保证结构完整。

### 4. 写 spec 并生成 JSON
写 spec JSON（UTF-8），示例：
```json
{
  "weekNum": 21,
  "year": 2026,
  "author": "罗洪彬",
  "days": {
    "monday": {
      "slot1": {"project":"MFM4000静电传感器现场调试", "content":"指导屏蔽线拉出焊至铁壳体", "issues":"信号值800+pA，正常应约10pA", "verification":"拔掉充电器后信号降至250pA"},
      "slot2": {"project":"MFM4000静电传感器现场调试", "content":"复核接地电阻，要求<4Ω", "issues":"", "verification":"接地阻值2.1Ω合格"}
    }
  }
}
```
- slot 也支持简写：直接给字符串即视为 content。
- 运行 `build_report_json.py --spec spec.json`，自动：
  - 计算 startDate（按 weekNum/year，UTC）与每天 date；
  - 补全 7 天 × 7 slot 全空结构；
  - 生成 slot id、createdAt/updatedAt；
  - 输出到 `_exports/周报_第N周_待导入.json`。

### 5. 交付与导入提示（关键安全约束）
- 告诉用户输出路径。
- **必须提示**：用 app「设置 → 增量备份」(合并导入)，**不要**用「恢复备份」(覆盖导入)——
  「恢复备份」会清空其它周数据。增量备份只把文件中**非空的 slot** 合并进现有数据，安全。
- 若用户明确要求覆盖，再说明风险后由其确认。

## 结构速查（详见 周报备份结构解析.md）
- 顶层：`version / exportTime / settings / weeks`
- `weeks["2026_week_N"]`：`weekNum / year / startDate / dailyRecords`
- `dailyRecords[星期]`：`date / records`
- `records[slot1..slot7]`：`id / project / content / issues / verification / createdAt / updatedAt`
- 全 UTC 时间；app 导入时按 weekNum/year 重算 startDate（JSON 里的 startDate 仅供参考）。

## 注意事项
- 生成的 JSON 必须含 `weeks` 且至少 1 周，否则 app 报「格式错误」。
- 周 key 必须是 `2026_week_N` 形式。
- 不要伪造用户没提供的细节；材料里没有的内容留空。

## Boundary / Output Contract

仅生成周报系统可导入 JSON；普通文字摘要无需进入此 Skill。交付目标周、spec 与 _exports JSON，保留原材料依据；不自动导入或提交，缺事实标待确认。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
