#!/usr/bin/env node
/**
 * test-all.mjs — 统一测试聚合门禁。
 *
 * 背景：仓库有 320+ 个 `test:*` 脚本，但既无聚合入口也无 CI，导致「过期常量」
 * （如断言 Pi 1.0.0 而实际 1.3.0）与「源码文本断言」长期腐烂而无人察觉。
 *
 * 设计（棘轮 ratchet，避免"上线即全红→被忽略"）：
 *   - default 套件只跑 headless 用例；GUI/NETWORK/DATASET/ARTIFACT 显式分类后再排除
 *     （见下方显式集合；ARTIFACT 由 CI 在完整构建后单独验收）。
 *   - GUI 类可用 `--include-gui` 单独放行（真实桌面会话）；`--include-live` 放行全部。
 *   - 与 scripts/test-baseline.json 中记录的已知失败对比：
 *       * 新增失败（回归）→ 退出码 1（门禁失败）
 *       * 已知失败仍失败 → 允许，但在输出中列出，债务保持可见
 *       * 已知失败现在通过 → 提示可更新 baseline（不算失败）
 *   - 未在 baseline 中且通过的用例正常通过。
 *
 * 用法：
 *   node scripts/test-all.mjs                    # default 套件（headless，并行池 + 串行负载敏感池）
 *   node scripts/test-all.mjs --include-gui      # default + GUI（需要真实桌面会话/Electron）
 *   node scripts/test-all.mjs --include-live     # 全部（GUI + NETWORK + DATASET + ARTIFACT）
 *   node scripts/test-all.mjs --artifacts-only   # 仅完整产品构建产物验收（不触发构建）
 *   node scripts/test-all.mjs --no-batch-build   # 使用原有逐脚本 pnpm/esbuild 入口
 *   node scripts/test-all.mjs --list             # 只列分类与选中的用例，不执行
 *   node scripts/test-all.mjs --audit            # 只做分类自检（GUI 清单 vs electron 命令）
 *   node scripts/test-all.mjs --update-baseline  # 记录当前失败集为基线
 *   node scripts/test-all.mjs --filter=memory    # 只跑名字含 memory 的
 *
 * 退出码：0 = 无新增失败；1 = 有新增失败；2 = 用法/环境错误。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestBundles } from "./test-bundle-pool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "test-baseline.json");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * 自身与聚合脚本：绝不能递归执行，否则 test:all 会 spawn 自己形成 fork 炸弹
 * （实测：会跑满 45 分钟以上、泄漏大量 node 进程，并把所有用例误判为失败）。
 */
const SELF_EXCLUDE_PATTERNS = [/^test:all/, /^test:verify/];

/**
 * 负载敏感 / 机器全局资源用例：
 *   · 性能用例断言墙钟预算（启动 p95、构建耗时等）；
 *   · Phase 2 recovery、Phase 5 native story 与 Gateway inbox crash 强杀并重开真实 SQLite/JSONL，
 *     且持有短期测试宿主租约；
 *   · gateway-port-fallback 直接绑定产品真实 webhook 端口（52140 / 52330 / 52490 / 39140 / 39141）。
 *     并行池里任何启动 GatewayLifecycleManager 的用例都会抢同一批端口，把「首选可用时不回退」
 *     偶发判红（实测 2026-11-08 全量跑出现过一次，单独跑与第二次全量均 PASS）。端口是机器全局资源，
 *     不能靠重试或放宽容错来掩盖，只能与其它用例串行。
 * CPU/IO 争用会干扰性能预算或进程/租约交接，故崩溃套件也走串行池。
 * 它们在并行池跑完后串行执行（JOBS=1），并且 `core-performance-all`
 * 内部还会再跑一遍同类用例，所以性能用例仍放在最后。
 * 不跳过用例、不重试失败，也不调整 timeout 或失败基线。
 */
const SERIAL_TEST_PATTERNS = [/^test:memory-semantic-scale$/,/^test:durable-storage-(current|lease)$/,/^test:core-performance/, /^test:bot-work-query-scale$/, /^test:bot-work-summary-query$/, /^test:bot-work-phase2-recovery$/, /^test:bot-work-phase5-native-story$/, /^test:gateway-inbox-crash$/, /^test:gateway-port-fallback$/];

