# 当前版本修复的编译测试结果

本页为 a34dbdd 提交前的记录。其后四项审核修复、历史窗口、真实桌面与手机组件的验收结果及原始输出见[后续工作区验收](review-a34dbdd/README.md)。

用户明确授权“编译测试，不要打包”。本轮使用开发输出及隔离夹具，没有生成发行包。

| 检查 | 最终结果 | 日志 |
| --- | --- | --- |
| 主程序开发构建 `pnpm -s build` | 通过 | historical-build.log |
| 手机端构建 `pnpm -s remote:build` | 通过 | review-remote-build.log |
| 主程序类型检查 `pnpm -s typecheck` | 通过；脚本错误与基线均为 0 | historical-typecheck.log |
| 手机端类型检查 `pnpm -s remote:typecheck` | 通过 | historical-remote-typecheck.log |
| 完整 headless 门禁 `pnpm -s test:all` | 298 通过，0 失败，包含串行性能测试 | historical-test-all.log |
| 开发输出中的原生 Durable 自检 | 前轮通过：原生子任务和重启回执，副作用执行次数 1 | review-native-runtime.log |
| 真实图片 worker 缩放与 WASM 校验 | 前轮通过：100×200 PNG 缩放至 20×40，源与输出 WASM 哈希一致 | review-image-resize-assets.log |

五项修复的定向行为用例均通过：跨 epoch 同步、原生对话分支、任务目录模型准入、丢失响应后的操作去重、原生费用保留。

构建测试发现并修复了 SDK 总出口带入 CLI、旧子代理图片资源要求，以及过期架构断言和会诊测试等待死锁。随后按用户要求修复全部历史类型错误：类型基线从 188 减至 160，最终清零，没有新增条目。原始脚本编译也无错误；类型检查现在包含导入的源码，并拒绝扩大基线。完整门禁中的 `test:typecheck-guard` 已验证配置错误、导入错误及扩大基线均被拦截。测试失败基线未修改。

本次未运行 GUI、联网、数据集及安装包验收；不能将 headless 通过解释为这些验收完成。版本仍为 0.1.107，修改尚未提交或推送。
