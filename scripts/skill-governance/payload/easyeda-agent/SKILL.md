---
name: easyeda-agent
description: "Community EasyEDA Agent automation skill for EasyEDA Pro schematic and PCB work through the local easyeda-agent CLI/daemon/connector. Use when designing a board from scratch; inspecting, cleaning up, or safely refactoring an existing wired schematic; arranging multi-page functional modules; drawing page-scoped module frames and text labels; preserving and reconciling pin-to-net topology; placing/wiring real LCSC/JLC library parts; syncing schematic changes into PCB; laying out PCB components; running EasyEDA DRC/check/bridge-check/layout-lint; exporting BOM/netlists/artifacts; querying the embedded circuit-block library (`easyeda blocks ls/show/search`); or applying the bundled EasyEDA design workflows and conventions. 覆盖嘉立创EDA专业版原理图/PCB、混乱原理图整理、多页功能分区、框选文字标注、布线、铺铜、板框与机械门禁。适用于嘉立创EDA(JLC EDA / JLCEDA / LCEDA / EasyEDA Pro)与立创商城(LCSC)元件的电路板设计自动化。"
license: MIT
compatibility: "Requires the local easyeda-agent CLI and daemon (macOS/Linux/Windows) plus the EasyEDA Agent Connector extension installed in EasyEDA Pro with 'Allow external interaction' enabled. Bundled scripts need Python 3. Network access is needed only for LCSC part lookup and self-update."
metadata:
  author: zhoushoujianwork
  version: "1.3.0"
  homepage: "https://github.com/zhoushoujianwork/easyeda-agent"
---

# EasyEDA Agent

Use the local `easyeda` CLI and daemon to operate EasyEDA Pro through typed,
observable actions. This is the community `easyeda-agent` workflow, not an official
EasyEDA skill; the suffix is intentional so users can distinguish it from upstream
EasyEDA tooling.

CLI/daemon and the EasyEDA connector must already be connected. If missing or mismatched, read [references/installation.md](references/installation.md); normal tasks do not reinstall or upgrade them.

> **MCP 可选入口:**若当前 agent 暴露 `easyeda_*` MCP tools,可优先用它们完成 health、
> action discovery、typed calls、blocks 和 workflow 操作。MCP 只是同一 CLI/daemon 的
> stdio 适配层;下方全部铁律、inspect-before-mutate、阶段门和存盘要求保持不变。

## Windows runtime

Ordinary easyeda commands use Git Bash. Read this reference for daemon startup, connector upgrades or health failures. The existing daemon .ps1 launcher alone uses an explicit PowerShell backend: [references/windows-runtime.md](references/windows-runtime.md).

## ① 铁律(不可违反)—— 抗遗忘扫读区

扫读式硬约束,任何模式都不问用户、不商量。违反 = 返工或坏板。每条带 `→` 指到细节文件。

1. **窗口操作前先 `easyeda health`** — 否则打到错窗口 / 无连接器;它带 `versionGate` 判定块,**版本错位时后续动作当场被拒**(拒绝消息自带修法;明知故犯:`--skip-version-check` / `EASYEDA_SKIP_VERSION_CHECK=1`,会写审计)。撞门先对版本,别怀疑电路或工具坏了。→ environment-setup.md §0.5

   **多窗口消歧(Windows 常驻 3+ `lceda-pro` 进程):**
   `health` 的 `found.raw.windows[]` 条目数 ≥ 2 时,`--project` 消歧失效,**所有 typed action 必须显式加 `--window <windowId>`**,否则 CLI 报 "N windows connected" 拒绝执行。`--window` 必须从 health 返回值中匹配目标工程/文档，不能随便选第一个。
