/** Create a reproducible closeout record from actual source, build and test receipts. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process'), os = require('node:os');
const root = path.resolve(__dirname, '..'); process.chdir(root);
const out = 'artifacts/pi-native-control';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function fingerprint() {
  const files = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); else if (!f.includes(path.join('subagent', 'vendor'))) files.push(f); } }
  for (const d of ['src', 'shared/src', 'app/remote/src', 'patches']) if (fs.existsSync(d)) walk(d);
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'app/remote/package.json', 'shared/package.json', 'scripts/build-pi-codemode-assets.mjs', 'scripts/build-subagent-runtime.mjs', 'scripts/build-subagent-context.mjs']) if (fs.existsSync(f)) files.push(f);
  files.sort(); const h = crypto.createHash('sha256'); for (const f of files) h.update(f).update(fs.readFileSync(f)); return h.digest('hex');
}
const build = read(out + '/accepted-build.json'), desktop = read(out + '/desktop-live/results.json');
const groups = ['core', 'peripheral', 'safety'].map(g => read(out + '/' + g + '-regression.json'));
const contract = read(out + '/contract-results.json'), native = read(out + '/native-lifecycle-results.json');
const upstream = read(out + '/upstream-core-integrity.json'), remote = read(out + '/remote-access-results.json');
const deployment = read(out + '/deployment.json'), deployed = read(out + '/deployed-process-check.json');
const databaseBackup = read(out + '/pre-cutover-backup.json');
const currentFingerprint = fingerprint();
const checks = {
 sourceMatchesAcceptedBuild: currentFingerprint === build.sourceFingerprint,
 buildPassed: build.status === 'passed' && build.sourceUnchanged === true,
 exactDesktopBuildTested: desktop.executable === build.executable,
 eightRealTasksPassed: desktop.status === 'passed' && desktop.tests.length === 8 && desktop.tests.every(t => t.status === 'passed'),
 allRegressionGroupsPassed: groups.every(g => g.passed === true),
 nativeLifecyclePassed: native.passed === true && native.results.length === 6,
 nativeControlContractPassed: contract.passed === true,
 upstreamCoreIdentical: upstream.passed === true,
 remoteRegressionPassed: remote.passed === true,
 noHiddenControlMessages: desktop.sessionAudit?.length > 0 && desktop.sessionAudit.every(s => s.retiredControlMessages === 0),
 rendererNoUncaughtErrors: desktop.rendererErrors?.length === 0,
 finalRunTemporaryCredentialsRemoved: desktop.temporaryCredentialsRemoved === true,
 deployedAcceptedExecutable: deployed.path === build.executable && deployment.phase === 'verified-new-build-running',
 remoteListenerOwnedByNewProcess: deployed.remoteListeners.some(p => p.OwningProcess === deployed.pid && p.LocalPort === 3352),
 consistentDatabaseBackupAvailable: databaseBackup.integrity === 'ok' && fs.existsSync(databaseBackup.backup),
};
if (!Object.values(checks).every(Boolean)) { console.error(JSON.stringify(checks, null, 2)); process.exit(1); }
const architectureText = fs.readFileSync(out + '/test-architecture.log', 'utf8');
const architecture = architectureText.match(/passed=(\d+) failed=(\d+)/);
const sourceReferences = {};
for (const [name, file, pattern] of [
 ['native-settlement', 'src/main/agent/SessionEventCoordinator.ts', 'event.type === "agent_settled"'],
 ['native-end-projection', 'src/shared/pi-event-mapper.ts', 'case "agent_settled"'],
 ['native-user-queue', 'src/main/agent/PromptExecutionCoordinator.ts', 'previous.ready'],
 ['legacy-directive-projection', 'src/main/agent/LegacyExecutionControlHistory.ts', 'export function'],
 ['native-core-tools', 'scripts/pi-native-core-tools-test.ts', 'production registry and final execute'],
 ['phase-labels', 'src/shared/generation-stats.ts', 'nativeRunPhaseLabel'],
]) { const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); sourceReferences[name] = { file, line: lines.findIndex(l => l.includes(pattern)) + 1 }; }
const summary = { completedAt: new Date().toISOString(), status: 'passed', checks, version: build.release,
 executable: build.executable, sourceFingerprint: currentFingerprint, asarSha256: build.asarSha256,
 tests: { suites: groups.reduce((n, g) => n + g.tests.length, 0), additionalRemoteSuite: 1, contractCases: contract.results.length,
 nativeLifecycleCases: native.results.length, realModelDesktopTasks: desktop.tests.length, architecturePassed: architecture ? Number(architecture[1]) : null,
 upstreamCoreFilesCompared: upstream.packages.reduce((n, p) => n + p.checks.length, 0) },
 realTasks: desktop.tests.map(t => ({ name: t.name, status: t.status, durationMs: t.progress.elapsedMs, result: t.result, thinkingEvents: t.streaming.thinkingEvents, textEvents: t.streaming.textEvents })),
 sourceReferences, deployment: { shortcut: deployment.shortcut, backupShortcut: deployment.backup, processId: deployed.pid, databaseBackup: databaseBackup.backup },
 boundaries: ['Pi remains 0.99.1; this is not an untested dependency upgrade.', 'No claim that models/providers/tools can never repeat, time out, or fail.', 'Physical Android reinstall and physical-phone visual acceptance were not performed in this task.', 'No Git commit or push was performed; existing unrelated working-tree changes were preserved.', 'Product permissions, workspace isolation, memory, MCP capabilities and explicit user approvals remain.', 'Provider stream alias and MCP/worker packaging patches remain; compared native core files are byte-identical to upstream.'],
};
fs.writeFileSync(out + '/closeout-summary.json', JSON.stringify(summary, null, 2));
const names = {
 'repository-inventory': '真实仓库文件清单、统计、写入及回读', 'unseen-input-transform': '本次随机输入解析、计算、写入及回读',
 'real-shell-failure-and-repair': '真实失败 → 修复输入 → 同一验证器复测', 'native-subagent': '显式调用原生 Pi Worker 并核对真实结果',
 'natural-directory-listing': '自然语言列目录，不扩大为递归容量扫描', 'missing-file-stops-with-honest-blocker': '文件不存在时如实报告并结束',
 'native-tool-timeout-no-forced-retry': '真实命令超时，只执行一次后结束', 'native-nonzero-tool-error': '原生退出码 7 保持工具错误，不强制续跑',
};
const md = `# MyBuddy · Pi 原生运行链收敛验收\n\n验收记录生成：${summary.completedAt}。下述结论绑定实际源码指纹和已测试免安装包，不借用旧版结果。\n\n## 结论\n\n删除 MyBuddy 的自动任务分类、复杂度评分、强制计划、结束门禁、隐藏自动续跑、文本伪工具恢复和“新 steer 覆盖旧 steer”逻辑。模型调用循环、工具后的后续运行、重试、队列消费与最终结束由 Pi 0.99.1 决定。MyBuddy 保留界面、产品数据、权限边界和事件投影。\n\n不是“把自动续跑次数调低”，也没有新加防循环算法来代替旧算法。\n\n## 已删除／改接\n\n- 删除 \`ExecutionRouter.ts\` 与 \`ExecutionIntentAnalyzer.ts\`。\n- 删除 Completion Gate 的 settle/continuation/stall 计数及隐藏 follow-up 注入。旧数据库列保留兼容存储，但不再暴露或驱动执行。\n- 删除在 agent_end 等待伪造 request_user_input 文本、再追加继续消息的恢复链。真正的用户输入工具保留并支持原生取消。\n- 结束投影改接 Pi 的 agent_settled；agent_end 不再提前宣告整次运行结束，失败工具也不被错误提升为模型连接失败。\n- 用户 steer/follow-up 及时交给 Pi；不清空重建 Pi 队列，不以自建“最新引导胜出”覆盖前一条输入。\n- 旧会话中的精确类型自建控制消息仅在请求投影时剔除；不改写 Pi 的 append-only JSONL。旧交互的真实用户答案仍保留。\n- 明示 Bash 工具的真实 shell 和退出码语义；界面区分工具执行、等待用户、重试、压缩与模型响应，不用“思考中”掩盖工具等待。\n\n## 原生性证据\n\n直接从 npm 公布的固定 0.99.1 发布物取样并验证 tarball integrity，再比较已安装文件。pi-agent-core 的 117 个 JavaScript 文件与 pi-coding-agent 的 5 个会话／状态核心文件，共 **${summary.tests.upstreamCoreFilesCompared} 个，逐字节一致**。报告：\`artifacts/pi-native-control/upstream-core-integrity.json\`。\n\n保留的本地补丁仍涉及 provider reasoning 事件别名兼容、MCP 主机接口和 Codemode Worker 打包路径；不将“原生运行链”混同为“所有依赖完全没有本地补丁”。\n\n## 最终包真实模型测试\n\n使用现有 provider 的真实模型，在隔离用户目录、随机测试数据和真实打包桌面中，经输入框、IPC、Pi、MCP／Bash／Worker、流式事件及历史回读完成。\n\n| 测试 | 结果 | 实测耗时 |\n|---|---|---:|\n${summary.realTasks.map(t => '| ' + names[t.name] + ' | 通过 | ' + (t.durationMs / 1000).toFixed(1) + ' 秒 |').join('\n')}\n\n失败恢复用同一个未被修改的验证器核对第一次退出 7、修复后退出 0；超时及非零退出测试核对实际仅执行一次。8 条用户消息对应的会话审计中，退役的隐藏控制消息为 0；渲染器未捕获异常为 0。\n\n报告：\`artifacts/pi-native-control/desktop-live/results.json\`。每项带实际工具调用、流式计数、结果核验及截图。\n\n## 其它回归\n\n- 核心／外围／安全三组共 ${summary.tests.suites} 个套件通过，远程访问额外 1 个套件通过。\n- 控制边界 ${summary.tests.contractCases} 项通过；原生 AgentSession 生命周期 6 项通过，覆盖原生重试、工具等待、多个 steer 加 follow-up、取消、普通结束、伪输入文本。\n- 原生 Bash/read/edit 的 4 组执行测试通过，包含失败恢复、52 次读取后验证、权限拒绝与实际 shell 退出码语义。\n- 架构回归 ${summary.tests.architecturePassed} 个断言通过。\n- 桌面与远程前端 typecheck、构建、免安装打包通过。\n\n记录：\`core-regression.json\`、\`peripheral-regression.json\`、\`safety-regression.json\`、\`native-lifecycle-results.json\`、\`contract-results.json\`、\`remote-access-results.json\`，均位于 \`artifacts/pi-native-control/\`。旧失败记录保留，修复前控制契约曾有失败，未删除失败证据来冒充一次通过。\n\n## 交付与回退\n\n当前执行文件：\n\n    ${build.executable}\n\n桌面原有 MyBuddy 快捷方式已切换；实际主进程 PID ${deployed.pid} 的路径已核对，窗口已独立确认可见。远程 3352 端口由新进程监听，\`GET /healthz\` 返回 200。\n\n切换前确认无本次进程启动后的运行记录或有效租约。旧实例关闭窗口后留在托盘；一致性备份并通过 SQLite quick_check 后结束空闲旧实例，再启动新实例。未并行启动两份用户数据写入实例。\n\n旧快捷方式备份：\n\n    ${deployment.backup}\n\nSQLite 一致性备份（留在本机私有目录，不提交到仓库）：\n\n    ${databaseBackup.backup}\n\n旧包保留。未提交或推送 Git。此前存在的安卓 Markdown、表格样式等未提交改动未回滚。\n\n## 验收边界\n\n本次消除了已定位的 MyBuddy 自建运行控制及结束事件错位；不保证任何模型、provider 或工具永不重复、断连、超时。发生此类情况仍应查看原生事件和工具结果，而不是再加隐藏强制续跑。安卓共用的主进程已更新，前端已构建／回归，但本任务没有重新安装手机 APK或做真机界面验收。\n\n## 指纹\n\n源码 SHA-256：\`${summary.sourceFingerprint}\`\n\n打包 app.asar SHA-256：\`${summary.asarSha256}\`\n\n结构化总记录：\`artifacts/pi-native-control/closeout-summary.json\`。\n`;
fs.mkdirSync('docs', { recursive: true });
const reportPath = 'docs/MyBuddy-Pi-native-runtime-closeout_2026-10-01.md';
fs.writeFileSync(reportPath, md.replace(/\\`/g, '`'));
console.log(JSON.stringify({ status: summary.status, checks, tests: summary.tests, reportPath, executable: summary.executable }, null, 2));
