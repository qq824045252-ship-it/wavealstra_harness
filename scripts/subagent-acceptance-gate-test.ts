/**
 * 装载门禁的行为测试：造真实 git 仓库、真实 mtime、真实日志行，按「用户看到的判定结果」断言。
 *
 * 这里不读源码文本、不断言实现细节：每条断言都是「把这些文件放到磁盘上之后，门禁给出什么结论」。
 * 夹具时间全部用本地时区构造（日志时间戳本身无偏移），因此换时区跑结果一致。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  collectFingerprints,
  formatFingerprintBlock,
  readBuildMtime,
  readHeadCommit,
  readProcessStart,
  validateFingerprints,
  type Fingerprints,
} from "./subagent-acceptance-fingerprint";

const exec = promisify(execFile);
const COMMIT_SUBJECT = "fix: 装载门禁 fixture";

/** 夹具根目录在 main 里创建，便于统一清理。 */
let root = "";

type Fixture = { repo: string; logDir: string };

type FixtureOptions = {
  commitAt: Date;
  /** 不传 = 这台机器没有构建产物（out/main/index.js 不存在）。 */
  buildAt?: Date;
  /** 不传 = 日志里没有 crashReporter started（没有真实运行实例）。 */
  processAt?: Date;
  version?: string;
  /** 显式给日志文件（跨文件取最大时间等场景）；给了就忽略 processAt 的默认文件。 */
  logs?: Array<{ name: string; lines: string[] }>;
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
/** 本地时区 Date：日志时间戳和 git 的 *commit* 日期都以本地时区为准。 */
const local = (year: number, month: number, day: number, hour: number, minute: number, second: number, ms = 0): Date =>
  new Date(year, month - 1, day, hour, minute, second, ms);
/** git 环境变量用的日期：ISO 风格、无毫秒（避免依赖 git 对小数秒的解析）。 */
const gitDate = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
/** 真实日志行首格式：`YYYY-MM-DD HH:mm:ss.SSS`，本地时区、无偏移。 */
const logStamp = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
/** 与 ~/.mybuddy/logs/main-*.log 里同一行同形状（含全角括号），version 是门禁要抓的字段。 */
const crashLine = (at: Date, version: string): string =>
  `${logStamp(at)} INFO [crash] crashReporter started（product=MyBuddy version=${version} uploadToServer=false compress=true）...`;
const datePart = (at: Date): string => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;

async function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  await exec("git", ["-C", repo, ...args], { windowsHide: true, env: { ...process.env, ...env } });
}

/**
 * 一个「仓库 + 日志目录」夹具。身份用 `-c` 传入，保证在没有全局 git 配置的机器上也能提交；
 * 提交时间通过 GIT_*_DATE 固定，让顺序判定可以精确构造，而不是跟着系统时钟漂。
 */
async function createFixture(name: string, options: FixtureOptions): Promise<Fixture> {
  const repo = join(root, name, "repo");
  const logDir = join(root, name, "logs");
  await mkdir(repo, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, [
    "-c", "user.email=gate@example.com", "-c", "user.name=gate",
    "commit", "--allow-empty", "-q", "-m", COMMIT_SUBJECT,
  ], { GIT_AUTHOR_DATE: gitDate(options.commitAt), GIT_COMMITTER_DATE: gitDate(options.commitAt) });
  if (options.buildAt) {
    const target = join(repo, "out", "main", "index.js");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "// built by fixture\n");
    await utimes(target, options.buildAt, options.buildAt);
  }
  const logs = options.logs ?? (options.processAt
    ? [{ name: `main-${datePart(options.processAt)}.log`, lines: [crashLine(options.processAt, options.version ?? "0.1.107")] }]
    // 有日志文件但没有启动行：进程指纹必须是 null，而不是「随便抓一个时间」。
    : [{ name: "main-20261101.log", lines: ["2026-11-01 09:00:00.000 INFO [app] window created"] }]);
  for (const log of logs) await writeFile(join(logDir, log.name), `${log.lines.join("\n")}\n`);
  return { repo, logDir };
}

async function logFixture(name: string, files: Array<{ name: string; lines: string[] }>): Promise<string> {
  const logDir = join(root, name);
  await mkdir(logDir, { recursive: true });
  for (const file of files) await writeFile(join(logDir, file.name), `${file.lines.join("\n")}\n`);
  return logDir;
}

const fingerprintsOf = (fixture: Fixture): Promise<Fingerprints> =>
  collectFingerprints({ repoDir: fixture.repo, logDir: fixture.logDir });

