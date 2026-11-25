# MyBuddy 项目进度核查（2026-11-25）

核查方式：Git 历史与工作区状态、GitHub API（workflow / release / issue）、本地三段 typecheck、2 个新增事务测试、原生运行时协议指纹。
未修改产品源码，未提交、未打包、未发布。

## 结论

项目仍在高速推进，但当前处在「大改动未提交 + CI 关闭 + 未发版」的中间态：主干 51 天累计 1,038 个提交，近 7 天 167 个；工作区同时挂着 122 个文件、+11,129/-1,992 的原生写路径迁移（Rust 模块 23→62、协议 25→74）。本次实测 typecheck 与 2 个新增事务测试通过，原生 crate 能编出协议 74 的产物；但 GitHub `verify` 工作流自 2026-10-30 起仍是 `disabled_manually`，517 项 test:all 没有自动门禁，本地还有 2 个提交未推送，最后发布版本 v0.1.110 已落后 5 天提交，安卓端仍停在 1.1.29。

## 1. 整体节奏

| 指标 | 数值 | 依据 |
| --- | --- | --- |
| 提交总数 | 1,038（2026-10-05 起） | `git rev-list --count HEAD` |
| 近 7 天提交 | 167 | `git log --since=2026-11-18 --oneline \| wc -l` |
| 单日峰值 | 114（2026-11-10） | 按提交日聚合 |
| 最新发布 | v0.1.110（2026-11-20） | `gh release list` |
| package.json 版本 | 0.1.110 | `node -p` |
| 未推送提交 | 2（26389bed、a92147ef） | `git rev-list --left-right --count origin/main...HEAD` → `0 2` |
| 未关闭 issue | 1（#58 资料库笔记 UI 对齐） | `gh issue list` |
| CI | `disabled_manually`（2026-10-30 更新） | `gh api .../actions/workflows` |

测试资产规模：`.github/workflows/verify.yml` 声明的分层在 `scripts/test-all.mjs --list` 中为 headless 513、GUI 112、NETWORK 42、DATASET 6、ARTIFACT 3、pending 0；default 选中 511 项（Windows 跳过 2 项 Linux 限定用例）。`package.json` 共 682 个 `test:*` 脚本。

## 2. 进行中的改动（未提交）

工作区 122 个文件变更，+11,129 / -1,992，另有 51 个未跟踪文件（10 个 TS 写入口 + 2 个事务测试 + 39 个 Rust 模块）。

主题是原生运行时写路径迁移：把原本在 TypeScript 侧执行的写操作，改成由 Rust 原生可执行文件承担。

| 项 | HEAD（已提交） | 当前工作区 |
| --- | --- | --- |
| Rust 模块数 | 23 | 62 |
| 原生协议版本 | 25 | 74 |
| 新增事务测试 | 0 | 2 |
| 单写入口 TS 模块 | — | 10 个（ProjectMutation、ProjectDeletion、LibraryTextSaves、CronPlanPersistence、CronRunPersistence、ScopedNotePersistence、workbench-writes、plugin-config、BlueprintInstanceWrite、capture-file） |

改动按文件的分布：scripts 31.1%、src/main 17.2%、gadget 7.3%、project 7.3%、native/runtime-audit 6.5%、library 4.9%、artifact 4.9%、memory 4.0%、agent 4.0%、remote 3.2%、renderer 3.2%。

## 3. 本次实测

- [x] `pnpm typecheck`（tsconfig.web + tsconfig.node + scripts 三段）：exit 0，`error TS` 0 条；覆盖全部未提交改动。
- [x] `pnpm test:project-deletion-transaction`：通过，`Project deletion transaction passed (host)`，exit 0。
- [x] `pnpm test:project-memory-transaction`：通过，`Project memory edits, deletion and search passed (host)`，exit 0。
- [x] 原生 crate 可编译：`out/native/runtime-audit-build/x86_64-pc-windows-msvc/release/mybuddy-runtime-audit.exe`（11-25 07:57）`--protocol-version` 返回 74，与工作区源码一致。

未验证范围：517 项全量套件、112 项 GUI、42 项 NETWORK、6 项 DATASET、3 项 ARTIFACT 均未运行；Linux 端、真实安装包、真实模型在线调用未验证。

## 4. 安卓端（本任务工作目录 `app/remote/android`）

| 项 | 状态 |
| --- | --- |
| 版本 | versionName 1.1.29 / versionCode 31（2026-10-30 发布） |
| 最近打包 | `app/build/outputs/apk/debug/app-debug.apk`，2026-11-23 22:06，4.39 MB（仅 debug，无 release APK） |
| 原生部分 | MainActivity.kt、RemoteClipboardPlugin.kt、RemoteCredentialPlugin.kt；Capacitor + WebView，minSdk 24 / compileSdk 36 / targetSdk 36 |
| 前端 | `app/remote/src/App.tsx` 2,177 行（单文件承载全部远程交互） |
| 未发版改动 | 24a8786b（11-23 安卓接入 Dots）、15e45218（11-24 桌面与远程界面升级） |

距上次安卓发版 26 天，期间有功能改动但没有提版本号和出包。

## 5. 风险与阻塞

1. **CI 关闭**：`verify.yml` 为 `disabled_manually`，自 2026-10-30 起未自动运行。工作流文件头自称「把 test:all 作为门禁接进回路」，与线上实际状态相反；517 项用例目前只能靠人工跑。
2. **未提交面过大**：122 个文件、含 39 个新 Rust 模块，没有提交点，出问题只能整体回退，也无法用 `git bisect` 定位。
3. **打包副本与源码不一致**：`out/native/win-x64/mybuddy-runtime-audit.exe` 报协议 69，源码是 74，`out/native/runtime-audit-build/win-x64.sha256` 指纹与当前源码不匹配（`f105690f…` vs 回执 `eb61ddd1…`）。`scripts/prepare-runtime-audit.cjs` 检测到不匹配会重建，所以不是硬阻塞，但这份副本现在不能用于验收。
4. **2 个提交未推送**：远端 `pushed_at` 为 2026-11-24T23:45:53Z，本地 main 领先 2 个提交。
5. **文档基线落后**：`docs/README.md` 写「核对基线 2026-11-19，代码 6d2e5dc9（v0.1.109）」，当前已是 v0.1.110；数据库 schema 仍为 36（`src/shared/database-version.ts`），与文档一致。
6. **安卓端未发版**：11-23/11-24 的远程与界面改动只在源码里，用户拿到的仍是 1.1.29。

## 6. 建议下一步（按优先级）

1. 把当前原生写路径迁移按域拆成几个提交落盘（先提交 Rust 模块与协议号，再提交各域 TS 单写入口），结束「一个 122 文件的巨型 WIP」。
2. 恢复门禁：重新启用 `verify` workflow，或本地定时跑 `node scripts/test-all.mjs`，让 511 项 headless 用例重新有人发现失败。
3. 安卓端提 versionCode/versionName 并出包，把 11-23/11-24 的改动交付到真实设备。
4. 更新 `docs/README.md` 基线到 v0.1.110，并在 CI 状态变化时同步该行，避免文档与线上状态再次相反。