/**
 * 排除集合按执行前置条件分类（+ 一个临时桶），默认套件只跑 headless 用例：
 *
 *   GUI     真实桌面会话/Electron 窗口（--include-gui 放行）
 *   NETWORK 联网、远程设备、浏览器自动化、本地端口服务（--include-live 放行）
 *   DATASET 依赖本机数据集或原生模块（--include-live 放行）
 *   ARTIFACT 验证真实完整产品构建产物（--artifacts-only / --include-artifacts 放行）
 *   KNOWN_HEADLESS_RED 临时桶：本身 headless，但当前是既有红（见各项原因），
 *           修好后必须移回 default；只有 --include-live 会跑到，避免把它藏进 GUI job。
 *
 * 清单以"显式名字"为准（审计 artifacts/audit-2026-10-26/gate-test-debt.md §2-3）：
 * 名字正则只做新用例的兜底，不能判断一个用例到底会不会启动 Electron
 * （历史教训：`-ui$` 与 `:desktop$` 都曾漏出 GUI 用例，混进"无头"门禁）。
 */
const GUI_TESTS = new Set([
  "test:resident-host-dev",
  "test:resident-host",
  "test:saved-preview-desktop", // real Electron saved-version protocol and UI
  "test:compaction-settings-dev", // actual app, native window bounds, settings IPC, light/dark layouts
  "test:bot-collaboration-ui",
  "test:workspace-files-sort-desktop", // real Electron workspace tree + production filesystem A/B
  "test:usage-dashboard-dev", // actual pnpm dev app, isolated synthetic usage ledger
  "test:browser-tabs-ui",
  "test:browser-tabs-electron",
  "test:gadget-browser-recovery-electron",
  "test:gadget-save-workspace-desktop",
  "test:gadget-save-copies-desktop",
  "test:gadget-menu-dev",
  "test:browser-builtin-electron",
  "test:browser-task-execution-electron",
  "test:bot-add-menu-desktop",
  "test:diagnostics-cache-ui",
  "test:bot-display-groups-ui",
  "test:model-menu-ui",
  "test:bot-conversation-concurrent-desktop",
  "test:bot-scroll-desktop",
  "test:bot-history-paging-desktop",
  "test:bot-activity-desktop",
  "test:bot-rename-desktop",
  "test:bot-report-dedup-desktop",
  "test:bot-message-actions-desktop",
  "test:bot-work-browser-desktop",
  "test:bot-team-removal-desktop",
  "test:bot-work-detail-desktop",
  "test:work-record-archive-desktop",
  "test:bot-work-conversation-desktop",
  "test:bot-work-delivery-desktop",
  "test:bot-work-browser-dev",
  "test:work-artifact-desktop",
  "test:bot-settings-dev",
  "test:acp-menu-dev", // actual pnpm dev Electron, isolated profile and seeded ACP catalog
  "test:bot-work-recovery-dev",
  "test:bot-work-phase5:dev",
  "test:bot-work-phase3:dev",
  "test:bot-work-phase3-focus-desktop",
  "test:bot-work-phase2:dev", // actual pnpm dev Electron renderer and isolated profile
  "test:media-capabilities-ui",
  "test:computer-use-behavior",
  "test:computer-use-agent-desktop",
  "test:workspace-notes-ui",
  "test:gadget-task-desktop",
  // 真 Electron 窗口（隐藏 BrowserWindow / 真实 UI 交互）
  "test:memory-ui",
  "test:memory-organization-desktop",
  "test:tray",
  "test:expert-ui",
  "test:project-create-folder-ui",
  "test:project-materials-ui",
  "test:project-activity-ui",
  "test:consult-card-ui",
  "test:overview-model-ui",
  "test:subagent-header-ui",
  "test:settings-records-ui",
  "test:svg-preview-resize",
  "test:consult-selection",
  "test:consult-entry:desktop",
  "test:mode-navigation:desktop",
  // Electron 运行时 / e2e
  "test:html-edit-electron",
  "test:local-capabilities-electron",
  "test:runtime-probe-electron",
  "test:browser-refresh",
  "test:browser-navbar-ui",
  "test:extension-toolbar-dev",
  "test:browser-screenshot-electron",
  // 性能用例里会 spawn 真实 Electron（core-performance-all 内部还串联 electron 用例）
  "test:core-performance-electron",
  "test:core-performance-mybuddy-startup",
  "test:core-performance-all",
  "test:pdf-runtime-e2e",
  "test:pdf-page-identity-e2e",
  "test:artifact-open-e2e",
  // -desktop
  "test:chat-attachment-acp-desktop",
  "test:expert-binding-desktop",
  "test:memory-lifecycle-desktop",
  "test:magpie-desktop",
  "test:multi-search-desktop",
  "test:durable-bot-desktop",
  "test:archive-deletion-desktop",
  "test:task-status-dot-desktop",
  "test:remote-task-dot-ui-desktop",
  "test:sidebar-space-collapse-desktop",
  "test:computer-use-desktop",
  // Windows 桌面自动化（UIA/真实桌面）
  "test:computer-use-recovery",
  "test:computer-automation",
  "test:computer-use-run",
  "test:computer-use-overlay",
  "test:computer-automation-windows",
  // Linux 原生 GTK/Electron 专用靶窗：AT-SPI + Hyprland/ydotool，无截图定位。
  // 缺真实会话/依赖会非零退出；开发后端与真实发行包分别报告。
  "test:computer-use-linux",
  "test:computer-use-linux:packaged",
]);