/** 三项齐全且顺序正确：这是唯一允许写「已修复 / 未修复」的状态。 */
async function liveOrdered(): Promise<void> {
  const commitAt = local(2026, 11, 6, 10, 0, 0);
  const buildAt = local(2026, 11, 6, 11, 0, 0);
  const processAt = local(2026, 11, 6, 12, 0, 0);
  const fixture = await createFixture("live-ordered", { commitAt, buildAt, processAt, version: "0.1.107" });
  const fpr = await fingerprintsOf(fixture);
  assert.ok(fpr.commit, "fixture 必须采集到 HEAD commit");
  assert.equal(fpr.commit.hash.length, 40, "commit hash 必须是完整的 SHA-1");
  assert.equal(fpr.commit.subject, COMMIT_SUBJECT);
  assert.equal(Date.parse(fpr.commit.committedAt), commitAt.getTime(), "commit 时间必须回到夹具构造的那个瞬间");
  assert.ok(fpr.build, "fixture 必须采集到构建产物");
  assert.equal(fpr.build.path, "out/main/index.js", "默认构建产物路径必须与 package.json 的 main 一致");
  assert.equal(Date.parse(fpr.build.mtime), buildAt.getTime());
  assert.ok(fpr.process, "fixture 必须采集到运行实例");
  assert.equal(Date.parse(fpr.process.startedAt), processAt.getTime());
  assert.equal(fpr.process.version, "0.1.107");
  const validation = validateFingerprints(fpr, "live");
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
  assert.equal(validation.verdictAllowed, true);
  console.log("PASS live：commit ≤ build ≤ process，三项齐全 → ok=true、verdictAllowed=true");
}

/** 构建早于修复提交：报告写的修复根本不在被测构建里（v5 报告的实际情形）。 */
async function liveBuildBeforeCommit(): Promise<void> {
  const fixture = await createFixture("live-build-early", {
    commitAt: local(2026, 11, 6, 11, 0, 0),
    buildAt: local(2026, 11, 6, 10, 0, 0),
    processAt: local(2026, 11, 6, 12, 0, 0),
  });
  const validation = validateFingerprints(await fingerprintsOf(fixture), "live");
  assert.equal(validation.ok, false);
  assert.equal(validation.verdictAllowed, false);
  assert.deepEqual(validation.problems.map((problem) => problem.code), ["build-before-commit"]);
  assert.match(validation.problems[0]!.message, /构建/);
  assert.match(validation.problems[0]!.message, /修复/);
  assert.match(validation.problems[0]!.message, /commit/);
  console.log("PASS live：构建 mtime 早于 commit 时间 → build-before-commit、verdictAllowed=false");
}

/** 进程早于构建：进程加载的是旧代码，即使构建是新的也不算数。 */
async function liveProcessBeforeBuild(): Promise<void> {
  const fixture = await createFixture("live-process-early", {
    commitAt: local(2026, 11, 6, 10, 0, 0),
    buildAt: local(2026, 11, 6, 11, 0, 0),
    processAt: local(2026, 11, 6, 10, 30, 0),
  });
  const validation = validateFingerprints(await fingerprintsOf(fixture), "live");
  assert.equal(validation.ok, false);
  assert.equal(validation.verdictAllowed, false);
  assert.deepEqual(validation.problems.map((problem) => problem.code), ["process-before-build"]);
  assert.match(validation.problems[0]!.message, /进程/);
  assert.match(validation.problems[0]!.message, /旧代码/);
  console.log("PASS live：进程启动早于构建 → process-before-build、verdictAllowed=false");
}

/** 缺项在 live 模式下就是失败：没有构建 / 没有进程，无法证明测的是哪个构建。 */
async function liveMissingItems(): Promise<void> {
  const noBuild = await createFixture("live-no-build", {
    commitAt: local(2026, 11, 6, 10, 0, 0),
    processAt: local(2026, 11, 6, 12, 0, 0),
  });
  const noBuildValidation = validateFingerprints(await fingerprintsOf(noBuild), "live");
  assert.equal(noBuildValidation.ok, false);
  assert.equal(noBuildValidation.verdictAllowed, false);
  assert.deepEqual(noBuildValidation.problems.map((problem) => problem.code), ["build-missing"]);

  const noProcess = await createFixture("live-no-process", {
    commitAt: local(2026, 11, 6, 10, 0, 0),
    buildAt: local(2026, 11, 6, 11, 0, 0),
  });
  const noProcessValidation = validateFingerprints(await fingerprintsOf(noProcess), "live");
  assert.equal(noProcessValidation.ok, false);
  assert.equal(noProcessValidation.verdictAllowed, false);
  assert.deepEqual(noProcessValidation.problems.map((problem) => problem.code), ["process-missing"]);

  // 三项全缺：三条 missing 都要报出来，而不是只报第一条。
  const empty: Fingerprints = { commit: null, build: null, process: null };
  const emptyValidation = validateFingerprints(empty, "live");
  assert.deepEqual(emptyValidation.problems.map((problem) => problem.code), ["commit-missing", "build-missing", "process-missing"]);
  assert.equal(emptyValidation.verdictAllowed, false);
  console.log("PASS live：缺 build / 缺 process / 三项全缺 → verdictAllowed=false 且逐项报 problem");
}

