# 多机同步与门禁手册（Windows 开发机 / Linux 开发机 / GitHub main）

> 目的：让"在 Linux 上改完同步回 GitHub"这件事有固定动作，不靠记忆，也不靠"先 push 再说"。
> 适用：两台机器各自 checkout 同一仓库、都往 `origin/main` 推；CI 是最后一道闸。

## 0. 为什么需要这份文档

同一份代码在两台机器上推，出问题的从来不是 git 本身，而是这四类：

1. **路线被悄悄回退**：CAD 链已按路线删除（见 PR #2），一次 `git merge` 就把 `src/main/cad/**` 带回来。
2. **门禁缺前置条件**：直接读 `out/main` 的用例在"没构建"的机器上必红，然后被误判成回归。
3. **平台差异被当成 bug**：Linux-only 用例在 Windows 上红、Windows-only 在 Linux 上红。
4. **基线掩盖回归**：为了让门禁变绿去改 `scripts/test-baseline.json` / `typecheck-baseline.json`。

## 1. 五条铁律

1. **一条线一个分支**：日常开发在 `main`（AGENTS.md 约定）。跨机器同步前先 `fetch`，不要凭印象判断"我的是最新的"。
2. **路线级改动走 PR**：删除/退役一条产品线（如 CAD 链）、改测试分层、改 CI 门禁——这些用 PR 记录，合并后不要再用本地 merge 覆盖。
3. **禁止 `push --force` 到 `main`**。历史上被 force 覆盖的提交在 CI 里查不回来。
4. **push 前必跑门禁四件套**（见 §3）。跑不过就查，不要 push 了等 CI 告诉你。
5. **基线只能减少**：`test-baseline.json`（已知失败）与 `typecheck-baseline.json`（脚本 TS 错误）都只允许下调。往上加等于自我批准回归，评审时会被打回。

## 2. Linux（Omarchy）侧的日常同步流程

```bash
cd ~/path/to/wavealstra_harness

# 1) 先看本地有没有未提交的改动（有就先 commit 或 stash，别带着它同步）
git status -sb

# 2) 取远端，看分叉程度：ahead N / behind M
git fetch origin --prune
git status -sb

# 3) 同步（推荐 rebase，保持线性；冲突一次解决一个提交）
git pull --rebase origin main

# 4) 有冲突时：按 §4 的决策表解，不要凭"我的更好"

# 5) 门禁四件套（§3），全绿再推
pnpm -s typecheck
pnpm -s test:architecture && pnpm -s test:architecture-graph
pnpm -s build
TEST_ALL_JOBS=2 pnpm -s test:all

# 6) 推送
git push origin main
```

如果同步量很大（比如跨了十几个上游提交），不要直接在 `main` 上解冲突：

```bash
git switch -c sync/upstream-$(date +%Y%m%d) origin/main
git merge main              # 或 git cherry-pick 你需要的提交
# 解冲突 + 门禁四件套
git switch main && git merge --ff-only sync/upstream-$(date +%Y%m%d)
```

**跨机器切换的正确姿势**：换机器前先 push（哪怕推一个 `wip/*` 分支）；换机器后第一件事是 `fetch`。两台机器同时改同一批文件时，先商量谁先推。

## 3. 门禁四件套（本机等价于 CI）

| 步骤 | 命令 | 作用 | 常见误判 |
|---|---|---|---|
| 类型 | `pnpm -s typecheck` | tsc web + node + scripts 棘轮 | 脚本错误基线只能降 |
| 架构 | `pnpm -s test:architecture`、`pnpm -s test:architecture-graph` | 分层/环/越层/行数棘轮/preload 契约 + 便携工具根防回归 | 新文件超 2500 行也会红 |
| 构建 | `pnpm -s build` | 产出 `out/main` | **不构建就跑部件用例 = 假红**（image-resize-assets / oauth-bundle / pi104-features） |
| 套件 | `TEST_ALL_JOBS=2 pnpm -s test:all` | headless default + 棘轮 | 4 路并发在 2-4 vCPU 机器上会把时序断言拖红 |

GUI 套件要真机：`pnpm -s build && pnpm -s test:all:gui`；联网/远程：`pnpm -s test:all:live`。

## 4. 冲突决策表（这些文件以后一定会冲突）

