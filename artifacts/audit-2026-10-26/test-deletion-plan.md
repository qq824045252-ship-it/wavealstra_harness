# 旧测试 / 不合适测试：删除盘点（只读，2026-10-27，HEAD 3928a9a）

> 本报告**不改动任何文件**；未运行 `test:all`、未启动 Electron。GUI 失败/超时证据取自既有
> `artifacts/audit-2026-10-26/gui-run-2026-10-26.log` 与 `gate-gui-classification.md`。

## 1. 盘点口径与结果

- 全仓引用扫描：`package.json`（328 个 `test:*` + 全部其它 script + `build` 段 afterPack/files）、
  `.github/workflows/*.yml`、`src/**`、`scripts/**`（`from/require/import()/--alias`、bare 文件名如
  `join(here,"x.ts")`、`scripts/x.ts` 字符串）、extensionless 解析（补 .ts/.tsx/.cjs/.mjs/.js/index）。
  `docs/**` 只作为"文档引用"弱证据（历史文档不算存活依据）。
- 可达性（从 package.json/workflows/src 根出发）；`scripts/` 485 个顶层代码文件（499 含子目录）→
  可达 404、**不可达 95**、其中 test-ish 66。
- 实测命令：`node scripts/test-all.mjs --list` = headless 254 / GUI 46 / NETWORK 20 / DATASET 2 / pending 1；
  `git log`/`docs` 核对退役与封板；近重复用归一化行集合相似度。
- 判定：**A=高置信度可直接删**；**B=需人工确认（功能仍有效但有覆盖/用途重叠）**；**C=不要删**。

## 2. A. 高置信度可直接删（28 个 package.json 条目 + 69 个文件）

### 2.1 `test:*` 条目（10 条，10 个文件）

| # | test:* | 文件 | 证据 | 置信 |
|---|---|---|---|---|
| 1 | `test:opendesign-smoke` | `scripts/opendesign-smoke.ts` | 全文 6 行、无条件 `process.exit(0)`（:6）；注释"OpenDesign 已从设计专业工具删除…保留文件名以免旧 CI 任务找不到入口"；`RETIRED_MANAGED_PROVIDER_IDS` 含 `opendesign`（src/shared/professional-tools.ts:31）；GUI 日志实测 PASS 0.2s 无断言 | 高 |
| 2 | `test:expert-market` | `scripts/expert-market-smoke.ts` | 全文无 assert/exitCode；`:36-40` catch 后仅打印，install 失败也 exit 0；专家安装/启停已由 `test:expert` 覆盖（docs/hub-local-add-polish.md:30） | 高 |
| 3 | `test:pi100-features` | `scripts/pi100-features-test.ts` | 与 `pi104-features-test.ts` 近重复（相似 0.72，diff 仅头注释/tmp 前缀）；pi104 已是 "Pi 1.3.0 contracts"，pi100 仍是 "Pi 1.0 contracts"；仓库只支持 1.3.0（AGENTS/package.json） | 高 |
| 4 | `test:wave4-e2e` | `scripts/wave4-e2e.ts` | 文件头 "Wave 4 Architecture Gate — V3.5 §103 收口"；`docs/V3.5_STATUS.md` 记 V3.5 **CLOSED 2026-08-09**；从不进 default/CI；GUI 实测 9.6s FAIL（E1-6c/6d） | 中高 |
| 5-10 | `test:wave5a-e2e`…`test:wave5d3-e2e`（6） | `scripts/wave5{a,b,c,d1,d2,d3}-e2e.ts` | 同类 V3.5 wave gate e2e；GUI 实测 **4 个 300s TIMEOUT + 2 个 244s FAIL（6/6 全红）**；对应 headless `test:wave5*` quality 仍保留并通过 | 中高 |

### 2.2 非 `test:*` 的旧验收入口（18 条，15 个文件）

