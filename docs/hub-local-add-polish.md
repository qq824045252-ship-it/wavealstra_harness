# 插件页本地添加体验优化 — 总结

> 分支：`codex/gadget-blueprint`  
> 提交：`2789724 feat(hub): polish local add flow for plugins (experts/skills/connectors) — import via folder/zip + drag-drop, validated errors and real async busy/toast`  
> 范围：插件页四合一 — 专家（含专家团）· 技能 · MCP · 连接器  
> 方案：B（导入入口 + 校验提示 + 真等待态）

## 1. 背景与问题

- 插件页是本地化页：`HubPage.tsx` 的 `ExpertsTab / SkillsTab / McpTab / ConnectorsTab` 四个 Tab。
- 添加链路绕：原先只能手动把包拷到 `mybuddyskills-main/experts` 或 `~/.mybuddy/expert-market/experts` 再刷新才出现，无页内入口，也无拖拽。
- 后端其实已支持 `installExpertByPath / importExpertZip / installSkillByPath` 等 IPC，但前端 `HubPage` 没调，且 `store/appStore.ts` 里 `install/uninstall` 是 `void ... then + setTimeout 假 busy`，失败静默。
- 结构校验后置：`agents/*.md / prompt.md / SKILL.md` 缺失要到后端抛错才知道，前端无前置提示。

## 2. 目标（按 B 方案）

- 页内一键导入：ZIP / 本地文件夹 + 拖拽直达，后端复用已有 IPC。
- 校验可理解：缺 `agents/*.md / SKILL.md` 等给出明确 toast 文案。
- 真等待态：所有安装/卸载/启停改为 `await + busy + 成功/失败 toast`，去掉 `setTimeout`。
- 不动语义：保留「卸载=退回市场可重装 / 删除=永久移除」；MCP 已是真等待保持不变。

## 3. 变更总览

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/appStore.ts` | 技能/专家/连接器改为真 `async/await`；增加 `trim` 与空 `id` 校验；`api` 不存在时抛“请完全退出并重启”；技能 `installSkillByPath` 校验“需含 SKILL.md”；补齐类型 `Promise<void>` |
| `src/renderer/src/components/pages/HubPage.tsx` | 专家/技能顶部新增导入栏 + 整页拖拽；统一错误文案 `expertErrText / skillErr`；专家卡片与专家团全部去假等待；连接器启停与卸载改为真等待 |

- 统计：`2 files changed, 421 insertions(+), 126 deletions(-)`
- 自检：`typecheck` 通过；`test:expert` 60/60 通过；`test:expert-market` 通过。

## 4. 详细改动

### 4.1 Store 层（`appStore.ts`）

```ts
// 技能
installSkill: async (id) // trim + 空校验，await installSkill + refreshSkills
installSkillByPath: async (path) // 校验“需含 SKILL.md”，await + refresh
uninstallSkill: async (id) // 同步校验，await

// 专家（含专家团 team:<id>）
installExpert: async (id) // 同上
installExpertByPath: async (path) // 文件夹导入
importExpertZip: async (zipPath) // .zip 后缀校验
uninstallExpert: async (id) // trim + 空校验

// 连接器
installConnector: async (id) // trim 校验，await + refreshConnectors/Skills
uninstallConnector: async (id) // 同上
setConnectorEnabled: async (id, enabled) // 真等待，原 void 改 promise
```

类型同步：`installSkill: Promise<void>`, `uninstallSkill: Promise<void>`, `uninstallConnector: Promise<void>`, `setConnectorEnabled: Promise<void>`。

### 4.2 页面层（`HubPage.tsx`）

**ExpertsTab**
- 新增：`installExpertByPath / importExpertZip` 引入；`dragOver` 状态；`expertErrText()`；`handleImportZip / handleImportFolder / handleExpertDrop`。
- 结构：根 `div` 加 `onDragOver/onDragLeave/onDrop`，`className="expert-drop-active"`；顶部 `hub-import-bar` 放 `导入 ZIP / 从文件夹导入` 按钮与说明文案；`dragOver` 时显示 `hub-drop-hint`。
- 导入逻辑：`pickZipFile` 校验 `.zip` 后缀 → `importExpertZip`；`pickLocalFolder` → `installExpertByPath`；拖拽经 `webUtils.getPathForFile` 取真实路径，`.zip` 走 zip，否则走文件夹。
- 去假等待：`renderExpertCard` 与专家团队卡片全部 `setTimeout` 改 `await + try/catch + busyId 文案切换（安装中…/卸载中…）`。

**SkillsTab**
- 同专家：新增 `installSkillByPath`、`dragOver`、`skillErr`、`handleSkillDrop / handleImportSkillFolder`；根 `div` 加拖拽；顶部 `hub-import-bar`；两处卸载与两处市场安装改为真等待。

**ConnectorsTab**
- `启用/停用` 与两处 `卸载` 由 `setTimeout 400ms` 改为 `await setConnectorEnabled / uninstallConnector`，按钮文案 `处理中…/卸载中…`，失败走 `err` toast。

**McpTab**
- 保持原 `busy/notice` 真等待与配置读写提示，未改动。

## 5. 交互与校验

- **导入入口**：专家为 `导入 ZIP + 从文件夹导入`；技能为 `从文件夹导入`；连接器沿用市场安装。
- **拖拽**：专家支持 ZIP/文件夹；技能支持 `SKILL.md` 文件夹；无路径时提示“请用按钮导入”。
- **校验文案**：
  - 专家：`agents/*.md / prompt.md` → “请确认目录包含 agents/*.md 或 prompt.md”；“路径不存在” → “请检查文件是否被移动或删除”；非 `.zip` → “仅支持 .zip 专家包”
  - 技能：`SKILL.md` → “请确认目录包含 SKILL.md”
- **等待态**：所有操作期间按钮 `disabled`，文案切 `导入中…/安装中…/卸载中…/处理中…`；成功与失败均有 `HubToast`。

## 6. 语义与兼容性

- 未改动：市场扫描根（`mybuddyskills-main` + `~/.mybuddy/expert-market`）、团队成员隐藏、`deleteFromMarket` 的路径护栏与 `market-hidden-*.json`、卸载/删除的二分语义。
- 兼容：`pickLocalFolder / pickZipFile / getPathForFile` 均通过 `window.api` 动态取，缺失时走 catch 提示，不强依赖。
- 样式：仅用内联 `hub-import-bar / hub-drop-hint` 轻量样式，未引入新依赖。

## 7. 验证

```
npm run typecheck        # ✅
npm run test:expert       # ✅ 60 passed, 0 failed
npm run test:expert-market# ✅
```

## 8. 后续可选

- 细化拖拽命中区域的视觉（当前为整 Tab 区域，可收敛到导入栏）。
- 连接器支持本地文件夹拖拽（需后端 `installConnectorByPath`，当前仅市场安装）。
- 为 `pickZipFile/pickLocalFolder` 在 `preload/index.d.ts` 补显式类型，替换 `as unknown` 断言。