const NETWORK_TESTS = new Set([
  "test:bot-cross-channel-model-live",
  "test:bot-organization:live",
  "test:durable-context-dev:live", // real pnpm dev/Electron + configured online provider; isolated synthetic profile
  "test:bot-collaboration:live",
  "test:bot-completion-evidence:live", // six registered text task types with real result review
  "test:work-isolation-live", // isolated Electron + real model, six semantic tasks; not a headless substitute
  "test:bot-scheduling-live", // real Electron + configured real model; at least six task types per batch
  "test:google-workspace-write:live", // Real model/Electron with isolated local SDK fixture only.
  "test:google-workspace:live", // Real Electron/model; isolated synthetic gws process, no real account.
  "test:gadget-browser-recovery-live",
  "test:bot-history-context:live",
  "test:bot-peer-calls:live",
  "test:web-page-answer-runtime:live", // Real gateway model; output-pressure injection runs last.
  "test:browser-builtin-live",
  "test:browser-production-live",
  "test:bot-result-delivery:live",
  "test:bot-memory-live", // isolated pnpm dev desktop + configured live model
  "test:bot-watch:live",
  "test:bot-watch-intent:live",
  "test:gadget-agent-live",
  // 真实 Magpie 网关的缓存边界实验：要真凭据/网络/花费，缺 MYBUDDY_CACHE_LIVE=1 会自己 SKIP。
  "test:cache-live",
  "test:subagent:live",
  // 真机 ACP 冒烟：要真实 dsh CLI + 凭据 + 网络（缺 CLI 会自己 SKIP，但不该进无头门禁）。
  "test:acp-dsh-live",
  "test:remote-workspace-create",
  "test:remote-access",
  "test:remote-renderer-stdio",
  "test:remote-connection",
  "test:remote-done-ack",
  "test:remote-delete",
  "test:remote-task-cache",
  "test:remote-db",
  "test:compaction:live",
  "test:multi-model-consult:live",
  "test:conversation-branch:live",
  "test:task-status-dot:live",
  "test:acp-remote-android:live",
  "test:acp-remote-android-sync:live",
  "test:acp-remote-android-e2e:live",
  "test:remote-task-dot-android:live",
  "test:streaming-live",
  "test:multi-search-live",
  "test:durable-bot",
  "test:browser-automation-recovery",
]);

const DATASET_TESTS = new Set([
  "test:durable-context-cold-store", // Explicit large generated JSONL corpus (1K/10K/100K), not a per-edit default run.
  "test:google-workspace-write", // Existing POSIX Python runtime required for isolated SDK subprocess fixtures.
  // node-pty 原生模块 + 真实 pty。
  "test:terminal",
  "test:task-terminal:live",
]);

// These tests inspect real product bundles/embedded assets. Keep them explicit
// and mandatory after the CI build; a source-only test invocation never builds
// the product implicitly or treats missing output as a successful assertion.
const ARTIFACT_TESTS = new Set([
  "test:image-resize-assets",
  "test:oauth-build-assets",
  "test:pi-codemode-assets",
]);

/**
 * GUI 里"只在 Windows 上有意义"的用例：computer_* 系列依赖 UIA/Windows 桌面自动化，
 * 非 Windows 平台会直接断言 "requires Windows"（或在 Windows 专属验收里读真实 profile）。
 * 非 win32 上 `--include-gui` 会自动跳过它们并打印说明，避免本机 Linux 的 GUI 跑被
 * 平台限制污染；Windows 的 GUI job 仍然会跑。
 */
const GUI_WINDOWS_ONLY = new Set([
  "test:computer-use-behavior",
  "test:computer-use-agent-desktop",
  "test:computer-use-desktop",
  "test:computer-automation",
  "test:computer-use-run",
  "test:computer-use-overlay",
  "test:computer-automation-windows",
]);