/** headless（CI、无 GUI）：没有真实实例是常态，缺失不算违反，但不允许给部署结论。 */
async function headlessMissing(): Promise<void> {
  const fixture = await createFixture("headless-no-build", { commitAt: local(2026, 11, 6, 10, 0, 0) });
  const fpr = await fingerprintsOf(fixture);
  assert.ok(fpr.commit);
  assert.equal(fpr.build, null);
  assert.equal(fpr.process, null);
  const validation = validateFingerprints(fpr, "headless");
  assert.equal(validation.ok, true, "headless 里缺构建/缺进程不算失败");
  assert.equal(validation.verdictAllowed, false, "headless 永远不产生部署结论");
  assert.deepEqual(validation.problems.map((problem) => problem.code), ["build-missing", "process-missing"]);
  for (const problem of validation.problems) assert.match(problem.message, /headless 模式不产生部署结论/);
  console.log("PASS headless：缺 build/process → ok=true、verdictAllowed=false，并说明不产生部署结论");
}

/** headless 不是「什么都放行」：三项齐全但顺序错，仍然 ok=false。 */
async function headlessWrongOrder(): Promise<void> {
  const fixture = await createFixture("headless-wrong-order", {
    commitAt: local(2026, 11, 6, 11, 0, 0),
    buildAt: local(2026, 11, 6, 10, 0, 0),
    processAt: local(2026, 11, 6, 12, 0, 0),
  });
  const validation = validateFingerprints(await fingerprintsOf(fixture), "headless");
  assert.equal(validation.ok, false);
  assert.equal(validation.verdictAllowed, false);
  assert.deepEqual(validation.problems.map((problem) => problem.code), ["build-before-commit"]);
  console.log("PASS headless：顺序错误仍然 ok=false（headless 只放宽缺失，不放宽矛盾）");
}

/** 跨多个日志文件取最大时间，并抓 version；非 main-*.log 必须被忽略。 */
async function processStartAcrossLogs(): Promise<void> {
  const earlier = local(2026, 11, 5, 15, 0, 0);
  const latest = local(2026, 11, 6, 10, 33, 38, 960);
  const logDir = await logFixture("process-max", [
    { name: "main-20261105.log", lines: [crashLine(local(2026, 11, 5, 9, 0, 0), "0.1.100"), crashLine(earlier, "0.1.100")] },
    {
      name: "main-20261106.log",
      lines: [
        "2026-11-06 08:00:00.000 INFO [app] boot",
        crashLine(local(2026, 11, 6, 9, 5, 0), "0.1.105"),
        crashLine(latest, "0.1.107"),
        "2026-11-06 13:00:00.000 INFO [app] window created",
      ],
    },
    // 渲染进程/其它日志里的 crashReporter 行不属于主进程实例，必须被 main-*.log 过滤掉。
    { name: "renderer.log", lines: [crashLine(local(2026, 11, 6, 23, 0, 0), "9.9.9")] },
  ]);
  const processStart = await readProcessStart(logDir);
  assert.ok(processStart, "跨文件必须找到启动行");
  assert.equal(Date.parse(processStart.startedAt), latest.getTime(), "必须取所有日志里最大的启动时间");
  assert.equal(processStart.version, "0.1.107", "version 必须来自取中的那一行");
  assert.ok(processStart.logFile.endsWith(`main-20261106.log`), `必须记录取中的日志文件，实际 ${processStart.logFile}`);

  const noMatch = await logFixture("process-no-match", [{ name: "main-20261106.log", lines: ["2026-11-06 09:00:00.000 INFO [app] window created"] }]);
  assert.equal(await readProcessStart(noMatch), null);
  assert.equal(await readProcessStart(join(root, "process-missing-dir")), null);
  console.log("PASS readProcessStart：跨日志文件取最大启动时间、解析 version、忽略非 main-*.log；无匹配/无目录返回 null");
}

