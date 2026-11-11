# vendor/acp-kernel — 来源与升级说明（SOURCE）

本目录是 **acp-kernel** 的**原样**副本（vendor，不修改上游字节、保留版权头），供 MyBuddy
主进程的 durable 上下文管理直接以 TypeScript 源码方式引入，由 electron-vite/esbuild 打包进
`out/main`。它**不是** npm 依赖，也不是 pnpm workspace 包。

## 固定来源

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/ranxianglei/billion-context |
| 上游子目录 | `kernel/`（monorepo 内联，自 billion-context #2092 起；独立仓库 https://github.com/ranxianglei/acp-kernel 已冻结） |
| 固定 commit | `dc041dd1ab1a014efa352ba47a6f31fc47f55284` |
| kernel 版本 | `0.0.195`（复制时 `kernel/package.json` 的 `version`） |
| npm 包名 | `acp-kernel`（`license: MIT`，`author: ranxianglei`，`type: module`，零 runtime dependencies） |
| 复制日期 | 2026-11-11 |
| 复制方式 | `git -c core.autocrlf=false archive HEAD kernel/...` 取 **canonical blob 字节**（LF，不受 Windows 工作区 CRLF 影响），`tar` 解包后 `robocopy /E`；逐文件用 `git hash-object --no-filters` 对比上游 `git ls-tree` blob SHA1：**91/91 完全一致，0 差异，0 个 CRLF 文件** |
| 未做任何修改 | 未改动任何 vendor 源文件；`LICENSE`、`README.md`、`PROVENANCE.md` 为上游原文 |

## 复制清单（91 个文件）

- `src/**` — **87** 个文件：86 个 `.ts` + `src/search/SEARCH.md`。这是上游 `kernel/src` 全量。
- `LICENSE` — MIT + 附加署名条款（原文）。
- `README.md` — 上游 kernel README（API/设计/许可说明，可据此核对 API）。
- `PROVENANCE.md` — 上游逐文件来源审计（说明本库是对 DCP/AGPL 的独立重写，MIT 成立）。
- `PACKAGE.json.txt` — 上游 `kernel/package.json` 的原字节，**故意改名**：保留版本/仓库/依赖等
  元数据用于溯源，同时避免 `npm`/`pnpm`/`electron-builder` 把 `vendor/acp-kernel/` 误当成一个
  真实包（pnpm workspace 只有 `app/*` 与 `shared`；本仓库对它的使用是 TypeScript 源码引入 + 打包）。

**未复制**（宿主不需要，也不属于运行时源码）：`tests/`、`bench/`、`scripts/`、`DESIGN.md`、
`SECURITY.md`、`tsup.config.ts`、`tsconfig.json`、`package-lock.json`、`.prettier*`。宿主不使用上游
构建链；编译/打包走本仓库自己的 tsc + electron-vite/esbuild。

## 为什么不用 npm 上的 `acp-kernel`

npm registry 上 `acp-kernel` 的已发布版本停在 **0.0.101**（本次核对时的最新版；对应 tarball 已下载到
`.work/npm-acp-kernel-0.0.101/`），与本目录所需版本存在实质差距，不能替代：

- 版本跨度 **0.0.101 → 0.0.195**（94 个版本）。0.0.101 之后 kernel 改为随 billion-context 仓库内联
  演进，之后的修复与行为变更不会出现在该 npm 包里。
- API 面不兼容：与 `0.0.195` 的 `src/index.ts` 相比，0.0.101 缺少 **20 个导出**，包括
  `retireBlocks`、`restoreBlocks`、`rewriteBlockSummary`、`restampRefsToLedger`、
  `restampContentStore`、`orderedRefPair`、`collectProtectedToolCallIds`、
  `isMessageProtectedWithPairing`、`matchToolMessagePattern`、`matchToolPath`、`toolPathOf`、
  `hasUnrecoverableMediaPayload`、`ONE_CALL_HINT`、`BlockOpOutcome`、`RefRestampOutcome` 等
  （durable 上下文管理用到其中的块操作/引用重盖戳/受保护消息判定）。
- 我们的实现按 `0.0.195` 的类型与行为编写（见本 issue 的 `DurableContextManager`/`CompressionPolicy`），
  用 0.0.101 会在类型与语义上都产生不可控漂移。

因此选择“**固定 SHA 的源码 vendor**”，而不是浮动 registry 依赖。

## TypeScript / 打包接线（本仓库侧）

- `tsconfig.node.json`：`include` 加 `vendor/acp-kernel/**/*`；`lib` 加 `ES2024.Promise`
  （`src/persist/store.ts` 使用 `Promise.withResolvers`，与上游 kernel tsconfig 一致）；
  `paths` 加 `"acp-kernel": ["./vendor/acp-kernel/src/index.ts"]`——仅用于类型检查，解析
  `src/wire/bili-message.ts` 的 type-only 自引用 `import type { CoreMessage } from "acp-kernel"`。
- **运行时代码只用相对路径 import vendor 源码**（例如
  `import { createCore } from "../../../../../vendor/acp-kernel/src/index.js"`）。electron-vite/rollup
  **不读取** tsconfig `paths`，用裸名 `"acp-kernel"` 会在 build 时报解析失败。仓库内没有为
  `acp-kernel` 注入 bundler alias，这是有意为之。