/**
 * 平台限定用例：只在列出的 host 平台跑，其他平台整条跳过并在开跑前打印说明。
 *
 * 与 GUI_WINDOWS_ONLY 的区别：那个是"GUI 类里只有 Windows 有意义"的旧清单，只作用于
 * --include-gui；本表对 default / --include-gui / --include-live 全部生效，因为下面这些
 * 用例是按 host 平台探测真实后端能力的，跨平台跑必然红（实测 Windows 上两条必红）：
 *
 *   · test:computer-use-linux / :packaged — Linux Hyprland/Wayland GUI 验收。
 *   · test:atspi-transport — Linux Unix socket/D-Bus 真实传输测试，不等同于 GUI 验收。
 *
 * 标记原则：按"用例真实覆盖的后端"标，不是按"本机跑不过"标。能在两个平台都成立的断言
 * 应写成 host 无关（期望值用 join()/resolve() 拼，别写死 "/tmp/x"），不要塞进这张表。
 */
const PLATFORM_ONLY_TESTS = new Map([
  ["test:usage-dashboard-dev", ["linux"]], // real Linux dev app with owned-process cleanup
  ["test:bot-work-phase3:dev", ["windows"]],
  ["test:bot-work-phase3-focus-desktop", ["windows"]],
  ["test:bot-work-phase2:dev", ["windows"]], // Windows dev UI driver; Linux/Omarchy desktop acceptance remains separate.
  ["test:compaction-settings-dev", ["linux"]], // Exact-address native window acceptance on the Hyprland desktop.
  ["test:computer-use-linux", ["linux"]],
  ["test:computer-use-linux:packaged", ["linux"]],
  ["test:atspi-transport", ["linux"]],
  ["test:input-guardian-process", ["linux"]],
]);

/** 当前 host 的平台 id（与 src/shared/desktop-platform 的 PlatformId 对齐）。 */
const HOST_PLATFORM =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";

/** 临时桶：headless 但当前是既有红，先不进 default（否则门禁立刻红），也不要塞进 GUI
 * job 掩盖成"GUI 环境问题"。修好后删掉本项，让它回到 default。
 */
const KNOWN_HEADLESS_RED = new Set([
  // 目前为空。2026-10-27 清理时已删除 test:workspace-files-ui 的过时断言
  //（"项目资产可跳到侧边栏资料库"：ProjectAssets 已不再提供该入口），用例回到 default。
]);

/**
 * 显式 headless 白名单：名字看起来像 GUI/NETWORK，但实际是纯 node 静态断言。
 * 显式清单优先于下面的命名兜底，否则它们会被 `^test:browser-` 之类正则误伤。
 */
const HEADLESS_TESTS = new Set([
  "test:work-execution-isolation",
  "test:ui-automation-cancellation",
  "test:bot-work-result-artifacts",
  "test:work-result-lifecycle",
  "test:work-completion-recovery",
  "test:gateway-work-review",
  "test:bot-work-method-feedback",
  "test:bot-cross-channel-contract",
  "test:gateway-bot-binding",
  "test:bot-organization-primitives",
  "test:bot-organization",
  "test:bot-foreground-lifecycle",
  "test:durable-storage-current",
  "test:durable-context-live-assessment",
  "test:durable-context-active-view",
  "test:durable-context-entrypoints",
  "test:durable-context-window-matrix",
  "test:durable-storage-replay-api",
  "test:durable-storage-lease",
  "test:work-file-event-source", // Real local fs.watch + SQLite; no Electron or external source account.
  "test:gadget-save-copies",
  "test:bot-call-thread",
  "test:bot-peer-calls",
  "test:bot-reminders",
  "test:work-watch-goal",
  "test:bot-rename",
  "test:bot-team-conversation",
  "test:bot-active-requests",
  "test:bot-activity-monitor",
  "test:bot-work-query-scale",
  "test:durable-artifact-registration",
  "test:durable-work-liveness",
  "test:web-access-extract-runtime", // Default fixture is local; real weather request is opt-in.
  "test:chat-composer-ui", // React DOM behavior using linkedom; no Electron/display dependency.
  "test:cloudflared-cli-detect",
  "test:bot-report-images-ui",
  "test:work-conversation-feedback",
  "test:durable-close-retry",
  "test:durable-sqlite-close-retry",
  "test:work-feedback-incremental",
  "test:wechat-callback-auth",
  "test:wecom-media",
  "test:weixin-media",
  "test:qq-media",
  "test:feishu-media",
  "test:dingtalk-media",
  "test:slack-media",
  "test:gateway-media",
  "test:discord-media",
  "test:telegram-media",
  "test:bot-work-phase4-hook-fanout",
  "test:bot-work-phase4-offline-catchup",
  "test:bot-work-phase4-schedule-clock",
  "test:bot-work-phase4-causal-guard",
  "test:bot-work-no-quota",
  "test:bot-work-automatic-recovery",
  "test:bot-work-automatic-completion",
  "test:bot-work-phase4-backpressure",
  "test:bot-work-phase5-delivery-dedup",
  "test:bot-work-phase5-reconnect-diagnostics",
  "test:bot-work-phase5-e2e-story",
  "test:bot-work-phase5-gateway",
  "test:dingtalk-gateway",
  "test:discord-gateway",
  "test:gateway-provider-config",
  "test:gateway-platform-registry",
  "test:telegram-reply-routing",
  "test:qq-qr-integration",
  "test:qq-qr-ui",
  "test:qq-gateway",
  "test:lark-wecom-gateway",
  "test:weixin-gateway",
  "test:weixin-qr-integration",
  "test:weixin-qr-ui",
  "test:bot-summary-pagination",
  "test:bot-work-summary-query",
  "test:bot-work-phase5-owner-summary",
  "test:bot-work-phase5-review",
  "test:bot-work-phase5-review-ui",
  "test:bot-work-phase5-native-story",
  "test:remote-work-sync",

  "test:durable-projection",
  "test:durable-sync",
  "test:durable-tool-policy",
  "test:team-subagent-policy",
  "test:work-isolation-retirement",
  "test:work-budget-retirement",
  "test:work-effect-retirement",
  "test:bot-work-team-recovery",
  "test:bot-execution-diagnostics",
  "test:task-diagnostics",
  "test:durable-subagent",
  "test:durable-consult",
  "test:app-store-structure",
  "test:app-store-runtime",
  "test:app-store-transactions",
  "test:task-file-changes",
  "test:browser-benchmark-report",
  "test:browser-contract",
  "test:browser-durable-composition",
  "test:browser-open-guard", // 纯源码文本断言（stale preload 回归门），6/6 PASS
  "test:models-settings-overlay", // 纯源码文本断言，9/9 PASS
]);