| 条目/文件 | 证据 |
|---|---|
| `golden:wave5a`…`golden:wave5d3`（6 条）+ `scripts/wave5*-golden.cjs`（6） | 只服务已封板的 V3.5 wave；依赖已删/待删 e2e 与 `screenshot-harness.cjs`；仅历史文档 docs/V3.5_*/STATUS.md 提及 |
| `gate:wave5a`…`gate:wave5d3`（6 条） | = `test:wave5X && test:wave5X-e2e`，随 e2e 删除即失效 |
| `gate:wave4`（1 条） | = `gate:artifact && test:wave4-e2e && build`，wave4-e2e 删除后只剩重复 build |
| `spike:transition` / `spike:shiki` / `spike:monaco` / `spike:office`（4 条） | 一次性技术选型 spike，已由 docs/spike-1f/1g/1h 结案；文件零引用（仅历史 spike 文档） |
| `harness:golden` + `scripts/screenshot-harness.cjs` | 仅被 wave5*-golden.cjs 引用；截图能力已由 `scripts/ui-capture.cjs` 取代 |
| 文件：`transition-spike.cjs`、`shiki-spike.mjs`、`monaco-spike.{cjs,app.mjs,page.html}`、`office-spike.{cjs,app.mjs,page.html}`（8） | 同上，一次性 spike |
| 保留：`spike:wcv-cdp` + `scripts/wcv-cdp-spike.cjs` | `scripts/artifact-machine-gate.ts:245-253` R6 明确"scripts/ 仅保留正式 wcv-cdp-spike.cjs" |

### 2.3 零引用旧脚本（孤儿，44 个文件；全仓扫描无 package.json/CI/src/脚本引用）

| 组 | 文件（数量） | 证据/理由 |
|---|---|---|
| 旧 Pi 1.0.0 一次性验收链（19） | `pi-codemode-auto-{closeout,core-integrity,deploy,desktop-live,regression}.cjs`、`pi-host-{closeout,core-integrity,desktop-live,exit-regression}.cjs`、`pi-native-{clean-test-profiles,closeout,core-deploy,core-desktop-live,core-integrity,deployment-check,regression}.cjs`、`pi-minimal-mode-desktop-live.cjs`、`pi-host-workflow-server.mjs`、`subagent-worker-launcher-099-smoke.ts` | 读取 `artifacts/pi-*/…results.json`、`build-latest.json` 的 2026-10-02 一次性升级回执；3 个 core-integrity 互为 0.81–0.88 近重复；0.99 smoke 违反"只支持 1.3.0"（AGENTS）；**同类 12 个已在 2026-10-09 按 artifacts/quality-audit/pi-legacy-purge.md 删除，本次为残党** |
| 旧远程手机验收（6） | `remote-phone-{acceptance,image-acceptance,scroll-regression,svg-acceptance}.cjs`、`run-remote-image-tests.cjs`、`run-remote-regression.cjs` | 硬编码设备 `A4UF6R6206002786` + `LOCALAPPDATA/Android/Sdk/adb.exe`；产物 `artifacts/remote-android-20260930`；对应 docs/Remote_Image_Access_Acceptance_2026-09-30.md 为一次性记录；当前 remote 能力由 8 个 `test:remote-*` 覆盖 |
| 旧打包/桌面验收（3） | `shell-preferences-desktop-test.cjs`、`models-portable-electron-test.cjs`、`html-edit-app-smoke.cjs` | 需 `MYBUDDY_DESKTOP_EXECUTABLE`/已构建 portable；现由 `verify:packaged` + `verify-windows-gui` 覆盖 |
| skill-governance 一次性迁移工具（5） | `skill-governance/{cli-smoke,deploy,native-smoke,workflow-smoke}.mjs`、`wrappers.test.mjs` | 硬编码 `C:/Users/servi/.mybuddy/skills`、`C:/Program Files/Git/bin/bash.exe`；迁移已于 2026-09-09 部署完成（docs/plan/skill-governance-and-gitbash-migration-review.md），无其它引用 |
| 一次性探针/一次性验证（7） | `ardot-mcp-probe.mjs`、`probe-main.mjs`、`check-babel.cjs`、`phase15-verify.ts`、`model-runtime-init-probe.ts`、`pty-host-probe.ts`、`pty-load-probe.cjs` | 零引用的 probe；Ardot 画布已于 2026-08-07 回滚（docs/ardot-integration.md 头），babel 检查为一次性 |
| 失效路径脚本（1） | `verify-ardot-skills.mjs` | 硬编码 `C:/Users/servi/Desktop/mybuddy`，本机/CI 必然失败 |
| 旧 selection UI/e2e（3） | `selection-comment-ui-test.cjs`、`selection-comment-ui-test.tsx`、`selection-popover-e2e.ts` | 零引用；语义已由 `test:selection-store`、`test:chat-selection`、`test:prompt-context` 覆盖（Lead 点名的"零引用旧 e2e"类型） |