- 主进程构建 `electron.vite.config.ts`：`externalizeDeps: false` + `external` 白名单里没有
  acp-kernel/`vendor/**`，因此它会被**打包进 `out/main`**，不会以外部包形式在运行时 require。
- electron-builder `build.files` 只收 `out/**` 等，`vendor/` 不进入安装包 payload（`vendor/officecli`
  仅作为 `extraResources` 单独拷入）；vendor 源码只影响构建期。
- 源码形态：ESM-only，相对 import 全部带 `.js` 后缀（TS `moduleResolution: bundler` 与 esbuild
  都按 `.js → .ts` 解析）；零 runtime dependency；`engines.node >= 20`（本仓库 Node 24）。
- 唯一一处**非相对 import** 是 `src/wire/bili-message.ts` 的 **type-only** 自引用
  `import type { CoreMessage } from "acp-kernel"`（编译期擦除，运行时不会出现裸导入；由
  tsconfig `paths` 解析）。`src/search/algorithms/semantic.ts` 里的 `acp-kernel` 字样只出现在
  文档注释中。`index.ts` 的依赖闭包不含任何裸 import，`--packages=external` 打包下也照常内联。
- 行尾统一 **LF**（与上游 git blob 一致，也与本仓库 `.gitattributes` 的 `* text=auto eol=lf` 一致）；
  复制时未做任何字节改写。

## 升级流程（重新 vendor）

必须整目录替换、review diff，不允许手改 vendor 源文件：

1. 取新提交（**必须关掉 autocrlf 取 blob 字节**，否则 Windows 工作区会变 CRLF）：
   ```powershell
   git clone https://github.com/ranxianglei/billion-context <tmp>/billion-context
   git -C <tmp>/billion-context checkout <new-sha>
   ```
2. 先做**只读 diff**（决定是否值得升级、有没有新增依赖/非 `.js` 说明符/CJS 产物）：
   ```powershell
   git -C <tmp>/billion-context -c core.autocrlf=false archive --format=tar -o <tmp>/kernel.tar HEAD kernel
   tar -xf <tmp>/kernel.tar -C <tmp>
   git diff --no-index --stat vendor/acp-kernel/src <tmp>/kernel/src
   ```
   若上游新增 runtime dependency、`src` 出现非相对 import、或不再是 ESM/零依赖，停止并单独评审。
3. **全量替换**（不做选择性打补丁）：
   ```powershell
   Remove-Item vendor/acp-kernel/src -Recurse -Force
   robocopy <tmp>/kernel/src vendor/acp-kernel/src /E
   Copy-Item <tmp>/kernel/LICENSE      vendor/acp-kernel/LICENSE -Force
   Copy-Item <tmp>/kernel/README.md    vendor/acp-kernel/README.md -Force
   Copy-Item <tmp>/kernel/PROVENANCE.md vendor/acp-kernel/PROVENANCE.md -Force
   Copy-Item <tmp>/kernel/package.json vendor/acp-kernel/PACKAGE.json.txt -Force
   ```
   然后逐文件校验字节：`git -C <tmp>/billion-context hash-object --no-filters <vendor-file>`
   应等于 `git -C <tmp>/billion-context ls-tree -r HEAD -- kernel/...` 里的 blob SHA1；同时确认
   vendor 内 **0 个 CRLF 文件**。
4. 更新本文件与 `docs/third-party/acp-kernel-NOTICE.md` 的 **SHA / 版本 / 复制日期 / 文件数**。
5. 验证（全绿才算升级完成）：
   - 单独 typecheck vendor（用仓库同款编译选项，0 错误）；
   - `esbuild vendor/acp-kernel/src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=<工作区探针>.mjs` 0 错误；
   - 探针创建 core/state/config 并跑一次 `processTurn`；
   - `pnpm -s typecheck`；`pnpm -s test:durable-context-management`（及依赖它的 `test:durable-bot`）。

## 许可与署名（必须随产品保留）

- `acp-kernel` 是 **MIT**，但 LICENSE 末尾带一条**附加条款**：任何终端用户可见/可交互的产品或服务，
  须在**产品首页 / 文档 / “关于·致谢·Acknowledgements”页面**至少一处显著署名，说明使用了
  acp-kernel（涉及时包括 billion-context）并链接
  https://github.com/ranxianglei/acp-kernel（及 https://github.com/ranxianglei/billion-context）。
  纯服务端/内嵌无界面用途，随附文档中有声明即可。
- 本仓库的落实位置：
  - `docs/third-party/acp-kernel-NOTICE.md`（随安装包发布；含 MIT 全文 + 附加条款 + 固定 SHA）；
  - 应用内“设置 → 帮助与反馈 / 关于”面板的署名行（见 `src/renderer/src/components/settings/SettingsModal.tsx` 的 `HelpTab`）。
- 全量许可原文见本目录 `LICENSE`；MIT 来源说明（独立重写、非 AGPL 衍生）见 `PROVENANCE.md`。
  分发/修改 vendor 代码时不得移除版权头或本条署名要求。