/** 兜底规则：显式清单之外的新用例按命名约定归类（显式清单永远优先）。 */
const GUI_PATTERNS = [/-e2e$/, /-desktop$/, /-electron$/, /:desktop$/, /^test:computer-/];
const NETWORK_PATTERNS = [/:live$/, /^test:remote-/, /^test:browser-/];
const DATASET_PATTERNS = [];

/** @returns {"headless"|"gui"|"network"|"dataset"|"artifact"|"pending"} */
function classify(name) {
  if (GUI_TESTS.has(name)) return "gui";
  if (NETWORK_TESTS.has(name)) return "network";
  if (DATASET_TESTS.has(name)) return "dataset";
  if (ARTIFACT_TESTS.has(name)) return "artifact";
  if (KNOWN_HEADLESS_RED.has(name)) return "pending";
  if (HEADLESS_TESTS.has(name)) return "headless";
  if (GUI_PATTERNS.some((re) => re.test(name))) return "gui";
  if (NETWORK_PATTERNS.some((re) => re.test(name))) return "network";
  if (DATASET_PATTERNS.some((re) => re.test(name))) return "dataset";
  return "headless";
}

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const includeLive = args.includes("--include-live");
const includeGui = args.includes("--include-gui");
const artifactsOnly = args.includes("--artifacts-only");
const includeArtifacts = args.includes("--include-artifacts");
const batchBuild = !args.includes("--no-batch-build") && process.env.TEST_ALL_BATCH_BUILD !== "0";
const suiteLabel = artifactsOnly ? "（ARTIFACT：完整产品构建产物）" : includeLive ? "（全部：GUI+NETWORK+DATASET+ARTIFACT）" : `（default${includeGui ? " + GUI" : "：headless"}${includeArtifacts ? " + ARTIFACT" : ""}）`;
function positiveInteger(value, label, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    console.error(`[test-all] ${label} 必须是 >= ${minimum} 的整数，收到: ${value}`);
    process.exit(2);
  }
  return parsed;
}
const filterArg = args.find((a) => a.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const JOBS = positiveInteger(jobsArg ? jobsArg.slice("--jobs=".length) : (process.env.TEST_ALL_JOBS ?? 4), "--jobs / TEST_ALL_JOBS");
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
// 单个用例超时（秒）。test-guard 内部是 900s；聚合门禁需要更短的墙钟上限，
// 否则一个挂死用例就会拖住整条流水线（实测串行跑 250 个用例可超过 45 分钟）。
const PER_TEST_TIMEOUT = positiveInteger(timeoutArg ? timeoutArg.slice("--timeout=".length) : 300, "--timeout", 30);

/** 全量 test:*（去掉聚合脚本自身），用于分类统计与自检。 */
const allTestNames = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith("test:"))
  .filter((n) => !SELF_EXCLUDE_PATTERNS.some((re) => re.test(n)))
  .sort();