## 3. B. 需要人工确认（功能仍有效；删除需产品/发布确认）

| 条目/文件 | 建议 | 证据 | 置信 |
|---|---|---|---|
| `test:pi100-model-admission`（scripts/pi100-model-admission-test.ts） | **不删**：改名/并入 pi104 | `ModelInvocationAdmission` 仍存活；8 个 admission 场景唯一覆盖（pi104-model-compat 仅 1 条相关） | 中 |
| `test:pi100-context-boundary`（scripts/pi100-context-mode-boundary-test.ts） | 保留并改名（或并进 test:pi-codemode-auto） | 测试"已退役 context-mode 不得回归"的负向断言 + codemode/tool_search 仍注册；`contextMode` 已不在 src | 中 |
| `gate:v35` | 重组为"pdf+artifact 当前验收"或删除 | 串起 gate:wave4 + 7 个 wave e2e + 当前 pdf/artifact 用例；V3.5 已封板 | 中 |
| 旧 portable 构建工具（8）：`build-models-portable.cjs`、`build-models-snapshot.cjs`、`build-native-control-portable.cjs`、`build-pi-codemode-assets.mjs`、`build-pi-codemode-auto-portable.cjs`、`build-pi-host-exit-portable.cjs`、`build-pi-image-resize-assets.mjs`、`build-pi-minimal-mode-portable.cjs` | 建议删/归档 | 零引用、已被 electron-builder (+afterPack/verify:packaged) 取代；属 build 工具，需确认无人工发布流程在用（未见文档引用） | 中 |
| 其它孤儿 UI/远程测试（12）：`request-user-input-ui-test.ts`、`place-fixed-menu-test.ts`、`skill-market-test.ts`、`space-workspace-cwd-test.ts`、`test-space-uniqueness.ts`、`thinking-levels-test.ts`、`plugin-storage-test.ts`、`workspace-shared-context-ui-race-test.ts`、`remote-startup-reconnect-test.ts`、`remote-startup-runtime-test.cjs`、`remote-client-regression-test.ts`、`remote-image-access-test.ts` | 多数建议删；`place-fixed-menu-test` 无 wired 覆盖，建议接入 default 而非删 | 功能存活，但均有 wired 对应覆盖（request-user-input-test / plugin 相关 / remote-* / workspace-shared-context 等）；零引用 | 中 |
| MCP 孤儿（3）：`mcp-native-security-test.ts`、`mcp-discover-test.ts`、`mcp-mode-live-check.ts` | 前两个删；后者保留或更新 docs | `classifyMcpToolCall` 已由 test:mcp-execution-evidence 覆盖；mcp-mode-live-check 被 docs/场景模式-MCP与技能隔离.md 引用为诊断步骤 | 中 |
| CAD/Blender 孤儿验收（4）：`cad-freecad-smoke.ts`、`cad-skill-sync-check.ts`、`blender-readiness-live-smoke.ts`、`build-cad-skill-sync.mjs` | 建议删（需 CAD 负责人确认） | `RETIRED_MANAGED_PROVIDER_IDS` 含 blender/freecad，但 `test:cad-*` 仍通过（CAD 工具链存活）；这些是需真实外部 App 的旧 live 验收 | 中 |
| `generation-speed-test.ts`、`memory-procedure-learning-live.cjs` | 删（已被 wired 覆盖） | `GenerationSpeedTracker` 由 test:retry-display/architecture 覆盖；learning 由 test:memory-procedure-learning 覆盖 | 中 |
| `desktop-cdp-client.cjs`、`repair-mybuddy-windows-shortcuts.cjs`、`update-command-code-models.mjs`、`mcp-status.mjs`、`materialize-modes.ts` | 保留（诊断/发布工具）或归档 | 仅被历史文档/审计报告引用；属工具而非测试 | 低（保留倾向） |
| `gen-*.mjs/cjs` 系列（gen-code/markdown/image/pdf/office-fixtures） | 保留 | fixtures 再生成工具，fixtures/artifacts/README.md 引用 | 低 |

