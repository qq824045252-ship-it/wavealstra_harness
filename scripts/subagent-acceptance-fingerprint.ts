/**
 * 子代理验收「装载门禁」：把「这一轮验收到底测的是哪个构建、哪个进程」变成可机读、可判定的指纹。
 *
 * 背景（见桌面 subagent-test-report-v5.md）：报告只记录了测试时间窗口，没有记录被测的
 * HEAD commit / 构建产物 mtime / 运行实例启动时间。于是 11:03 才提交的修复被 10:33 起就在跑的
 * 旧进程「验收」，连续几轮结论都是「未修复」，而报告本身无法证明被测对象是旧的。这里把三要素
 * 固定下来并给出唯一判定：只有 `commit <= build <= process` 成立，报告才允许写「已修复 /
 * 未修复」这类部署结论。
 *
 * 两个刻意的取舍：
 * - 采集失败一律降级成 null，不抛错。验收报告需要记录「缺失」这个事实本身；不能因为 git 不可用
 *   就连报告都生成不出来。
 * - 不做 CI 特判。live 模式在 CI / 无 GUI 机器上本来就该退出 2 或 3，那正是门禁要拦的东西。
 *
 * CLI：`node <bundle> [--live|--headless] [--json]`（默认 live）
 * 退出码：0 = ok 且允许给结论；2 = 结论被拒（有 problems）；3 = 采集异常。
 */
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export type HeadCommit = { hash: string; committedAt: string; subject: string };
export type BuildArtifact = { path: string; mtime: string };
export type ProcessStart = { startedAt: string; logFile: string; version?: string };
export type Fingerprints = {
  commit: HeadCommit | null;
  build: BuildArtifact | null;
  process: ProcessStart | null;
};
export type FingerprintProblem = {
  code: "commit-missing" | "build-missing" | "process-missing" | "build-before-commit" | "process-before-build";
  message: string;
};
export type FingerprintValidation = { ok: boolean; verdictAllowed: boolean; problems: FingerprintProblem[] };

/** 主进程构建产物：验收跑的就是它，默认路径与 package.json 的 main 字段一致。 */
const DEFAULT_BUILD_PATH = "out/main/index.js";
/** 主进程日志按天轮转（main-YYYYMMDD.log，保留 7 份），一次验收可能跨天，必须扫全部。 */
const MAIN_LOG = /^main-.*\.log$/;
/** 进程启动的唯一可信锚点：主进程启动时 crashReporter 会打这一行。 */
const START_LINE = "crashReporter started";
/** 日志行首时间戳是本地时区且无偏移，所以下面按本地时区解析，不能用 Date.parse 直接吃。 */
const LINE_STAMP = /^[\s\ufeff]*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}\.\d{3})/;
const LINE_VERSION = /version=([\w.\-]+)/;

const run = promisify(execFile);

/** 归一成 posix 分隔符：报告是 Markdown，Windows 反斜杠在代码块里更难读也更容易被转义。 */
const toReportPath = (path: string): string => path.split("\\").join("/");

/**
 * `git log -1` 的规范化输出：hash、ISO 提交时间（带时区偏移）、单行 subject。
 * 用 execFile 且把 repoDir 作为 `-C` 的参数而不是拼 shell 字符串——路径里的空格/中文不会被 shell 解释。
 */