const classOf = (name) => classify(name);
const classCounts = { headless: 0, gui: 0, network: 0, dataset: 0, artifact: 0, pending: 0 };
for (const n of allTestNames) classCounts[classOf(n)] += 1;

/**
 * 自检：显式 GUI 清单与"命令里真的启动 electron"应对齐。
 * 这不是门禁断言（避免把分类维护成本转成红灯），但 `--list` / `--audit` 会打印，
 * 让新加的 Electron 用例不会悄悄混进 default 套件。
 *
 * warnings：需要处理（Electron 用例被归为 headless / 清单项已不存在）
 * info：预期内的信息（GUI 用例由 node driver 内部 spawn electron，命令串里看不到）
 */
function classificationWarnings() {
  const warnings = [];
  const info = [];
  const launchers = new Set();
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test:")) continue;
    if (/(^|&&|;)\s*electron\s/.test(cmd)) launchers.add(name);
  }
  for (const name of launchers) {
    if (classOf(name) === "headless") warnings.push(`${name} 命令里直接启动 electron，却归为 headless（会进 default 套件）`);
  }
  for (const name of PLATFORM_ONLY_TESTS.keys()) {
    if (!pkg.scripts[name]) warnings.push(`平台限定清单里的 ${name} 已不存在于 package.json`);
  }
  for (const name of ARTIFACT_TESTS) {
    if (!pkg.scripts[name]) warnings.push(`ARTIFACT 清单里的 ${name} 已不存在于 package.json`);
  }
  for (const name of GUI_TESTS) {
    if (!pkg.scripts[name]) warnings.push(`GUI 清单里的 ${name} 已不存在于 package.json`);
    else if (!launchers.has(name)) info.push(`${name} 由 node driver 内部 spawn electron（命令串里没有直接 electron，属预期）`);
  }
  return { warnings, info };
}

let names = [...allTestNames];
if (artifactsOnly) {
  names = names.filter((n) => classOf(n) === "artifact");
} else if (!includeLive) {
  names = names.filter((n) => classOf(n) === "headless" || (includeGui && classOf(n) === "gui") || (includeArtifacts && classOf(n) === "artifact"));
}
// 非 Windows 上跳过 GUI_WINDOWS_ONLY（它们会直接断言 requires Windows）。
const skippedWindowsOnly =
  includeGui && !includeLive && process.platform !== "win32"
    ? names.filter((n) => GUI_WINDOWS_ONLY.has(n))
    : [];
if (skippedWindowsOnly.length > 0) names = names.filter((n) => !GUI_WINDOWS_ONLY.has(n));
// 平台限定用例：当前 host 不在用例声明的平台里就整条跳过（不算失败、也不进 baseline）。
const skippedByPlatform = names.filter((n) => {
  const platforms = PLATFORM_ONLY_TESTS.get(n);
  return Boolean(platforms) && !platforms.includes(HOST_PLATFORM);
});
if (skippedByPlatform.length > 0) names = names.filter((n) => !skippedByPlatform.includes(n));
if (filter) names = names.filter((n) => n.includes(filter));
names.sort();
if (!artifactsOnly && !includeArtifacts && !includeLive) {
  console.log(`[test-all] ARTIFACT 单独验收 ${ARTIFACT_TESTS.size} 项：授权完整构建后运行 pnpm -s test:all:artifacts（本命令不触发产品构建）。`);
}

if (args.includes("--list") || args.includes("--audit")) {
  const { warnings, info } = classificationWarnings();
  console.log(
    `[test-all] 分类：headless ${classCounts.headless} · GUI ${classCounts.gui} · NETWORK ${classCounts.network} · DATASET ${classCounts.dataset} · ARTIFACT ${classCounts.artifact} · pending ${classCounts.pending}`,
  );
  console.log(
    `[test-all] 选中 ${names.length} 个用例${suiteLabel}${filter ? ` filter=${filter}` : ""}`,
  );
  if (skippedWindowsOnly.length > 0) {
    console.log(`[test-all] 非 Windows，跳过 ${skippedWindowsOnly.length} 个 Windows-only GUI 用例：${skippedWindowsOnly.join(", ")}`);
  }
  if (skippedByPlatform.length > 0) {
    console.log(
      `[test-all] 本机 ${HOST_PLATFORM}，跳过 ${skippedByPlatform.length} 个平台限定用例：` +
        skippedByPlatform.map((n) => `${n}(${PLATFORM_ONLY_TESTS.get(n).join("/")})`).join(", "),
    );
  }
  if (warnings.length > 0) {
    console.log(`[test-all] 分类自检警告（${warnings.length} 条，需要处理）：`);
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log("[test-all] 分类自检 OK：没有 Electron 用例混进 headless。");
  }
  if (args.includes("--audit") && info.length > 0) {
    console.log(`[test-all] 分类说明（${info.length} 条）：`);
    for (const line of info) console.log(`  · ${line}`);
  }
  if (args.includes("--list")) {
    const serial = names.filter((n) => SERIAL_TEST_PATTERNS.some((re) => re.test(n)));
    console.log(`[test-all] 并行 ${names.length - serial.length} · 串行 ${serial.length}`);
    for (const n of names) console.log(`  ${n}`);
  }
  process.exit(0);
}

