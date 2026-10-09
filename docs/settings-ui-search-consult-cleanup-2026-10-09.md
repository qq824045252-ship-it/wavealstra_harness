# 设置菜单瘦身：联网搜索控件与多模型会诊文案（0.1.22）

面向「工具能力」这一设置页：联网搜索的配置控件此前被塞进能力行的中间列，在 ~734px 宽的设置弹窗里只剩 ≈365px；19 家搜索供应商卡片在 2 列网格里换行、并被 `max-height:224px` 的内嵌滚动条截断。多模型会诊则在设置菜单里堆了成段说明。本次把控件改成整行、把说明按「设置菜单」标准裁剪。

结构对比见 [diagrams/settings-row-layout.svg](../diagrams/settings-row-layout.svg)。

## 改动

### 联网搜索（`SearchSettings.tsx` / `SearchSettings.css`）

- 控件改为「标签 + 控件」两段式行：`搜索方式` 独占一行；供应商网格整行铺开（实测 682px）。
- 供应商默认只列 **已配置 ∪ 已选中**，其余折叠为「显示未配置的 N 家供应商」；展开后仍是同一网格，无内嵌滚动条。
- 状态文案 `已配置 · 待实际调用` → `已配置` / `未配置`（已配置为强调色，未配置为 muted）；卡片名称超长省略并带 `title`。
- 数量提示合并到「供应商」行右侧：`已选 3 / 6 · 至少 2 家`。
- `按顺序失败回退` 的顺序列表改显示供应商名称（原来直接显示 provider id），序号 + 上移按钮。
- 核验勾选行压缩为一行（`最多 5 页 · 更慢更贵`），完整成本说明移入 `title`；`等待与调用上限` 默认折叠。

### 能力行布局（`CapabilitiesTab.css` / `CapabilitiesTab.tsx`）

- `data-capability-id="web"` 的行改为 `grid-template-areas: "copy actions" / "control control" / "detail detail"`，控件区占满整行并增加 12px 上间距。
- `CapabilityRow` 的 `description` 变为可选：没有描述时不渲染说明行。
- 搜索行描述缩短为 `同时搜索 N 家供应商` / `选择检索方式与供应商`。
- 移除「多模型会诊」分组副标题与该能力行的描述文字。

### 多模型会诊（`MultiModelConsultSettings.tsx` / `BuiltinCapabilityRuntime.ts`）

删除的成段说明：

- 「仅通过主模型显式工具调用。输入框「+」可为当前消息指定会诊，不自动触发或持续开启。」
- 「不同模型独立处理同一任务，当前主模型综合。没有 Judge 或多层调度。」
- 「限制都是可调的：只读工具预算填 0 表示不限制……参与数量不设上限，每个参与者都会独立计费。」
- 「任务、补充材料及读取到的文件内容会发送给所选模型供应商。模型只读……」
- 运行时长句 `已配置 5 个参与者……检查配置不会产生模型费用。` → `5 个参与者 · 4 个模型。`
- 「添加模型（由你明确选择；同一模型可加不同思考等级）」→ `添加模型`；参与者副标题不再追加「· 同一模型的另一个思考等级」；检查结果压缩为 `配置检查通过；未调用模型。`

保留（可操作 / 状态 / 悬停）：

- `至少选择两个参与者（模型或思考等级不同）。`
- `同一模型的不同思考等级不是跨模型验证。`
- 悬停提示：工具预算 `0` = 不限制；每个参与者独立计费；读取到的文件内容会发送给所选模型供应商。

未改动：工具能力页 hero 与各组副标题、聊天内会诊卡片与输入框「+」入口、高级配置里的搜索 API Key 输入（均在本轮范围之外）。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过 |
| `pnpm -s test:builtin-capabilities` | 通过 |
| `pnpm -s test:multi-search` | 14/14 |
| `pnpm -s test:multi-model-consult` | 通过 |
| `pnpm -s test:multi-search-desktop` | 7/7（含「设置勾选 → IPC → 文件回读」全链路，55s） |
| `pnpm -s test:local-capabilities-electron` | 8/8 |
| `pnpm -s test:all` | 241 通过 / 1 已知失败（`test:project-agent`，baseline）/ **0 新增回归** |
| 真实渲染读数（1280×900 与 1280×960） | control 682×236；供应商网格 `scrollHeight = clientHeight = 412`，`overflowY: visible`（无内嵌滚动） |
| 打包应用 | `release-mybuddy-0.1.22\win-unpacked\MyBuddy.exe`，v0.1.22 实机打开设置页并截图；asar 文案核验：新增文案全部命中、删除文案全部不在 |
| `CONSULT_ENTRY_TEST_EXE=… pnpm -s test:consult-entry:desktop` | 8/8（打包产物 + 隔离 profile） |

## 发布记录（0.1.22）

- 版本：`package.json` 0.1.21 → 0.1.22。
- 打包沿用 0.1.21 已接受的 unpacked 约定（NSIS 目标历史上失败）：
  `pnpm -s build` + `npx electron-builder --win --dir --config.directories.output=release-mybuddy-0.1.22`。
- 接受的产物：`release-mybuddy-0.1.22\win-unpacked\MyBuddy.exe`，`FileVersion 0.1.22` / `ProductVersion 0.1.22.0`，SHA256 `9FD4D47996756B1A7397B3FDA3EA345B98323C87472C277BF6130E94196F9452`；`resources\app.asar` SHA256 `CA59C388224A22A75172E55B5DE2636B7F739A56CBEB7FE9C1E99B3320854433`（175 487 988 字节）。记录写入 `artifacts/mybuddy-0.1.22-release/accepted-build.json`。
- 快捷方式：开始菜单 `MyBuddy.lnk` 就地更新，桌面 `MyBuddy 0.1.21.lnk` → `MyBuddy 0.1.22.lnk`；回读确认 Target / WorkingDirectory / Icon 均指向 0.1.22 且目标存在，Description 由 `MyBuddy 0.1.21` 修正为 `MyBuddy 0.1.22`。备份在 `artifacts/mybuddy-0.1.22-release/shortcut-backups-*/`。
- 旧版本目录：`release-mybuddy-0.1.21` 仍被当时正在运行的 4 个 `MyBuddy.exe` 进程占用，按「不打断进行中的用户任务」暂不删除；下次以新快捷方式重启后可清理。
