# MyBuddy Pi 0.87.1 对话分支验收

日期：2026-09-25

## 结果

最终验收通过。范围是本次分支、重试、工作区边界相关的 15 组专项测试、TypeScript 检查、生产构建，以及真实 Electron / Pi / 模型端到端测试；不是全仓所有无关测试。

真实模型：`commandcode/deepseek/deepseek-v4.1-flash`。真实端到端断言：48/48，涵盖 9 个真实模型场景。测试配置、数据库和工作目录完全独立，临时 profile 已清理。

## 修复内容

1. 产物继承使用原生 toolCall.id / toolResult.toolCallId，并限制到 Pi getBranch(leafId)。
2. 修复生产启动顺序：Artifact Domain 初始化后才创建 ConversationBranchService。
3. 用户序号与当前可见的 Pi 分支及压缩投影一致；分支、重新生成、删除传递真实 entry ID。
4. 重新生成成功后更新 UI 中保留的 user entry ID；处理 navigateTree 对当前 leaf 的 no-op，避免重复 user。
5. user-only 分支保留 Pi 生成的子会话、标签和来源关系，仅补必要的即时落盘；不再额外创建第二个 Session。
6. Task / 血缘 / 继承用量水位同事务提交，失败不残留已提交的 child Task。
7. 独立分支提示当前文件位置；现有文件策略拦截来源目录旧绝对路径，避免原生 read/write/edit/grep/find/ls 误操作父副本；保留共享工作区及显式任务授权语义。此修复不是新增 OS 级沙箱。

## 真实任务验证

- selected actual Pi provider is available
- branching a running real task is rejected
- parent-base: actual model completed without runtime error
- parent-base: real response persisted
- task workspace is isolated from user files
- real model used native write
- real base file contains expected content
- parent-later: actual model completed without runtime error
- parent-later: real response persisted
- real tools registered two parent artifacts
- UI fork creates independent task and session
- child history stops at selected reply
- native first-turn artifact inherited
- native later-turn artifact not inherited
- parent session unchanged by fork
- current snapshot is explicitly current, not historical rollback
- child-context: actual model completed without runtime error
- child-context: real response persisted
- real model receives the inherited branch context
- child-edit: actual model completed without runtime error
- child-edit: real response persisted
- child real file changed
- parent real file remains unchanged
- cold restart preserves exact Pi history
- cold restart restores branch lineage UI
- regenerate-middle: actual model completed without runtime error
- regenerate-middle: real response persisted
- middle regenerate excludes abandoned later user
- abandoned path retained in native tree
- fresh-path: actual model completed without runtime error
- fresh-path: real response persisted
- regenerate-fresh-1: actual model completed without runtime error
- regenerate-fresh-1: real response persisted
- regenerate-fresh-2: actual model completed without runtime error
- regenerate-fresh-2: real response persisted
- repeated regenerate does not duplicate active users
- repeated regenerate follows current path, not abandoned same-index user
- native tree keeps history while active projection excludes abandoned edit
- all child operations leave parent session unchanged
- delete removes only selected current-path user and its reply
- delete retains abandoned native tree without restoring it to context
- user-only task is created with persisted session
- user-only-generate: actual model completed without runtime error
- user-only-generate: real response persisted
- user-only regeneration returns success
- current-leaf no-op cannot duplicate the root user
- real root-only model task writes its own file
- no renderer exceptions across real tasks and restart

## 验收证据

- 最终汇总：`out/tests/branch-review/acceptance-final.json`
- 最终专项测试：`out/tests/branch-review/checks.json`、`checks.log`
- 生产构建：`out/tests/branch-review/acceptance.json` 中 build 步骤，exit code 0（该批最初 live 步骤遇到连接错误，原失败记录保留，没有覆盖成成功）
- 同构建完整复跑：`out/tests/branch-review/live.json`，exit code 0
- 真实任务详细记录和截图：`out/tests/conversation-branch-live/`

过程中真实测试先后发现两项产品错误，修复后通过；另出现一次 Connection error，同一生产构建完整复跑后未再复现，连接错误根因未确认，失败证据仍保留。

## 复现

`pnpm run test:conversation-branch:native`

`pnpm run test:conversation-branch:workspace`

生产构建后运行 `pnpm run test:conversation-branch:live`。该命令使用已配置真实模型并可能产生模型费用；可通过环境变量 `MYBUDDY_BRANCH_LIVE_MODEL` 显式指定可用模型。

Git 未自动提交。所有变更源码保持 LF，git diff --check 通过。