if (names.length === 0) {
  console.error("[test-all] 没有匹配的 test:* 脚本");
  process.exit(2);
}

const serialNames = names.filter((n) => SERIAL_TEST_PATTERNS.some((re) => re.test(n)));
const parallelNames = names.filter((n) => !serialNames.includes(n));

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownFailing ?? [])
  : new Set();

console.log(
  `[test-all] 运行 ${names.length} 个用例${suiteLabel}${filter ? ` filter=${filter}` : ""}`,
);
if (skippedWindowsOnly.length > 0) {
  console.log(`[test-all] 非 Windows，跳过 ${skippedWindowsOnly.length} 个 Windows-only GUI 用例：${skippedWindowsOnly.join(", ")}`);
}
if (skippedByPlatform.length > 0) {
  console.log(
    `[test-all] 本机 ${HOST_PLATFORM}，跳过 ${skippedByPlatform.length} 个平台限定用例：` +
      skippedByPlatform.map((n) => `${n}(${PLATFORM_ONLY_TESTS.get(n).join("/")})`).join(", "),
  );
}
console.log(`[test-all] baseline 已知失败: ${baseline.size}`);
console.log("");

const failed = [];
const passed = [];
const timedOut = [];
const started = Date.now();

// ELECTRON_RUN_AS_NODE=1 会让 Electron UI 用例以 `app is undefined` 失败；
// 必须真正删除该变量（赋值为 undefined 在部分 Node 版本会变成字符串 "undefined"）。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// Direct node execution must retain the local binary lookup normally supplied
// by pnpm. Preserve Windows' actual Path key to avoid duplicate PATH entries.
const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
childEnv[pathKey] = join(ROOT, "node_modules", ".bin") + delimiter + (childEnv[pathKey] ?? "");
let preparedBundles = new Map();

const MAX_OUTPUT_BYTES = 1024 * 1024;
const activeChildren = new Set();

/** 只保留输出尾部：失败诊断要的是最后几十行，不是整段 esbuild 输出。 */
function tail(text, lines = 80) {
  const parts = String(text ?? "").trim().split(/\r?\n/);
  return parts.length <= lines ? parts.join("\n") : parts.slice(-lines).join("\n");
}

