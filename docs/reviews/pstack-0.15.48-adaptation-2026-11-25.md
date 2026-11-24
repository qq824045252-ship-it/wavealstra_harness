# pstack 0.15.48 原生适配验收

日期：2026-11-25（Asia/Shanghai）。MyBuddy 修改前基线为 `54e9642ced1a61fd2e89b9c5f462355bc3942745`，工作分支为 `main`。

上游对照：[cursor/plugins@9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc/pstack](https://github.com/cursor/plugins/tree/9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc/pstack)，版本 0.15.48。功能说明及运行条件见 [pstack in MyBuddy](../pstack-mybuddy.md)。

## 覆盖范围

本次补齐原先缺少的 8 个上游命令：`reframe`、`sharpen`、`in-your-own-words`、`ketchup`、`ketchup-video`、`create-formal-verification-skill`、`maintain-formal-verification-skill`、`statechart`。目录现含完整 35 个上游方法、24 条原则、Thermos，以及 22 个上游剧本和 MyBuddy 原生 `orchestrate` 扩展。既有 17 个角色配置继续保留。

本次同时修改实际行为：普通委派继承完整用户要求及纠正，盲评保留材料隔离；Arena 拒绝同厂商或不可确认厂商的裁判；Interrogate 必须执行隔离试验并由主代理重跑；只读代码审查默认转到 Thermos。纯文本方法可以完成而不伪造工作区观察；Ketchup 不替换活动流程；高级产物须有真实文件、执行身份和稳定版本。

执行沿用 MyBuddy 的 Durable 会话、子代理、原生 shell 与既有权限，没有新增会话执行内核。Statechart 的 31 个上游运行文件约 136 KB，原样固定版本，附许可及 SHA256 清单，并加入应用资源配置。没有新增 npm 运行依赖，也没有变更应用版本或构建安装包。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | Web、Node、scripts 全部通过；scripts 0 错误、0 基线、0 新增。最后一次串行执行 exit 0。 |
| `TLA2TOOLS=<已验证的 1.7.4 jar> node scripts/test-all.mjs --filter=pstack --jobs=2` | 10 组通过，0 失败，0 已知失败，0 新增回归，约 0.6 分钟。 |
| `pnpm -s test:local-workflow` | 通过，含实际 AgentService、持久会话、本地 HTTP 模型、子代理、定时器、授权与 provider 恢复。 |
| `pnpm -s test:mode` | 91 passed，0 failed。 |
| `pnpm -s test:mode-preset` | 186 passed，0 failed。 |
| `pnpm -s test:durable-subagent` | 通过，含实际子会话、恢复、模型/工作目录绑定、并行冲突与取消。 |
| `pnpm -s test:subagent-worktree` | 通过，实际临时 Git 仓库的隔离、失败与取消。 |
| `git diff --check` | 通过。 |

10 组 pstack 检查分别为 catalog、decision-trail、advanced-artifacts、eval、orchestration、interrogate、watch、worker-contract、statechart、workflow。集中测试不等同于整个仓库的全量 headless 套件。

### 执行证据

- Reframe 用本地 HTTP 服务和真实 `fetch_content` 调用检查成功来源、404 和未读取来源；只有八项实际读取成功后才能通过。Own/sharpen 在无工作区观察时正常完成，原生写入被拒；Ketchup 调用前后持久状态完全相同。
- Interrogate 在真实临时 Git worktree 内执行失败断言，再由父会话经原生 shell 重跑同一命令。错 task、错会话、错命令、错输出、未结算、修改源码、修改复现、陈旧版本及旧纯文本回执都被拒绝。不再复现的候选从确认缺陷中排除。直接剧本阶段及嵌套方法同样验收。
- Video 实际生成 6 秒横屏静音字幕 MP4，经 ffprobe、ffmpeg 解码、逐页匹配与时长测量，并校验原生图片读取身份。只读 Work 的真实 admission 将 `pstack_video_inspect` 识别为写操作并在执行前拒绝，原生只读工具仍可执行。
- Statechart 使用 Java 和 TLC 1.7.4 实际运行通过模型、最短反例和无效模型。工具重放复用真实产物，不重复执行；输入变化后旧回执失效。退出码 1 表示反例，不能作为编译器错误或通过结果。
- Formal 的检查实际对实现变体失败、恢复后成功。清单绑定原生检查输入版本；干净 tracked 文件不出现在 delta 快照时，回读原检查 commit 的 Git blob，不能用更新后的清单 digest 冒充旧版本。源码或检查脚本在 clean 后变化，即使更新清单也被拒绝。

测试期间发现并修复了 Pi 文档 overlay 新数组就地 push 未持久化、只读代码审查默认路由不兼容执行审查、普通剧本阶段漏掉主代理复跑、旧形式验证回执可误绑定新文件，以及视频工具写操作未进入 Work admission 分类的问题。额外修复 `local-workflow-extension.ts` 中已不存在的 `visibleJobs()` 调用，继续按当前任务和授权可见范围返回调度列表。

项目校验的最小 fixture 显式使用 npm。pnpm 在无依赖的临时项目中自动安装会生成 lockfile 和 metadata，生产门禁正确判定为工作区变化；本次没有为测试放宽该门禁或排除这些文件。

## 未通过与未覆盖范围

`test:architecture` 为 271 通过、2 失败：旧 working preset 数量断言，以及主入口委派的字符串断言。在独立的只读基线快照 `54e9642` 上完整重跑，结果同为 271/2，失败项完全相同。本次未修改其断言、生产对应模块或失败基线。

`test:pstack-settings-ui` 的 renderer/store 编译成功，但当前 Linux 环境没有 X server / `$DISPLAY`，Electron SIGTRAP 退出，且没有 `xvfb-run`。这不算 GUI 通过。本次没有运行 Windows 实机、安装包、全量 GUI 或真实外部多模型供应商验收；可控模型 fixture 的输出不等同于真实供应商表现。

外部运行依赖仍然存在：Arena 需要已配置且被允许的不同厂商模型；Interrogate 需要命令执行权限、Git 隔离和干净的被审查提交；视频需要 ffmpeg/ffprobe；Statechart 需要 Java/TLC。依赖不满足时明确阻塞，不能将其登记为成功。