/** 报告里粘的那段：三行指纹 + 判定行；缺项写「缺失」。 */
async function fingerprintBlock(): Promise<void> {
  const commitAt = local(2026, 11, 6, 10, 0, 0);
  const buildAt = local(2026, 11, 6, 11, 0, 0);
  const processAt = local(2026, 11, 6, 12, 0, 0);
  const fixture = await createFixture("block-ordered", { commitAt, buildAt, processAt, version: "0.1.107" });
  const fpr = await fingerprintsOf(fixture);
  assert.ok(fpr.commit && fpr.build && fpr.process);
  const allowed = formatFingerprintBlock(fpr, validateFingerprints(fpr, "live"));
  assert.ok(allowed.startsWith("指纹（装载门禁）"), allowed);
  assert.ok(allowed.includes(fpr.commit.hash), "判定块必须带 commit hash");
  assert.ok(allowed.includes(fpr.commit.committedAt), "判定块必须带 commit 时间");
  assert.ok(allowed.includes(COMMIT_SUBJECT), "判定块必须带 commit subject");
  assert.ok(allowed.includes("out/main/index.js"), "判定块必须带构建产物路径");
  assert.ok(allowed.includes(fpr.build.mtime), "判定块必须带构建产物 mtime");
  assert.ok(allowed.includes(fpr.process.startedAt), "判定块必须带进程启动时间");
  assert.ok(allowed.includes("0.1.107"), "判定块必须带被测实例版本");
  assert.ok(allowed.includes("VERDICT ALLOWED"), allowed);

  const early = await createFixture("block-build-early", {
    commitAt: local(2026, 11, 6, 11, 0, 0),
    buildAt: local(2026, 11, 6, 10, 0, 0),
    processAt: local(2026, 11, 6, 12, 0, 0),
  });
  const earlyFpr = await fingerprintsOf(early);
  const denied = formatFingerprintBlock(earlyFpr, validateFingerprints(earlyFpr, "live"));
  assert.ok(denied.includes("VERDICT DENIED"), denied);
  assert.ok(denied.includes("build-before-commit"), "被拒时必须逐条列出 problem 的 code");
  assert.ok(!denied.includes("VERDICT ALLOWED"));

  const emptyFpr: Fingerprints = { commit: null, build: null, process: null };
  const missingBlock = formatFingerprintBlock(emptyFpr, validateFingerprints(emptyFpr, "live"));
  assert.equal(missingBlock.split("缺失").length - 1, 3, "三行指纹缺项都要写「缺失」");
  assert.ok(missingBlock.includes("VERDICT DENIED"));
  console.log("PASS formatFingerprintBlock：含三行指纹与判定行，被拒时逐条列出 problems，缺项写「缺失」");
}

/** 采集层面的边界：非 git 目录没有 commit；没有文件没有构建指纹；MYBUDDY_LOG_DIR 是 logDir 的默认口径。 */
async function collectionDefaults(): Promise<void> {
  const plain = join(root, "plain-dir");
  await mkdir(plain, { recursive: true });
  assert.equal(await readHeadCommit(plain), null, "非 git 目录必须降级为 null 而不是抛错");
  assert.equal(await readBuildMtime(plain), null, "没有构建产物必须返回 null");

  const commitAt = local(2026, 11, 6, 10, 0, 0);
  const buildAt = local(2026, 11, 6, 11, 0, 0);
  const processAt = local(2026, 11, 6, 12, 0, 0);
  const fixture = await createFixture("defaults", { commitAt, buildAt, processAt });
  const previousLogDir = process.env.MYBUDDY_LOG_DIR;
  process.env.MYBUDDY_LOG_DIR = fixture.logDir;
  try {
    const fpr = await collectFingerprints({ repoDir: fixture.repo });
    assert.ok(fpr.commit && fpr.build && fpr.process);
    assert.equal(Date.parse(fpr.process.startedAt), processAt.getTime(), "MYBUDDY_LOG_DIR 必须作为 logDir 的默认口径");
    assert.equal(Date.parse(fpr.build.mtime), buildAt.getTime());
  } finally {
    if (previousLogDir === undefined) delete process.env.MYBUDDY_LOG_DIR;
    else process.env.MYBUDDY_LOG_DIR = previousLogDir;
  }
  console.log("PASS 采集默认值：非 git/无产物降级为 null；MYBUDDY_LOG_DIR 决定默认日志目录");
}

async function main(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "mybuddy-acceptance-gate-"));
  try {
    await liveOrdered();
    await liveBuildBeforeCommit();
    await liveProcessBeforeBuild();
    await liveMissingItems();
    await headlessMissing();
    await headlessWrongOrder();
    await processStartAcrossLogs();
    await fingerprintBlock();
    await collectionDefaults();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("ALL PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
