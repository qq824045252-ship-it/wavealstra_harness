# Pi 四核心工具原生化

2026-10-02。此记录取代此前将 Pi 主循环迁移称为整个工具执行链原生化的结论。

## 实现

主会话的 `read`、`write`、`edit`、`bash` 由 Pi 1.0.0 注册和执行。MyBuddy 不再同名注册、替换文件系统操作、强制读回验证、要求宿主执行身份、重写返回内容、压缩 Bash 模型输出或注入任务隔离环境。Pi 原生 PowerShell 同样不进入宿主执行钩子。

已删除 `verified-write-extension`、`verified-edit-extension`、`task-bash-isolation-extension`、`task-workspace-guard-extension`、`PiShellOutput`、`backup-extension`、`VerifiedShellExecution`、`FileContentVerifier` 和 `AgentShellRuntime`。文件 SHA 验证器与 Shell 验证器、旧专用测试、回归清单引用、Shell/权限/外部写限制提示词、核心工具危险标记和自动备份配置也已移除。历史文件备份仍可由用户列表查看和手动还原；历史执行记录不会重新投射原生工具恢复提示。

生产装配中的权限、计划和 MCP 钩子不会审批、阻止或改写可用的 Pi 内置工具。用户明确选择的只读工具范围、Tag deny 和命令能力开关仍通过 Pi `excludeTools` 配置；不存在切换回旧执行覆盖的开关。可选 `execute_code`、CAD 和 MCP 产品工具的进程/外部系统审计属于各自功能，不接入四核心工具。

此外删除了依赖补丁中对 `dist/core/sdk.js` 恢复会话工具选择的改写。当前安装 SDK 与归档官方 1.0.0 SDK 的 SHA-256 相同：`fe643170de3d259c7e06179d9e18270a009dfb54df915f6e3de515425b8d009b`。保留的依赖补丁用于嵌入资源路径、CodeMode 和 MCP 宿主接口，不覆盖四工具或 SDK 恢复工具选择。锁文件仅针对这项修改更新 Pi patch hash。

## 验证

- `test:pi-native-core-tools`：16 项通过。真实生产 Assembler → Pi AgentSession → 最终工具注册表/execute；核对四工具 builtin 来源，并与无产品扩展的纯 Pi 会话比较成功结果、错误、取消信号、长输出及实际 Bash 取消。宿主权限、上下文、审批和验证桥调用次数为 0。
- 恢复会话的窄回归：历史工具为四项，当前 `settings.defaultTools=["read"]`，未传 `tools/noTools/excludeTools`。旧 SDK 补丁下错误启用四项；删除补丁后只启用 `read`。修复前失败与修复后结果均保留在 `artifacts/pi-native-core-tools/`。
- 架构 322 项、宿主控制 32 项、宿主原生集成 16 项、Pi MCP 迁移 16 项、自主执行 4 项及相邻产品授权、工作区、分支、恢复测试通过。
- 类型检查、桌面构建、本机 Bash/JavaScript/PowerShell 实测、历史备份还原和设置页 Electron 检查通过。
- 最终打包版真实模型桌面验收 3/3 通过：顺序执行四核心工具且保留 Pi 返回文本；实际 Bash 单次退出码 7；长进程启动后取消并等待 10 秒，无迟到副作用。模型为 `commandcode/deepseek/deepseek-v4.1-flash-fast`，Renderer 无错误，隔离测试凭据已清理。
- 已验收 `app.asar` SHA-256：`96dcf9e9295a6c19607ea40eb6894ba22b683e57e6d54bfd10a8e4cd554c1922`。

实际新打包桌面/模型验收及部署结果以 `artifacts/pi-native-core/desktop-live/results.json` 和 `artifacts/pi-native-core-tools/deployment.json` 为准。Node SDK 集成通过本身不代表已替换用户正在运行的旧实例。

## 实际部署与后台恢复

已将原有桌面 MyBuddy 快捷方式切换到上述已验收的新包，并保留原包和一致性校验通过的用户数据库备份。当前实际主实例为 PID 33096，创建于 2026-10-02 12:36:13（北京时间）。

首次部署启动的实例在辅助进程结束附近退出，没有取得退出码，也未发现对应 Windows Application Error / WER 事件，不能据此认定为应用崩溃。部署脚本已改用 `Shell.Application.ShellExecute` 启动，并增加辅助进程完全结束后的独立存活验证；桌面验收清理已确认只操作其隔离测试实例。

独立验证通过：同一 PID 和创建时间持续存在，启动父进程已经结束，界面 Renderer 正常，远程健康接口和应用 HTML 均返回 200。Windows Job 查询也确认当前主实例不在本次工具辅助进程的 Job 中。具体时间、程序包哈希、入口与备份路径见部署报告的 `postHelperPersistence`。