export async function readHeadCommit(repoDir: string): Promise<HeadCommit | null> {
  try {
    const { stdout } = await run("git", ["-C", repoDir, "log", "-1", "--format=%H%n%cI%n%s"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const [hash, committedAt, ...rest] = String(stdout).split(/\r?\n/);
    const subject = rest.join(" ").trim();
    if (!hash?.trim() || !committedAt?.trim()) return null;
    return { hash: hash.trim(), committedAt: committedAt.trim(), subject };
  } catch {
    // 非 git 目录、没有提交、git 不在 PATH：对验收而言都是「指纹缺失」，交给 validate 判定。
    return null;
  }
}

/**
 * 构建产物的 mtime 就是「这段代码是什么时候被编出来的」，比版本号可靠（版本号常常不升）。
 * 文件不存在 = 这台机器根本没构建过，返回 null 让门禁拒绝给结论。
 */
export async function readBuildMtime(repoDir: string, relativePath: string = DEFAULT_BUILD_PATH): Promise<BuildArtifact | null> {
  const target = isAbsolute(relativePath) ? relativePath : join(repoDir, relativePath);
  try {
    const info = await stat(target);
    return { path: toReportPath(relativePath), mtime: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * 运行实例启动时间：取所有 main-*.log 里 `crashReporter started` 的最大时间戳。
 *
 * 为什么取最大而不是最新文件：日志按天轮转，同一天会有多次重启，最新文件里的第一行也不一定是
 * 最后一次启动（还可能是崩溃后的续写）。验收关心的是「当前这个实例」——即最后一次启动。
 * version 从同一行抓，用来把「报告里的版本」和「真实加载的版本」对上。
 */
export async function readProcessStart(logDir: string): Promise<ProcessStart | null> {
  let names: string[];
  try {
    names = await readdir(logDir);
  } catch {
    return null;
  }
  let best: { at: number; startedAt: string; logFile: string; version?: string } | null = null;
  for (const name of names.filter((candidate) => MAIN_LOG.test(candidate))) {
    const logFile = join(logDir, name);
    let text: string;
    try {
      text = await readFile(logFile, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(START_LINE)) continue;
      const stamp = LINE_STAMP.exec(line);
      if (!stamp) continue;
      // 日志时间戳无时区偏移 → 先拼成不带 Z 的 ISO 字符串，Date 按本地时区解释，再存成 ISO。
      const started = new Date(`${stamp[1]}T${stamp[2]}`);
      if (Number.isNaN(started.getTime())) continue;
      if (best && started.getTime() <= best.at) continue;
      const version = LINE_VERSION.exec(line)?.[1];
      best = {
        at: started.getTime(),
        startedAt: started.toISOString(),
        logFile,
        ...(version ? { version } : {}),
      };
    }
  }
  return best ? { startedAt: best.startedAt, logFile: best.logFile, ...(best.version ? { version: best.version } : {}) } : null;
}

/**
 * 三项并行采集。默认口径：repo = 当前工作目录；logDir 优先 MYBUDDY_LOG_DIR（隔离测试/自定义数据目录），
 * 否则用真实桌面实例的日志目录。
 */
export async function collectFingerprints(
  options: { repoDir?: string; logDir?: string; buildPath?: string } = {},
): Promise<Fingerprints> {
  const repoDir = options.repoDir ?? process.cwd();
  const logDir = options.logDir ?? process.env.MYBUDDY_LOG_DIR ?? join(homedir(), ".mybuddy", "logs");
  const buildPath = options.buildPath ?? DEFAULT_BUILD_PATH;
  const [commit, build, processStart] = await Promise.all([
    readHeadCommit(repoDir),
    readBuildMtime(repoDir, buildPath),
    readProcessStart(logDir),
  ]);
  return { commit, build, process: processStart };
}

/** 时间比较用毫秒；解析不了的时间不参与比较（NaN 比较恒为 false，等价于「这一对无法判定」）。 */
const time = (iso: string): number => Date.parse(iso);

/**
 * 门禁判定。live = 结论要落到真实运行实例（桌面验收）；headless = CI / 无 GUI，本来就不存在
 * 那个实例，因此缺失不算违反，但**绝不产生部署结论**（verdictAllowed 恒 false）。
 */
export function validateFingerprints(fpr: Fingerprints, mode: "live" | "headless"): FingerprintValidation {
  // 顺序问题只看能比较的两项：缺一项时不是「顺序错」，而是「缺」，不要重复报错。
  const ordering: FingerprintProblem[] = [];
  if (fpr.commit && fpr.build && time(fpr.commit.committedAt) > time(fpr.build.mtime)) {
    ordering.push({
      code: "build-before-commit",
      message: `构建产物早于修复提交：构建 ${fpr.build.mtime} 早于 HEAD commit ${fpr.commit.committedAt}（${fpr.commit.subject}），测到的不是这次修复。`,
    });
  }
  if (fpr.build && fpr.process && time(fpr.build.mtime) > time(fpr.process.startedAt)) {
    ordering.push({
      code: "process-before-build",
      message: `运行实例早于构建：进程启动 ${fpr.process.startedAt} 早于构建产物 ${fpr.build.mtime}，进程加载的是旧代码。`,
    });
  }

  if (mode === "live") {
    const problems: FingerprintProblem[] = [];
    if (!fpr.commit) {
      problems.push({ code: "commit-missing", message: "缺少 HEAD commit 指纹：无法确认这轮验收跑在哪个修复之上。" });
    }
    if (!fpr.build) {
      problems.push({ code: "build-missing", message: `缺少构建产物指纹：${DEFAULT_BUILD_PATH} 不存在或无法读取，无法确认测的是哪个构建。` });
    }
    if (!fpr.process) {
      problems.push({ code: "process-missing", message: "缺少运行实例指纹：日志里没有 crashReporter started，无法确认被测进程的启动时间。" });
    }
    problems.push(...ordering);
    const ok = problems.length === 0;
    return { ok, verdictAllowed: ok, problems };
  }

  const problems: FingerprintProblem[] = [];
  if (!fpr.commit) {
    problems.push({
      code: "commit-missing",
      message: "headless 模式缺少 HEAD commit 指纹：无法锚定修复版本；headless 模式不产生部署结论。",
    });
  }
  if (!fpr.build) {
    problems.push({
      code: "build-missing",
      message: "headless 模式没有构建产物指纹（CI 里通常不构建 out/）；headless 模式不产生部署结论。",
    });
  }
  if (!fpr.process) {
    problems.push({
      code: "process-missing",
      message: "headless 模式没有真实运行实例，缺少进程启动时间；headless 模式不产生部署结论。",
    });
  }
  problems.push(...ordering);
  // 缺 build/process 不算失败（CI 本来就没有这两项），但没有 commit 就没有任何可锚定的对象，仍算失败。
  const ok = ordering.length === 0 && Boolean(fpr.commit);
  return { ok, verdictAllowed: false, problems };
}

/** 报告里直接粘的一段：三行指纹 + 判定行 + 逐条 problems。缺项写「缺失」。 */
export function formatFingerprintBlock(fpr: Fingerprints, validation: FingerprintValidation): string {
  const lines = ["指纹（装载门禁）"];
  lines.push(
    `- HEAD commit : ${fpr.commit ? `${fpr.commit.hash} ${fpr.commit.committedAt} ${fpr.commit.subject}`.trim() : "缺失"}`,
  );
  lines.push(`- 构建产物    : ${fpr.build ? `${fpr.build.path} @ ${fpr.build.mtime}` : "缺失"}`);
  lines.push(
    `- 运行实例    : ${
      fpr.process
        ? `${fpr.process.startedAt}（${toReportPath(fpr.process.logFile)}${fpr.process.version ? `，version=${fpr.process.version}` : ""}）`
        : "缺失"
    }`,
  );
  lines.push(`- 判定        : ${validation.verdictAllowed ? "VERDICT ALLOWED" : "VERDICT DENIED"}`);
  for (const problem of validation.problems) lines.push(`  - [${problem.code}] ${problem.message}`);
  // 无 problems 却仍被拒 = headless（三项齐全且顺序正确，但不允许给部署结论），必须把原因写出来，
  // 否则报告上只剩一个没有解释的 DENIED。
  if (!validation.verdictAllowed && validation.problems.length === 0) {
    lines.push("  - 无 problems，但本次模式不允许给出部署结论（headless：没有真实运行实例）。");
  }
  return lines.join("\n");
}

/**
 * CLI 入口判定。
 *
 * 只看 `import.meta.url === argv[1]` 在这个仓库里不够：验收/端到端脚本是 esbuild 打包产物，
 * 把本文件 import 进别的 bundle 时 esbuild 会把本模块 inline 进去，此时 `import.meta.url` 与
 * `argv[1]` 都指向那个宿主 bundle，判定会误命中——随后 CLI 的 stdout 和退出码会污染宿主进程。
 * 因此再加一条本仓库本来就成立的构建约定：产物文件名与脚本同名（scripts/x.ts → out/tests/x.mjs）。
 * 两条同时成立才当 CLI 跑；被 import 时不可能同时成立。
 */
const CLI_FILE = /^subagent-acceptance-fingerprint(?:\.[cm]?js)?$/;

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (!CLI_FILE.test(basename(entry))) return false;
  try {
    const entryUrl = pathToFileURL(resolve(entry)).href;
    return process.platform === "win32"
      ? entryUrl.toLowerCase() === import.meta.url.toLowerCase()
      : entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    const mode = argv.includes("--headless") ? "headless" : "live";
    const fingerprints = await collectFingerprints();
    const validation = validateFingerprints(fingerprints, mode);
    if (argv.includes("--json")) console.log(JSON.stringify({ mode, fingerprints, validation }, null, 2));
    else console.log(formatFingerprintBlock(fingerprints, validation));
    return validation.ok && validation.verdictAllowed ? 0 : 2;
  } catch (error) {
    console.error(`[acceptance-fingerprint] 采集失败: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}

if (isCliEntrypoint()) {
  // 写 exitCode 而不是 process.exit：即使入口判定被误命中，也只是留下退出码，不会当场终止宿主进程。
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 3;
    },
  );
}