## 4. C. 明确不要删

- **平台/环境限制但功能有效**：5 个 `test:computer-*`（Windows-only，GUI Windows job 覆盖）、`test:magpie-desktop`（需 MAGPIE_TEST_EXE）、`test:artifact-open-e2e`（缺 optional peer `@terrastruct/d2`，**修 build 脚本/加依赖**）、`test:browser-screenshot-electron`/`sidebar-space-collapse-desktop`/`task-status-dot-desktop`（Linux 显示超时，非测试腐坏）。
- **产品决策中的已知失败**：`test:project-agent`（baseline `$remaining`）。
- **当前渲染契约且通过**：`test:wave5a`…`wave5d3` quality、`test:pdf-runtime-e2e`、`test:pdf-page-identity-e2e`（GUI 实测通过）。
- **fixtures/stubs/harness/build 工具**：`test-guard.mjs`、`ui-capture.cjs`、`test-store-harness.ts`、`*-stub/fixture`、`build-*.mjs`（除 §3 明确旧 portable 工具）、`scripts/fixtures/**`。
- **经构建脚本接线的测试**：`blender-skill-integration-check.ts`、`verify-blender-skills.ts`（build-blender-skill-check.mjs）、`skill-root-guard-test.ts`（build-skill-root-guard.mjs）、`wave5a-preview-entry.tsx`/`wave5a-store-mock.ts`/`wave5a-worker-stub.ts`/`build-wave5a-preview.mjs`（**pdf e2e 与 artifact-open 仍共用，不能随 wave5 e2e 一起删**）。

## 5. 删除后影响与配套清理

- 计数：`test:*` **328 → 318**（headless 254→251，GUI 46→39）；package.json 共删 28 条；文件删 69 个。
- 必须同步：`scripts/test-all.mjs` 的 `GUI_TESTS` 删 7 个 `test:wave*-e2e` 名字（当前在 :89-95），删后 `node scripts/test-all.mjs --list` 复核；`gate:v35` 按 §3 决策。
- `scripts/typecheck-baseline.json` 有 **2 条**落在被删文件上（`scripts/pi100-features-test.ts`、`scripts/model-runtime-init-probe.ts`）→ 删除后跑 `pnpm -s typecheck:scripts:update-baseline` 收敛基线（从 209 降至 207）。
- CI：`.github/workflows/*` 对以上条目**零引用**（已 grep），删除不影响两条 default job 与 GUI job。
- 文档同步（历史文档保留但需标注/改命令）：`docs/opendesign-integration.md:168`（test:opendesign-smoke）、`docs/hub-local-add-polish.md:30,93`（test:expert-market）、`docs/STATUS.md:423`、`docs/V3.5_STATUS.md`/`V3.5-EXECUTION-SUMMARY.md`（gate:wave/golden:wave）、`docs/spike-1f/1g/1h`（spike:*）、`docs/Remote_Image_Access_Acceptance_2026-09-30.md`、`docs/plan/skill-governance-*.md`。
- 删除后验证建议：`pnpm -s typecheck` → `node scripts/test-all.mjs --list`（251/39/20/2/1）→ `pnpm -s test:all` → `pnpm -s test:artifact-gate`（R6 仍 PASS）→ `git grep -n <被删脚本名>` 确认无悬挂引用。

## 6. 不确定项

- "无人跑"是静态可达性结论，不含**人工**运行的一次性发布验收；§3 的 build/发布工具因此保守列为"人工确认"。
- 旧 Wave e2e 的删除依据是"V3.5 封板 + 从未进 default/CI + GUI 实测全红"；若产品仍要 e2e 验收，应改为 1–2 条针对当前实现的 e2e，而不是保留 10 条旧 gate。
- `test:expert-market`/`test:opendesign-smoke` 删除会让 docs 里的验收命令失效；若想保留覆盖，正确做法是补真实断言（expert market）或删条目后同步文档（opendesign 已退役）。