| 路径 | 处置规则 |
|---|---|
| `src/main/cad/**`、`scripts/cad-*-test.ts`、`scripts/freecad-*`、`scripts/*blender*`、`docs/mechanical-cad.md` | **保持删除**。这是路线（不内置第三方软件）。上游若修改了这些文件，冲突时选"删除"。 |
| `src/main/professional-tools/ProfessionalToolRuntime.ts` | 取上游的平台导入（`platform/processes`、`platform/apps`），保留本地 `getToolsDir()` 工具根；**不要**恢复 `discoverPortableExecutable` 或 `MyBuddyTools` 便携目录。 |
| `scripts/test-all.mjs` | 取上游的分类清单（GUI/NETWORK/DATASET + 显式清单），然后删掉指向"已不存在脚本"的条目；`PLATFORM_ONLY_TESTS` 里保留平台限定标记。 |
| `scripts/typecheck-baseline.json` | 以上游为底；剔除"目标文件已不存在"的条目；**不要**把新错误加进去。 |
| `package.json` 的 `scripts` | 取上游；确认没有 cad/freecad/blender 入口残留；版本号跟上上游。 |
| `pnpm-lock.yaml` | 不要手改；冲突就 `git checkout --theirs pnpm-lock.yaml && pnpm install --frozen-lockfile` 再确认能装。 |
| `artifacts/**` 的 `*-results.json` | 测试产物，冲突时取"本次运行产物"；不要为了干净把它们提交成内容变更。 |

解完冲突后必须重跑 §3，因为"文本能合、语义断掉"是这类冲突最常见的结果（例如 Upstream 给 `src/main/index.ts` 加了平台导入，而你删掉了同文件的 CAD 装配）。

## 5. CI 红怎么判读（别急着认账）

1. **先看基线**：`main` 上最近一次 push 的 verify 是否已经红？红了就是既有环境债，不是你的回归。
   `gh run list --branch main --limit 5`。
2. **看失败集合是否稳定**：每次运行的失败集合都不一样 → 时序/资源类假红（acp-remote 409、slack-gateway 超时、pi-native-core-tools 取消顺序）。
3. **看错误类型**：`ENOENT out/main/...` → 缺构建；`charmap_encode` / 编码错误 → 宿主代码页；`requires Windows` / linux 后端断言 → 平台限定，应进 `PLATFORM_ONLY_TESTS` 或 `GUI_WINDOWS_ONLY`，不是修代码。
4. **真要修**：本地先复现（`mv out out.bak` 模拟没构建、`PYTHONIOENCODING=cp1252` 模拟西部代码页、`TEST_ALL_JOBS=1` 模拟慢机器），复现不了就先按假红处理，别凭猜改断言。

## 6. 平台标记的规矩

- 用例**真实覆盖的后端**只有一个平台 → 进 `PLATFORM_ONLY_TESTS`（如 `test:platform-computer-use`、`test:computer-use-linux` 标 `linux`）。
- 只是**断言写死了宿主路径**（`/tmp/x`、`/sandbox/logs`）→ **修断言**，用 `join()`/`resolve()` 拼期望值，不要把整条用例标成平台限定，那会白丢另一个平台的覆盖率。
- Windows-only 的 GUI 用例仍放 `GUI_WINDOWS_ONLY`（只在 `--include-gui` 生效）。两个方向都要显式写清，别让"本机能不能跑过"决定门禁结果。

## 7. 事故处置速查

| 症状 | 处置 |
|---|---|
| 门禁突然多出 cad 相关失败 | 路线被回退：`git log --oneline -- src/main/cad` 查是谁带回来的，按 §4 重新删除 |
| `out/main` 缺文件 | `pnpm -s build`；不要把这些用例标成"依赖本机环境" |
| 棘轮红了但你认为没改行为 | `node scripts/test-all.mjs --list` 看分类是否变了（新用例默认 headless，会进 default 套件） |
| 拉下来测试全红、本机原来是绿的 | 先 `pnpm install --frozen-lockfile`（依赖可能变了），再 `pnpm -s build`，再跑四件套 |
| 怀疑 push 覆盖了别人的提交 | `git log --oneline origin/main -20` 与 CI 记录对照；**不要**用 force push"修"，改用 revert |