/**
 * 杀整棵进程树。之前用 `spawnSync(shell:true, timeout, SIGKILL)` 只杀掉了
 * `sh -c`/`cmd.exe`，其下的 pnpm → esbuild/node/electron 孙进程会继续持有
 * 端口、临时目录、~/.mybuddy 锁和 CPU，污染并行队列里的后续用例。
 * POSIX 用独立进程组 kill(-pid)，Windows 用 taskkill /T。
 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function runOne(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const prepared = preparedBundles.get(name);
    if (prepared?.error) {
      resolve({ name, ok: false, killed: false, secs: "0.0", output: `[bundle error] ${prepared.error}` });
      return;
    }
    const command = prepared ? process.execPath : "pnpm";
    const commandArgs = prepared ? ["scripts/test-guard.mjs", ...prepared.guardArgs] : ["-s", name];
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...childEnv, npm_lifecycle_event: name, npm_lifecycle_script: pkg.scripts[name] },
      // POSIX 直接 spawn pnpm（不再套 sh -c，避免 Node DEP0190 与多一层僵尸进程）；
      // Windows 的 pnpm 是 .cmd，必须经 shell。超时为整组 kill / taskkill /T。
      shell: !prepared && process.platform === "win32",
      // Headless tests must not open one desktop console per pnpm.cmd invocation.
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    activeChildren.add(child);
    let output = prepared?.warnings ?? "";
    let settled = false;
    let killed = false;

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ name, ok: !killed && code === 0, killed, secs: ((Date.now() - t0) / 1000).toFixed(1), output });
    };

    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
      // 某些平台上 kill 后 close 可能迟迟不来，兜底结束该用例，避免整条门禁挂死。
      const fallback = setTimeout(() => finish(null), 5000);
      fallback.unref?.();
    }, PER_TEST_TIMEOUT * 1000);

    child.on("close", (code) => finish(code));
    child.on("error", (error) => {
      output += `\n[spawn error] ${error.message}`;
      finish(1);
    });
  });
}

// Ctrl+C 时连同所有 detached 子进程组一起退出，避免门禁被中断后留下孤儿进程。
process.on("SIGINT", () => {
  for (const child of activeChildren) killTree(child);
  process.exit(130);
});

/** 有限并发：pnpm+esbuild 启动开销占比高，串行会慢数倍。 */
async function runPool(items, worker, concurrency = JOBS) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const r = await worker(next);
      if (r.killed) timedOut.push(r.name);
      if (r.ok) {
        passed.push(r.name);
        console.log(`  PASS ${r.name}  (${r.secs}s)`);
      } else {
        failed.push(r.name);
        const known = baseline.has(r.name);
        console.log(
          `  ${r.killed ? "TIMEOUT" : "FAIL "} ${r.name}  (${r.secs}s)${r.killed ? "" : known ? "  [baseline 已知]" : "  [新增回归]"}`,
        );
        // 之前 stdio:"ignore" 让 CI 只看到用例名、看不到任何失败原因。
        const detail = tail(r.output);
        if (detail) console.log(detail.split("\n").map((line) => `      | ${line}`).join("\n"));
      }
    }
  });
  await Promise.all(workers);
}

console.log(`[test-all] 并发 ${JOBS} · 单用例超时 ${PER_TEST_TIMEOUT}s`);
if (batchBuild) {
  const compileStarted = Date.now();
  const result = await prepareTestBundles(names, pkg.scripts, { root: ROOT, timeoutMs: PER_TEST_TIMEOUT * 1000 });
  preparedBundles = result.prepared;
  console.log(`[test-all] 共享 esbuild 进程：${preparedBundles.size} 个用例 / ${result.batches} 批 · ${((Date.now() - compileStarted) / 1000).toFixed(1)}s；其余 ${names.length - preparedBundles.size} 个保留原命令。`);
}
await runPool(parallelNames, async (n) => runOne(n));
if (serialNames.length > 0) {
  console.log(`\n[test-all] 串行执行负载敏感/机器全局资源用例（${serialNames.length} 个，隔离崩溃恢复、性能验证的 CPU/IO 争用与真实端口争用）：`);
  for (const n of serialNames) console.log(`    - ${n}`);
  await runPool(serialNames, async (n) => runOne(n), 1);
}

const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
const newRegressions = failed.filter((n) => !baseline.has(n));
const fixedSinceBaseline = [...baseline].filter((n) => !failed.includes(n) && names.includes(n));

console.log("");
console.log("=".repeat(64));
console.log(`[test-all] ${elapsed} min · 通过 ${passed.length} · 失败 ${failed.length} · 已知失败 ${failed.length - newRegressions.length} · 新增回归 ${newRegressions.length}${timedOut.length ? ` · 超时 ${timedOut.length}` : ""}`);

if (timedOut.length > 0) {
  console.log(`[test-all] 超时用例（>${PER_TEST_TIMEOUT}s，按失败计入门禁）：`);
  for (const n of timedOut) console.log(`    - ${n}`);
}

if (fixedSinceBaseline.length > 0) {
  console.log(`[test-all] 这些 baseline 用例现在通过，可从 baseline 移除：`);
  for (const n of fixedSinceBaseline) console.log(`    - ${n}`);
}

if (newRegressions.length > 0) {
  console.log("[test-all] 新增回归（门禁失败）：");
  for (const n of newRegressions) console.log(`    - ${n}`);
}

if (updateBaseline) {
  // 保留原有 $basis/$remaining 等 provenance，避免 --update-baseline 一次把决策背景抹掉。
  const previous = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
  const payload = {
    ...previous,
    $comment:
      "已知失败基线（棘轮）。新增失败会让 test:all 失败；修复后请移除对应条目。每条应附简短原因。",
    generatedAt: new Date().toISOString(),
    knownFailing: failed.sort(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[test-all] 已更新 baseline: ${BASELINE_PATH} (${failed.length} 条)`);
  process.exit(0);
}

if (failed.length > 0) {
  console.log("[test-all] 已知失败仍然可见（见上），但需修复后才能移出 baseline。");
}
process.exit(newRegressions.length > 0 ? 1 : 0);