---

## 6. 执行结果（2026-10-27，Lead 执行）

按本报告的 A 类 + B 类中确认无用的零引用旧测试执行删除；B 类中仍有唯一覆盖或属构建工具的保留。

**删除的 package.json 条目（29）**：`test:opendesign-smoke`、`test:expert-market`、`test:pi100-features`、
`test:wave4-e2e`、`test:wave5a-e2e`…`test:wave5d3-e2e`（7）、`golden:wave5a`…`golden:wave5d3`（6）、
`gate:wave5a`…`gate:wave5d3`（6）、`gate:wave4`、`gate:v35`、`spike:transition/shiki/monaco/office`（4）、
`harness:golden`。`test:*` 328 → **318**。

**删除的文件（91）**：
- 旧 wave / spike：7 个 `wave*-e2e.ts` + 6 个 `wave*-golden.cjs` + `wave4-e2e.ts` + `screenshot-harness.cjs` +
  transition/shiki/monaco/office spike（8）；
- 旧 Pi 1.0.0 一次性验收残党（19）：`pi-codemode-auto-*`、`pi-host-*`、`pi-native-*`、
  `pi-minimal-mode-desktop-live.cjs`、`subagent-worker-launcher-099-smoke.ts`；
- 旧远程手机验收（6）：`remote-phone-*`、`run-remote-*`；
- skill-governance 一次性迁移（5）；
- 一次性探针 / 失效脚本（8）：`ardot-mcp-probe`、`probe-main`、`check-babel`、`phase15-verify`、
  `model-runtime-init-probe`、`pty-*`、`verify-ardot-skills`；
- 零引用旧 UI/e2e（17）：selection-*（3）、request-user-input-ui、place-fixed-menu、skill-market、
  space-workspace-cwd、test-space-uniqueness、thinking-levels、plugin-storage、workspace-shared-context-ui-race、
  remote-startup-*（2）、remote-client-regression、remote-image-access、remote-renderer-regression（2）；
- 旧 MCP/CAD/Blender live 验收与旧打包验收（8）：`mcp-native-security-test`、`mcp-discover-test`、
  `cad-freecad-smoke`、`cad-skill-sync-check`、`build-cad-skill-sync`、`blender-readiness-live-smoke`、
  `generation-speed-test`、`memory-procedure-learning-live` 及 `shell-preferences-desktop-test`、
  `models-portable-electron-test`、`html-edit-app-smoke`。

**修复而非删除**：
- `test:workspace-files-ui`：删掉过时断言「项目资产可跳到侧边栏资料库」（ProjectAssets 已无该入口），
  48/48 PASS；从 pending 桶移回 default。
- `test:artifact-open-e2e`：`build-wave5-real-open*.mjs` 把 optional peer `@terrastruct/d2` 标为 external，
  33/33 PASS（此前因缺依赖恒红）。

**配套**：`scripts/test-all.mjs` 移除 7 个 wave e2e GUI 名单、pending 桶清空；`typecheck-baseline.json`
208 → 195（删除文件的 13 条历史错误随文件消失）；`package.json` 无悬空路径、CI 无引用。

**保留（明确不删）**：平台/环境有效的 GUI/NETWORK/DATASET（Windows-only computer-*、magpie-desktop、
browser-screenshot 等）、`test:pi100-model-admission` / `test:pi100-context-boundary`（唯一覆盖，名字待改）、
wave5* quality / pdf e2e、fixtures/stubs/harness/build 工具、`spike:wcv-cdp`。

**验证**：`pnpm -s typecheck` exit 0（195 基线 / 新增 0）；`test:workspace-files-ui` 48/48；
`test:artifact-open-e2e` 33/33；`node scripts/test-all.mjs --list` = headless 252 / GUI 39 / NETWORK 20 /
DATASET 2 / pending 0；`pnpm -s test:all` 见提交记录（252 全绿）。