2. **只用 typed `easyeda` action** — 只有无对应 typed action **且**用户明确接受 debug 路径时才 `debug.exec_js`。
3. **mutate 前先 inspect** — 放/移/连/同步/存之前先读 doc/页/器件/引脚/板层/网络/规则,别盲改;破坏性操作(clear/delete/bulk import)先确认。
4. **无图纸不摆放/布线** — 找不到 sheet 立即停,让用户建/批准 A4(默认 A4)。→ design-flow S1
5. **PCB mutation(rip-up/route/delete/via/track)后先 `easyeda doc reload` 再读/判/DRC** — **机械强制**:不 reload 就读,daemon 直接拒(`STALE_READ`)并告诉你下一步该跑什么;同网 Connection Error 暴增先 `pour-rebuild`,不是真断。**正常修法永远是 `doc reload`**;确需读旧状态才用逃生口 `--force-stale-read "<理由>"`(入审计、只放 PCB 读、解不开布线门;**不是** `--force`——那是布线阶段门)。→ pcb.md「PCB mutation → doc reload 门」
6. **判对错只看 `list/check/drc/layout-lint/layout-score`,不看截图** — 截图会 stale/blank;data 有内容但截图空 = 窗口没渲染(切前台),不是设计错。(`layout-score` 是**诊断视角不是门**——门只有 `layout-lint --gate` 一个;且它的 `skipped` 维是「没测」不是「满分」。)`pcb drc/check` 这类重画布计算**需 PCB 在前台**,超时=切前台**单发一次、绝不循环重试**(重发被 `ACTION_BUSY` 拒)。**录制/演示模式例外**:截图变交付物 → design-flow 录制/演示模式。
7. **每过一个阶段门显式 `save`(sch/PCB)** — place/wire/modify 只改内存,autosave 只兜底;整板每 ~10 件 save 一次。→ design-flow S 段 💾
8. **手工连任何已知外围前先查块库 `easyeda blocks`**(离线,无需 daemon/窗口)— `blocks ls` 看全量,照抄验证过的块只重绑端口。**查不到 → 起草 `block-gap` issue;块用出问题(脚名不符/拓扑错/停产)→ 起草 `block-bug` issue 带证据 —— 都必须经用户确认后才 `gh issue create`,绝不自动上报**。→ ② 块地图速查 · standard-blocks-contributing.md §七
9. **netflag 必须经真 wire 连、离 pin 非零距** — 重叠坐标 EasyEDA 不认作连接;禁零长 wire;多脚同名 pin 要全连(如多 GND、AMS1117 双 VOUT)。→ schematic.md
10. **RF/天线 keepout 覆盖每一层** — top+bottom no-copper + 内层 no-inner-electrical;top-only 会被底层 pour 灌到失谐。→ pcb-routing.md「Keep-out / rule regions」
11. **丝印每个标记落在器件本体/courtyard 之外、装配后不被遮** — 端子塑料罩/卡座壳/按键帽会盖住 footprint 内的丝印 = 等于没标。→ design-flow P9
12. **禁用 `eda.sch_Netlist.getNetlist()`**(已废弃、悬空脚挂死)— 网表走 `sch read/check/netlist/export`;raw 路径不得已才 `getNetlistFile()` 读 `File.text()`。→ schematic.md / actions.md
13. **电气 clearance ≠ 手焊可达性** — P2 先持久化装配档案:`pcb stage set-assembly --profile hand-solder`(默认/下限40mil;大焊盘烙铁通道60mil);`layout-lint --gate` 有任何 tight pair 即失败,任何器件四面被围、无一侧 ≥60mil 烙铁通道(no-access)也失败;未过门不得确认布局。→ design-flow P2/P6 · issue #99
14. **阶段门禁机械强制,不必预读细则** — 布线前、布线后各一道门,未过一律被拒(daemon 在 /action 层也拦,raw 调用绕不过)。撞上去的拒绝消息**自带下一条该跑的命令**,照做即可。切入/恢复会话:`workflow status --reconcile` → `workflow advance`。→ design-flow P6(含 force 分级 #132)/P10
15. **原理图必须分页分区 + 每模块电路说明,默认必做**(「最小/单页」不是借口)— ①分页(页名=功能名)②`sch zones set`+`zone-draw` 画区框(**单页小板也要画**)③每模块 1~3 行 `sch note`。⚠ 手工 `block-apply`/`sch place` **不自动画框**,必须补 ②③。机械兜底:`sch check` 的 `missing-partition` + `sch gate --strict` 会挡下。→ design-flow S1–S3
16. **「探出图纸」≠「比图纸还大」** — 前者挪一挪能解;后者(`page-too-small`)挪多少次都没用,必须换手段,且**分页是设计决策 → 停手问用户**(工具不自动分页)。别人肉重试:`--max-attempts`(默认 3)会替你停手。→ design-flow S3
17. **S0 先于任何放置** — spec 必须在首个 `page-new` / `place` / `block-apply` 前落盘并通过 `easyeda spec validate --strict`;先画后补只能算记录,不能证明设计决策已冻结。→ design-flow S0

## Stage routing

Before schematic/PCB work, read the current stage in references/design-flow.md and this stage checklist (S0/spec, milestone approvals, assembly/edge orientation, placement tiers, P7 critical-net locking and native-router settings). Keep all stage gates: [references/stage-quick-reference.md](references/stage-quick-reference.md).

## ③ 顺序硬约束(反了必返工)

每条带 `→` design-flow 锚点;这些是**同级铁律级**的强顺序约束,散在深处易漏,汇总于此:

1. **摆放过 assembly+routability gate 前不布线**(手焊先持久化 profile;`layout-lint --gate` 必须 0 tight)→ design-flow P2/P6
2. **P6 可布性门在 P7 布线之前**(≥目标分、0 overlap、ratsnest 可控)→ design-flow P6
3. **P7.0 电源/差分先布并 `track-lock`,再交自动布线**(见上方 P7 迷你清单)→ design-flow P7.0
4. **禁布区 / 丝印(P4/P5)在布线 P7 之前**(布完再加会逼返工重绕)→ design-flow P4/P5
5. **改层数 / `outline-fit` 在铺铜布线之前** → design-flow P8
6. **PLANE 先铺 SIGNAL 再翻;PLANE 翻好后禁打异网 via**(官方缺陷 #32 不挖 anti-pad、`pour-rebuild` 不补救;换层先删 via 走外层,`pcb check via-crosses-plane` 会标出)→ design-flow P8
7. **布完必过 post-route check 门再进丝印/交付**(`workflow advance` 跑 pcb check,ERROR/power-not-poured/width-under-spec 清零才过;WARN 挂着不处理曾致 5V 细线违规漏到人工评审才被抓)→ 铁律 14

## What To Read(加载触发索引 —— load-more)

按走到的场景/阶段**按需**读对应 reference(渐进式披露),别预加载全部:

- `health` 显示 `windows: []` / `NO_CONNECTOR`,或改了连接器(`extension/`),或
  **版本对不齐**(`connectorVersionOk:false`、`UNKNOWN_ACTION`、用户问「怎么升级」):读
  `references/environment-setup.md`(§0.5 用 `easyeda update --check` 一次看清 CLI/skill/连接器三方版本)。
  web 编辑器(`pro.lceda.cn`)+ chrome-devtools MCP 时
  agent 可自举全环境;**桌面客户端 chrome-devtools 够不到窗口,需用户手动开/切工程**(连接器照常附着,typed action 一样)。
- **整板 / 从零 / >~10 件,或走到某阶段拿不准**:先读 `references/design-flow.md`(流程脊柱 S0–S6 / P0–P10,顶部有阶段 TOC)。含 S0 事前摸底子步 `references/design-pre-analysis.md`(轻量摸底,可选、非门禁)。**S0 方案书 spec 写完必跑 `easyeda spec validate`(无 ERROR 才算过门,`--strict` 交付前用)**——字段形状(含 `flow`/`modules[].kind`/`interfaces[].ref·edge·facing·internal`)在 design-flow S0。
- **布线阶段(P7)选档 / 关键网先行 / 自动布线对话框清单**:读 `references/design-flow.md` **P7 三档阶梯**——别停在 `pcb-routing.md` 的命令手册(那里只给命令,布线档默认在 design-flow)。
- 架构权衡坑(真选择,非唯一答案——叠层、地策略、接口取向、成本档、单/双面、焊接工艺):读
  `references/design-decisions.md`;S0 从中产出方案书让用户确认。(RF/天线 keepout 是 guardrail 铁律 10,不进这张决策表。)
- **Schematic work**:先读 `references/schematic.md`(入口:器件放置 / Actions 目录 / 电气铁律 /
  guardrails)。**按需再读**——不要一次全拉:连线细则 → `references/schematic-wiring.md`;
  摆放命令(三层布局体系 / autolayout / autoplace-free)→ `references/schematic-placement.md`。
- **混乱/已连线原理图整理、多页高质量布局、功能框和文字标注**:同时读
  `references/design-flow.md` 的 S1–S6、`references/auto-layout-sop.md` 的
  “已连线页安全整理”，以及 `references/schematic-placement.md` 的 “Functional frames +
  text labels”。先保存 pin→net/NC 黄金表，任何布局重构后必须逐页对账。
- **PCB work**:先读 `references/pcb.md`(入口:「块的 PCB 约束(先查)」+ 坐标系 + Workflow +
  `doc reload` 门 + guardrails + 命令目录)。**按需再读**——不要一次全拉:动铜(布线 / 过孔 /
  铺铜 / 禁布区 / 填充区域)→ `references/pcb-routing.md`;摆放(sch→PCB 同步 / 器件 CRUD /
  align·distribute·grid-snap / 板框 / 自动布局)→ `references/pcb-layout.md`。
- 查任一 typed action 签名、或 >5 步批量操作要用 playbook(`easyeda apply`):读 `references/actions.md`。
- **DRC / 制造规则地板与 fallback**:读 `references/fab-rules-jlcpcb.json`(live `pcb.drc.rules` 优先,此表作 fallback seed + clamp floors,**永不发出低于 manufacturingMin 的 track/via/gap**)。
- **初级常见问题 / UI 排障**(库更新后符号变化、网络名显示/匹配、选择过滤、丝印/图层不可选、位号 `?`、过孔重叠、铺铜与填充区域混淆、规则导入覆盖、工程/浏览器/考试流程):读 `references/beginner-troubleshooting.md`。其中槽孔尺寸是培训经验值,必须与 live 制造规则比较并取更严格者；考试条目只用于考试场景。
- **PCB 设计规范手册(人读正本)**:`references/pcb-design-rules.md`——线宽阶梯/过孔/布局/走线/铺铜/Mark点/拼板/丝印/叠层/DRC 三级清单;`pcb check` 报错信息里的 `[规范 §N]` 即指此手册章节,照章修。
- New/uncertain raw `eda.*` API:先 `easyeda api search/show`,再查官方 prodocs 参考页(方法为 `@alpha`/`@beta`/`@deprecated` 或有已知 upstream issue 时),把 caveat 记进 references 再固化成工作流。
- Schematic 布局规则:读 `references/schematic-layout-conventions.md`。
- PCB 摆放/布线规则:读 `references/pcb-layout-conventions.md`。
- CLI 摆放/布线硬坑 + auto-layout/autoconnect SOP:读 `references/auto-layout-sop.md`。
- 器件选型、JLC/LCSC 排名与标准化:读 `references/part-selection.md`(选型前**先查块**,块 `parts` 已固定标准外围选型)+ `references/standard-parts.json`。已放置件**换型号**用 `easyeda sch replace --id <pid> --lcsc <C号>`(pinDiff 非空须重接线)。
- **电路块库**:`easyeda blocks ls/show/search`(离线,详见铁律 8 + 块地图速查);贡献一个新块见
  `references/standard-blocks-contributing.md`(验证过的外围回流入库,署名 + `validated` 门)。
- Netflag/netport 旋转真值:用 `references/orientation.json`;never hand-edit 派生的旋转表。
- 图纸/标题栏几何约定:读 `references/sheet-templates.json`。

## Bundled Scripts

Scripts live in `scripts/` and are intended to be run directly when useful:

- `scripts/lint.sh <project>`: live schematic lint with optional diff baseline.
- `scripts/tests/run.py`: linter rule-trust harness; run after changes to
  `orientation.json`, linter rules, fixtures, or connector orientation facts.
- `scripts/bom-enrich.py <bom.tsv/csv>`: fill EasyEDA BOM Supplier Part values from
  `standard-parts.json`.
- `scripts/parts-add.py`: append resolved library parts into `standard-parts.json`.
- `scripts/parts-select.py`: deterministic part-selection helper.
- `scripts/calibrate.js`: live bbox calibration for netflag/netport orientation after
  importing a new connector build.

(电路块库的浏览/查找是离线 CLI `easyeda blocks`,不是 `scripts/` 脚本;块校验是 Go 测试
`go test ./internal/blocks/`,跟 `make test`/CI 跑。)

## Deliverables

Summarize changed primitives, commands run, DRC/check/lint status, saved checkpoints,
and artifact paths. If a gate cannot pass, stop at the failing data, explain the next
repair step, and do not claim the design is complete. 录制/演示模式下,额外列出每张阶段图并
标注 **native EasyEDA 截图** 或 **data-rendered 图**,显式报告任何 stale/替换帧。

**PCB 交付摘要额外必报布局质量(#167)**——只报一个综合分等于什么都没说:
① **逐维分**(九维各自 0-100 + 加权综合 + verdict);② **每个弱维「是哪几个器件拉低了它」**
(`pcb layout-score --all` 的归因,`penalty` 就是「先动谁」的排序);③ **`N skipped` 及其原因**
——skipped 是「没测」不是「满分」,不写出来就是把 7 维体检报成全面体检;
④ `blocking[]`(短路/重叠/出板框)必须是 0,非 0 就停在失败数据别宣称完成。
`degraded` 维(compact / rf 恒为 degraded)要连同降级理由一起报,别把近似当实测。

**收尾回流(块库共建)**:若本板含**手工搭建且已跑通 `sch check` + DRC=0 / 网表逐网核实**的标准外围(库里没有的),
按 `references/standard-blocks-contributing.md` 顺手回流一个块(署名 + `validated` = 本次证据)——验证刚过正是入库时机,
**一次设计同时是一次贡献**。

## Boundary

EasyEDA Pro 的原理图/PCB 操作属于本 Skill；epro → KiCad 迁移交给 epro2kicad，现有 KiCad 工程交给 kicad-design，场求解交给 ansys-simulation。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
