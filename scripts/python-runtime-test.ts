/**
 * Python 运行时门禁测试。
 *
 * 刻意不依赖机器上是否装了 Python 或 uv：所有目录注入临时路径（含中文与空格），
 * 安装器换成假的 UvExecutor。这样第一期要求的「在没有系统 Python、没有系统 uv 的
 * 状态机验证」在 CI 与本机可运行；真实首次安装由独立集成测试验证。
 *
 * 冻结约束逐条落测：
 *  - 相同兼容规格复用同一环境；依赖冲突 → 另一套环境
 *  - 已就绪环境不原地升级（冲突依赖不会改动原环境目录）
 *  - 安装失败只留可清理的 staging，不把半成品标成就绪
 *  - 晋级后复验失败 → 删除目录
 *  - 受管环境不可用 → 明确失败阶段，绝不回退系统 Python
 */
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { splitPythonDependencies } from "../src/main/runtime/python-environment-spec";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_PYTHON_REQUEST,
  pythonFailureStageLabel,
  pythonRuntimeDetail,
  type PythonProjectBinding,
} from "../src/shared/python-runtime";
import {
  describePythonEnvironmentSpec,
  normalizePythonEnvironmentSpec,
  pythonEnvironmentSpecId,
  pythonProjectBindingId,
  pythonProjectDirKey,
} from "../src/main/runtime/python-environment-spec";
import {
  PythonProjectBindingStore,
  type PythonBindingConnection,
} from "../src/main/runtime/PythonProjectBindingStore";
import {
  PythonEnvironmentStore,
  isPythonEnvironmentFailure,
  venvPythonRelativePath,
  type PythonEnvironmentProgress,
} from "../src/main/runtime/PythonEnvironmentStore";
import {
  UvToolchain,
  UV_PINNED_VERSION,
  parseSha256Sidecar,
  parseUvVersion,
  uvAssetName,
  uvExecutableName,
  type UvExecResult,
  type UvExecutor,
  type UvToolchainInfo,
} from "../src/main/runtime/UvToolchain";
import {
  parseProjectVersion,
  parsePyprojectDependencies,
  parseRequiresPython,
  parseRequirementsText,
  pythonRequestFromRequires,
  readPythonProjectSpec,
} from "../src/main/runtime/PythonProjectManifest";
import { PythonRuntimeService } from "../src/main/runtime/PythonRuntimeService";

/* ------------------------------------------------------------------ */
/* 假安装器                                                            */
/* ------------------------------------------------------------------ */

type FakeFailure = "interpreter" | "venv" | "dependency" | "verify" | null;

class FakeUv implements UvExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  ensureCalls = 0;
  available: boolean;
  fail: FakeFailure;
  pythonVersion: string;
  freeze: string[];
  private readonly platform: NodeJS.Platform;

  constructor(options: {
    platform?: NodeJS.Platform;
    available?: boolean;
    fail?: FakeFailure;
    pythonVersion?: string;
    freeze?: string[];
  } = {}) {
    this.platform = options.platform ?? "win32";
    this.available = options.available ?? true;
    this.fail = options.fail ?? null;
    this.pythonVersion = options.pythonVersion ?? "3.12.7";
    this.freeze = options.freeze ?? [];
  }

  locate(): UvToolchainInfo {
    return this.available
      ? { available: true, path: "Z:\\fake\\uv.exe", version: "0.12.13", source: "env" }
      : { available: false, path: null, version: null, source: null };
  }

  async ensure(): Promise<UvToolchainInfo> {
    this.ensureCalls += 1;
    return this.locate();
  }

  async exec(command: string, args: string[], options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<UvExecResult> {
    this.calls.push({ command, args });
    const ok = (stdout = ""): UvExecResult => ({ code: 0, stdout, stderr: "", cancelled: false });
    const bad = (stderr: string): UvExecResult => ({ code: 1, stdout: "", stderr, cancelled: false });

    if (options?.signal?.aborted) {
      return { code: null, stdout: "", stderr: "", cancelled: true };
    }
    if (args[0] === "--version") return ok("uv 0.12.13");
    if (args[0] === "python" && args[1] === "install") {
      return this.fail === "interpreter" ? bad("error: download failed (no network)") : ok("");
    }
    if (args[0] === "python" && args[1] === "find") return ok("fake-python");
    if (args[0] === "lock") {
      writeFileSync(join(options!.cwd!, "uv.lock"), "fake-lock");
      return this.fail === "dependency" ? bad("dependency conflict") : ok();
    }
    if (args[0] === "sync") {
      if (this.fail === "venv") return bad("error: failed to create venv");
      const target = options!.env!.UV_PROJECT_ENVIRONMENT!;
      const python = join(target, venvPythonRelativePath(this.platform));
      mkdirSync(dirname(python), { recursive: true });
      writeFileSync(python, "fake interpreter", "utf8");
      return ok("");
    }
    if (args[0] === "pip" && args[1] === "install") {
      return this.fail === "dependency" ? bad("error: no version matching pandas==99") : ok("");
    }
    if (args[0] === "pip" && args[1] === "freeze") return ok(this.freeze.join("\n"));
    if (args[0] === "-c") {
      return this.fail === "verify" ? bad("The system cannot execute this program") : ok(this.pythonVersion);
    }
    return ok("");
  }

  countOf(matcher: (args: string[]) => boolean): number {
    return this.calls.filter((call) => matcher(call.args)).length;
  }
}

/**
 * 内存版绑定表：只实现 store 真正发出的四种语句形态，其余一律抛错。
 *
 * 门禁测试要在没有 Python、没有 uv、也不接 sqlite 的机器上跑，所以这里用替身。
 * 抛错而不是静默返回空是有意的：SQL 形状一旦改动，用例会立刻失败，
 * 而不是变成「查不到绑定 → 走受管环境」这种看起来通过的假绿。
 */
function makeFakeBindingConnection(): PythonBindingConnection & {
  rows: Map<string, Record<string, unknown>>;
} {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        run(...args: unknown[]) {
          if (text.startsWith("INSERT INTO python_project_bindings")) {
            const [dirKey, projectDir, pythonPath, pythonVersion, manifestPath, boundAt] = args;
            rows.set(String(dirKey), {
              dir_key: dirKey,
              project_dir: projectDir,
              python_path: pythonPath,
              python_version: pythonVersion,
              manifest_path: manifestPath,
              bound_at: boundAt,
            });
            return { changes: 1 };
          }
          if (text.startsWith("DELETE FROM python_project_bindings")) {
            return { changes: rows.delete(String(args[0])) ? 1 : 0 };
          }
          throw new Error(`测试替身未覆盖的语句：${text}`);
        },
        get(...args: unknown[]) {
          if (text.includes("WHERE dir_key = ?")) return rows.get(String(args[0]));
          throw new Error(`测试替身未覆盖的语句：${text}`);
        },
        all() {
          if (text.startsWith("SELECT * FROM python_project_bindings ORDER BY")) {
            return [...rows.values()].sort((a, b) => Number(b.bound_at) - Number(a.bound_at));
          }
          throw new Error(`测试替身未覆盖的语句：${text}`);
        },
      };
    },
  };
}

/** 临时运行时根：路径里带中文与空格，验证真实 Windows 用户目录形态 */
function makeRoots(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-py 运行时-"));
  return {
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function storeOptions(
  root: string,
  uv: UvExecutor,
  onProgress?: (progress: PythonEnvironmentProgress) => void,
) {
  return {
    uv,
    platform: "win32" as NodeJS.Platform,
    environmentsDir: join(root, "environments"),
    manifestsDir: join(root, "manifests"),
    stagingDir: join(root, "staging"),
    interpretersDir: join(root, "interpreters"),
    onProgress,
  };
}

/** 门面还会读 runtime/toolchain/cache 三个根；同样注入临时目录，不碰真实 ~/.mybuddy */
function serviceOptions(root: string, uv: UvExecutor) {
  return {
    ...storeOptions(root, uv),
    runtimeDir: root,
    toolchainDir: join(root, "toolchain"),
    cacheDir: join(root, "cache"),
  };
}

/* ------------------------------------------------------------------ */
/* 纯函数：规格规范化与环境 id                                          */
/* ------------------------------------------------------------------ */

// 同义规格必须得到同一 id：顺序不同、大小写不同、重复项都归一
{
  const a = pythonEnvironmentSpecId({ python: "3.12", dependencies: ["pandas", "numpy"] });
  const b = pythonEnvironmentSpecId({ python: "3.12", dependencies: ["numpy", "pandas"] });
  const c = pythonEnvironmentSpecId({ python: "3.12", dependencies: ["Pandas", "pandas", "numpy"] });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
}

// 依赖冲突 → 不同 id → 另一套环境；版本号变化也算冲突
{
  const base = pythonEnvironmentSpecId({ dependencies: [] });
  const withPandas = pythonEnvironmentSpecId({ dependencies: ["pandas"] });
  const otherPandas = pythonEnvironmentSpecId({ dependencies: ["pandas==2.0.3"] });
  assert.notEqual(base, withPandas);
  assert.notEqual(withPandas, otherPandas);
}

// profile 参与 id：内置能力升级版本 → 新环境，而不是升级在用环境
{
  const v1 = pythonEnvironmentSpecId({ dependencies: ["numpy"], profile: "capability:local-whisper@1.0.0" });
  const v2 = pythonEnvironmentSpecId({ dependencies: ["numpy"], profile: "capability:local-whisper@1.1.0" });
  const noProfile = pythonEnvironmentSpecId({ dependencies: ["numpy"] });
  assert.notEqual(v1, v2);
  assert.notEqual(v1, noProfile);
}

// 缺省版本回落到默认请求；空字符串与空白同样回落
{
  assert.equal(normalizePythonEnvironmentSpec(undefined).python, DEFAULT_PYTHON_REQUEST);
  assert.equal(normalizePythonEnvironmentSpec({ python: "   " }).python, DEFAULT_PYTHON_REQUEST);
  assert.deepEqual(normalizePythonEnvironmentSpec({ dependencies: ["", "  ", "six"] }).dependencies, ["six"]);
}

// 规格摘要与失败阶段文案是中文且非空（UI 直接展示）
{
  assert.match(describePythonEnvironmentSpec({ dependencies: [] }), /基础环境/);
  assert.match(describePythonEnvironmentSpec({ dependencies: ["pandas"] }), /pandas/);
  assert.match(describePythonEnvironmentSpec({ profile: "capability:x@1", dependencies: [] }), /capability:x@1/);
  assert.match(pythonRuntimeDetail("failed", { failureStage: "dependency-install-failed", reason: "boom" }), /依赖安装失败/);
  assert.match(pythonRuntimeDetail("failed", { failureStage: "dependency-install-failed", reason: "boom" }), /boom/);
  assert.equal(pythonFailureStageLabel(null).length > 0, true);
  assert.equal(pythonFailureStageLabel("verify-failed"), "结果校验失败");
}

/* ------------------------------------------------------------------ */
/* 纯函数：uv 资产名 / 版本 / 校验和解析                                */
/* ------------------------------------------------------------------ */

// 平台资产名必须与官方 release 命名一致，未知平台直接抛错而不是猜
{
  assert.equal(uvAssetName("win32", "x64"), "uv-x86_64-pc-windows-msvc.zip");
  assert.equal(uvAssetName("win32", "arm64"), "uv-aarch64-pc-windows-msvc.zip");
  assert.equal(uvAssetName("darwin", "arm64"), "uv-aarch64-apple-darwin.tar.gz");
  assert.equal(uvAssetName("linux", "x64"), "uv-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(uvExecutableName("win32"), "uv.exe");
  assert.equal(uvExecutableName("darwin"), "uv");
  assert.throws(() => uvAssetName("aix" as NodeJS.Platform, "x64"), /不支持/);
}

{
  assert.equal(parseUvVersion("uv 0.12.13 (abc 2026-01-01)"), "0.12.13");
  assert.equal(parseUvVersion("no version here"), null);
  assert.equal(parseSha256Sidecar(`${"a".repeat(64)}  uv-x86_64-pc-windows-msvc.zip\n`), "a".repeat(64));
  assert.equal(parseSha256Sidecar("garbage"), null);
}

// 定位顺序：显式 env 覆盖 → 受管副本。PATH 上的 uv 永远不是候选
{
  const roots = makeRoots();
  try {
    const toolchain = new UvToolchain({
      platform: "win32",
      env: { Path: "C:\\somewhere\\with\\uv.exe" } as NodeJS.ProcessEnv,
      toolchainDir: join(roots.root, "toolchain"),
      exists: (path: string) => path.toLowerCase().endsWith("uv.exe") && isAbsolute(path) && path.includes("somewhere"),
    });
    // PATH 命中也不采纳：受管副本不存在就是不可用
    assert.equal(toolchain.locateSync().available, false);

    const override = join(roots.root, "便携 uv.exe");
    writeFileSync(override, "fake", "utf8");
    const withOverride = new UvToolchain({
      platform: "win32",
      env: { MYBUDDY_UV_PATH: override },
      toolchainDir: join(roots.root, "toolchain"),
      exists: (path: string) => path === override,
    });
    const located = withOverride.locateSync();
    assert.equal(located.available, true);
    assert.equal(located.source, "env");
    assert.equal(located.path, override);

    // 相对路径覆盖不被接受
    const relative = new UvToolchain({
      platform: "win32",
      env: { MYBUDDY_UV_PATH: "uv.exe" },
      toolchainDir: join(roots.root, "toolchain"),
      exists: () => true,
    });
    assert.equal(relative.locateSync().available, false);
  } finally {
    roots.dispose();
  }
}

// 受管副本按清单里的 sha256 离线复验；对不上就当作不可用（触发重新下载）
{
  const roots = makeRoots();
  try {
    const toolchain = new UvToolchain({ platform: "win32", toolchainDir: join(roots.root, "toolchain") });
    const exePath = toolchain.managedExecutablePath();
    mkdirSync(dirname(exePath), { recursive: true });
    writeFileSync(exePath, "fake uv binary", "utf8");
    writeFileSync(
      toolchain.managedManifestPath(),
      JSON.stringify({
        version: "0.12.13",
        asset: "uv-x86_64-pc-windows-msvc.zip",
        url: "https://example.invalid/uv.zip",
        sha256: "0".repeat(64),
        executable: exePath,
        installedAt: Date.now(),
      }),
      "utf8",
    );
    assert.equal(toolchain.locateSync().available, false, "sha256 不匹配必须判为不可用");

    writeFileSync(
      toolchain.managedManifestPath(),
      JSON.stringify({
        version: "0.12.13",
        asset: "uv-x86_64-pc-windows-msvc.zip",
        url: "https://example.invalid/uv.zip",
        sha256: "0".repeat(64),
        executable: exePath,
        installedAt: Date.now(),
      }),
      "utf8",
    );
    // 清单缺失时仍可用，但不声称版本已知
    rmSync(toolchain.managedManifestPath(), { force: true });
    const withoutManifest = toolchain.locateSync();
    assert.equal(withoutManifest.available, false);
    assert.equal(withoutManifest.source, null);
    assert.equal(withoutManifest.version, null);
  } finally {
    roots.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数：项目清单解析                                                 */
/* ------------------------------------------------------------------ */

{
  const pyproject = [
    "[build-system]",
    'requires = ["hatchling"]',
    "",
    "[project]",
    'name = "whisper-voice-ime"',
    'version = "1.0.0"',
    'requires-python = ">=3.10,<3.13"',
    "dependencies = [",
    '    "numpy>=1.24",',
    '    "openai-whisper==20231117",  # 固定版本',
    '    "sounddevice",',
    "]",
    "",
    "[project.optional-dependencies]",
    'dev = ["pytest"]',
  ].join("\n");

  assert.deepEqual(parsePyprojectDependencies(pyproject), [
    "numpy>=1.24",
    "openai-whisper==20231117",
    "sounddevice",
  ]);
  assert.equal(parseRequiresPython(pyproject), ">=3.10,<3.13");
  assert.equal(parseProjectVersion(pyproject), "1.0.0");
  assert.equal(pythonRequestFromRequires(">=3.10,<3.13"), ">=3.10,<3.13");
  assert.equal(pythonRequestFromRequires(null), null);
  assert.equal(pythonRequestFromRequires("no numbers"), null);

  // optional-dependencies 段不能被当成主依赖
  assert.equal(parsePyprojectDependencies(pyproject).includes("pytest"), false);
}

{
  const requirements = [
    "# 注释行",
    "pandas>=2.0",
    "",
    "-r other.txt",
    "--index-url https://example.invalid/simple",
    "openpyxl  # 行内注释",
  ].join("\n");
  assert.deepEqual(parseRequirementsText(requirements), ["pandas>=2.0", "openpyxl"]);
}

// 真实目录：pyproject 优先于 requirements；.python-version 覆盖 requires-python
{
  const roots = makeRoots();
  try {
    const project = join(roots.root, "我的 项目");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".python-version"), "3.12\n", "utf8");
    writeFileSync(
      join(project, "pyproject.toml"),
      ['[project]', 'version = "2.1.0"', 'requires-python = ">=3.10"', "dependencies = [", '    "six",', "]"].join("\n"),
      "utf8",
    );
    writeFileSync(join(project, "requirements.txt"), "ignored\n", "utf8");

    const result = readPythonProjectSpec(project);
    assert.equal(result.source, "pyproject");
    assert.equal(result.spec.python, "3.12");
    assert.deepEqual(result.spec.dependencies, ["six"]);

    // 只有 requirements.txt
    const reqOnly = join(roots.root, "req only");
    mkdirSync(reqOnly, { recursive: true });
    writeFileSync(join(reqOnly, "requirements.txt"), "requests\n", "utf8");
    const reqResult = readPythonProjectSpec(reqOnly);
    assert.equal(reqResult.source, "requirements");
    assert.deepEqual(reqResult.spec.dependencies, ["requests"]);

    // 什么都没有 → none，调用方据此走基础环境
    const empty = join(roots.root, "empty");
    mkdirSync(empty, { recursive: true });
    const noneResult = readPythonProjectSpec(empty);
    assert.equal(noneResult.source, "none");
    assert.deepEqual(noneResult.spec.dependencies ?? [], []);
  } finally {
    roots.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 环境存储：准备 / 复用 / 冲突隔离 / 失败残留                          */
/* ------------------------------------------------------------------ */

// 首次创建：staging 安装 → 原子晋级 → 复验 → 写清单；结果带真实解释器路径
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ freeze: ["numpy==1.26.4", "pandas==2.2.0"] });
    const phases: string[] = [];
    const store = new PythonEnvironmentStore(
      storeOptions(roots.root, uv, (progress) => phases.push(progress.phase)),
    );

    const result = await store.prepare({ dependencies: ["numpy", "pandas"] }, { label: "分析环境" });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.ok(result.pythonPath);
    assert.equal(existsSync(result.pythonPath!), true, "最终路径必须有解释器文件");
    assert.equal(result.pythonPath!.startsWith(join(roots.root, "environments")), true);
    assert.equal(result.pythonPath!.includes("staging"), false, "不能把 staging 路径交出去");

    const manifest = store.readManifest(result.environmentId);
    assert.ok(manifest);
    assert.equal(manifest!.ready, true);
    assert.equal(manifest!.label, "分析环境");
    assert.deepEqual(manifest!.lockedDependencies, ["numpy==1.26.4", "pandas==2.2.0"]);
    assert.equal(manifest!.pythonVersion, "3.12.7");

    // 晋级后 staging 不留残留
    assert.equal((existsSync(join(roots.root, "staging")) ? readdirSync(join(roots.root, "staging")).length : 0), 0);
    // 阶段顺序对用户可见：检查 → 安装 → 校验 → 就绪
    assert.deepEqual(
      phases.filter((phase, index) => phases.indexOf(phase) === index),
      ["checking", "installing", "verifying", "ready"],
    );
  } finally {
    roots.dispose();
  }
}

// 复用：同规格第二次准备不重装（created=false，uv 不再被调用）
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const first = await store.prepare({ python: "3.12" });
    const callsAfterFirst = uv.calls.length;
    const second = await store.prepare({ python: "3.12", dependencies: [] });
    assert.equal(first.ok && second.ok, true);
    assert.equal(first.environmentId, second.environmentId);
    assert.equal(second.created, false);
    assert.equal(uv.calls.length, callsAfterFirst, "复用绝不能再次安装");
    assert.equal(second.pythonPath, first.pythonPath);
  } finally {
    roots.dispose();
  }
}

// 并发同规格：互斥生效，只安装一次，两个请求拿到同一个环境 id
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const spec = { dependencies: ["requests"] };
    const [a, b, c] = await Promise.all([store.prepare(spec), store.prepare(spec), store.prepare(spec)]);
    assert.equal(a.environmentId, b.environmentId);
    assert.equal(b.environmentId, c.environmentId);
    assert.equal(uv.countOf((args) => args[0] === "sync"), 1, "并发必须只创建一次环境");
    assert.equal(uv.countOf((args) => args[0] === "sync"), 1);
    assert.equal(uv.ensureCalls, 1, "共享同一次安装，uv 只被确保一次");
    // 三个请求共享同一次 single-flight 安装，因此都报告 created:true——
    // 这次调用确实创建出了环境；真正要守住的不变量是上面「只安装一次」
    assert.deepEqual([a.created, b.created, c.created], [true, true, true]);
    assert.equal(a.environmentPath, c.environmentPath);
    assert.equal(a.pythonPath, c.pythonPath);
  } finally {
    roots.dispose();
  }
}

// 冲突依赖 → 另一套环境；已就绪的原环境目录一字未动（不原地升级）
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const base = await store.prepare({ dependencies: ["pandas==2.0.3"] });
    assert.equal(base.ok, true);
    const basePath = base.environmentPath!;
    const before = readFileSync(join(basePath, venvPythonRelativePath("win32")), "utf8");

    const upgraded = await store.prepare({ dependencies: ["pandas==2.2.0"] });
    assert.equal(upgraded.ok, true);
    assert.notEqual(upgraded.environmentId, base.environmentId);
    assert.notEqual(upgraded.environmentPath, basePath);
    assert.equal(existsSync(basePath), true, "原环境必须仍然存在");
    assert.equal(readFileSync(join(basePath, venvPythonRelativePath("win32")), "utf8"), before);
    assert.equal(store.list().length, 2);
  } finally {
    roots.dispose();
  }
}

// 依赖安装失败：不写清单、不晋级，只留可清理的 staging 语义（这里 finally 已清）
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ fail: "dependency" });
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const result = await store.prepare({ dependencies: ["pandas==99"] });
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "dependency-install-failed");
    assert.equal(store.readManifest(result.environmentId), null, "失败绝不能写清单");
    assert.equal(existsSync(store.environmentPath(result.environmentId)), false, "失败绝不能留下 environments/<id>");
    assert.equal(store.isReady(result.environmentId), false);
    assert.equal((existsSync(join(roots.root, "staging")) ? readdirSync(join(roots.root, "staging")).length : 0), 0);

    // 失败后 resolve 给出明确阶段，而不是回退系统 Python
    const resolved = store.resolve({ dependencies: ["pandas==99"] });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.failureStage, "uv-unavailable");
    assert.equal(resolved.pythonPath, undefined);
    assert.match(resolved.detail ?? "", /不回退系统 Python/);
  } finally {
    roots.dispose();
  }
}

// 解释器下载失败 → interpreter-install-failed，且没有任何目录被创建
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ fail: "interpreter" });
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const result = await store.prepare({ python: "3.11" });
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "interpreter-install-failed");
    assert.match(result.detail ?? "", /解释器安装失败/);
    assert.equal(existsSync(join(roots.root, "environments")), false);
  } finally {
    roots.dispose();
  }
}

// uv 不可用 → uv-unavailable；这是「拒绝静默回退系统 Python」的入口
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ available: false });
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const result = await store.prepare({});
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "uv-unavailable");
    assert.equal(uv.countOf((args) => args[0] === "venv"), 0);
  } finally {
    roots.dispose();
  }
}

// 晋级后复验失败 → 已改名的目录被删掉，绝不把半成品标成就绪
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ fail: "verify" });
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const result = await store.prepare({ dependencies: ["six"] });
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "verify-failed");
    assert.equal(existsSync(store.environmentPath(result.environmentId)), false, "复验失败必须删除已晋级目录");
    assert.equal(store.readManifest(result.environmentId), null);
    assert.equal(store.isReady(result.environmentId), false);
  } finally {
    roots.dispose();
  }
}

// 取消：中断信号让准备以 cancelled 结束，不留就绪环境、不留暂存残留
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const controller = new AbortController();
    controller.abort();
    const result = await store.prepare({ dependencies: ["six"] }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "cancelled");
    assert.equal(store.isReady(result.environmentId), false, "取消后绝不能留下就绪环境");
    assert.equal(existsSync(store.environmentPath(result.environmentId)), false);
    assert.equal((existsSync(join(roots.root, "staging")) ? readdirSync(join(roots.root, "staging")).length : 0), 0);
  } finally {
    roots.dispose();
  }
}

// 回收：使用中的环境拒绝删除；未使用的可删，目录与清单一起清掉
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const result = await store.prepare({ dependencies: ["six"] });
    assert.equal(result.ok, true);
    const id = result.environmentId;

    const release = store.acquire(id);
    assert.equal(store.list().find((item) => item.id === id)?.inUse, true);
    const refused = store.remove(id);
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /正在被任务使用/);
    assert.equal(existsSync(store.environmentPath(id)), true);

    // resolve 也会标记使用中，因此同样不可删
    assert.equal(store.remove(id).ok, false);
  } finally {
    roots.dispose();
  }
}

// cleanStaging：把失败安装留下的暂存目录清掉
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const staging = join(roots.root, "staging");
    mkdirSync(join(staging, "env-残留-1"), { recursive: true });
    mkdirSync(join(staging, "env-残留-2"), { recursive: true });
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const cleaned = store.cleanStaging();
    assert.equal(cleaned.removed, 2);
    assert.equal(readdirSync(staging).length, 0);
    assert.equal(store.cleanStaging().removed, 0);
  } finally {
    roots.dispose();
  }
}

// 清单损坏（半成品）不会被当成就绪
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const id = pythonEnvironmentSpecId({ dependencies: ["six"] });
    mkdirSync(join(roots.root, "manifests"), { recursive: true });
    writeFileSync(store.manifestPath(id), "{ not json", "utf8");
    assert.equal(store.isReady(id), false);
    assert.equal(store.readManifest(id), null);
    assert.equal(store.resolve({ dependencies: ["six"] }).ok, false);

    writeFileSync(
      store.manifestPath(id),
      JSON.stringify({
        schemaVersion: 1,
        id,
        label: "six",
        pythonRequest: "3.12",
        pythonVersion: "3.12.7",
        dependencies: ["six"],
        lockedDependencies: ["six==1.16.0"],
        environmentPath: store.environmentPath(id),
        pythonPath: store.pythonPathOf(id),
        createdAt: Date.now(),
        ready: false,
      }),
      "utf8",
    );
    assert.equal(store.isReady(id), false, "ready:false 的清单不算就绪");
    // list() 仍能看到这个未就绪条目，便于用户回收
    assert.equal(store.list().some((item) => item.id === id && !item.ready), true);
  } finally {
    roots.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 门面：需求解析与执行前解析                                            */
/* ------------------------------------------------------------------ */

// 代码内联声明：# mybuddy-python / # mybuddy-deps
{
  const service = new PythonRuntimeService();
  assert.deepEqual(service.specFromCode("print(1)"), {});
  const declared = service.specFromCode(
    ["# mybuddy-python: 3.11", "# mybuddy-deps: pandas, openpyxl>=2.1", "import pandas"].join("\n"),
  );
  assert.equal(declared.python, "3.11");
  assert.deepEqual(declared.dependencies, ["pandas", "openpyxl>=2.1"]);

  // 声明出现在文件中部也要认（Agent 常把注释写在 import 之后）
  const mid = service.specFromCode(["import sys", "# mybuddy-deps: requests", "print(sys.version)"].join("\n"));
  assert.deepEqual(mid.dependencies, ["requests"]);
}

// 内置能力规格：profile 带能力版本，版本升级 → 环境 id 变化
{
  const service = new PythonRuntimeService();
  const spec = { dependencies: ["numpy"] };
  const v1 = service.specForBuiltinCapability("local-whisper", "1.0.0", spec);
  const v2 = service.specForBuiltinCapability("local-whisper", "1.1.0", spec);
  assert.equal(v1.profile, "capability:local-whisper@1.0.0");
  assert.notEqual(pythonEnvironmentSpecId(v1), pythonEnvironmentSpecId(v2));
  assert.notEqual(pythonEnvironmentSpecId(v1), pythonEnvironmentSpecId(spec));
}

// Skill 声明：缺失字段一律降级基础环境，不猜包列表
{
  const service = new PythonRuntimeService();
  assert.deepEqual(service.specFromSkillDeclaration(null), {});
  assert.deepEqual(service.specFromSkillDeclaration({ name: "x" }), {});
  assert.deepEqual(service.specFromSkillDeclaration({ python: "3.11", "python-dependencies": "pandas, six" }), {
    python: "3.11",
    dependencies: ["pandas", "six"],
  });
  assert.deepEqual(
    service.specFromSkillDeclaration({ "python-dependencies": ["numpy", "scipy"] }).dependencies,
    ["numpy", "scipy"],
  );
}

// 执行前解析：未就绪 → 自动准备 → 返回受管解释器路径
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const service = new PythonRuntimeService(serviceOptions(roots.root, uv));
    const resolution = await service.resolveForExecution({ dependencies: ["six"] }, { label: "任务" });
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(existsSync(resolution.pythonPath), true);
      assert.equal(resolution.pythonVersion, "3.12.7");
      assert.equal(isAbsolute(resolution.pythonPath), true);
    }
    // 再次解析走复用，不再安装
    const calls = uv.calls.length;
    const again = await service.resolveForExecution({ dependencies: ["six"] });
    assert.equal(again.ok, true);
    assert.equal(uv.calls.length, calls);
  } finally {
    roots.dispose();
  }
}

// 执行前解析：uv 不可用 → 明确失败阶段，绝不给出系统 python
{
  const roots = makeRoots();
  try {
    const service = new PythonRuntimeService(serviceOptions(roots.root, new FakeUv({ available: false })));
    const resolution = await service.resolveForExecution({});
    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.equal(resolution.failureStage, "uv-unavailable");
      assert.equal(resolution.phase, "failed");
      assert.ok(resolution.detail);
    }
    assert.equal("pythonPath" in resolution, false);
  } finally {
    roots.dispose();
  }
}

// 项目脚本模式：默认仍走受管环境；只有明确执行项目脚本时才允许项目解释器接管
{
  const roots = makeRoots();
  try {
    const projectDir = join(roots.root, "我的 项目");
    const projectPython = join(projectDir, ".venv", "Scripts", "python.exe");
    mkdirSync(dirname(projectPython), { recursive: true });
    writeFileSync(projectPython, "project interpreter", "utf8");

    const dirKey = pythonProjectDirKey(projectDir, "win32");
    let binding: PythonProjectBinding | null = {
      projectDir,
      dirKey,
      pythonPath: projectPython,
      pythonVersion: "3.11.9",
      manifestPath: null,
      boundAt: Date.now(),
    };
    const uv = new FakeUv();
    const service = new PythonRuntimeService({
      ...serviceOptions(roots.root, uv),
      projectModeResolver: () => binding,
    });

    // taskRoot 本身不能劫持临时代码/Skill：默认必须按依赖规格走受管环境。
    const managedByDefault = await service.resolveForExecution({ dependencies: ["pandas"] }, { taskRoot: projectDir });
    assert.equal(managedByDefault.ok, true);
    if (managedByDefault.ok) assert.equal(managedByDefault.environmentId.startsWith("project:"), false);
    const managedCallCount = uv.calls.length;

    // 只有项目脚本调用方显式声明 useProjectBinding 才使用手动覆盖的项目解释器。
    const bound = await service.resolveForExecution(
      { dependencies: ["pandas"] },
      { taskRoot: projectDir, useProjectBinding: true },
    );
    assert.equal(bound.ok, true);
    if (bound.ok) {
      assert.equal(bound.pythonPath, projectPython);
      assert.equal(bound.environmentId, `project:${pythonProjectBindingId(dirKey)}`);
      assert.equal(bound.pythonVersion, "3.11.9", "版本取自绑定时探测的结果，不再留空");
    }
    assert.equal(uv.calls.length, managedCallCount, "项目脚本覆盖不应额外触发受管安装");

    // 显式项目解释器失效必须明确失败，不能静默换成另一个 Python。
    rmSync(projectDir, { recursive: true, force: true });
    const broken = await service.resolveForExecution(
      { dependencies: ["pandas"] },
      { taskRoot: projectDir, useProjectBinding: true },
    );
    assert.equal(broken.ok, false);

    // 未显式绑定（resolver 返回 null）→ 走受管环境；
    // 这条保证「当前目录恰好有 pyproject.toml」不会自动切换执行环境
    binding = null;
    const managed = await service.resolveForExecution({}, { taskRoot: join(roots.root, "任意目录") });
    assert.equal(managed.ok, true);
    if (managed.ok) assert.equal(managed.environmentId.startsWith("project:"), false);
  } finally {
    roots.dispose();
  }
}

// 目录键归一：Windows 下换个大小写或分隔符仍是同一个项目，否则绑定会被反复询问
{
  const win = pythonProjectDirKey("C:\\Users\\Servi\\Desktop\\我的 项目", "win32");
  assert.equal(win, pythonProjectDirKey("c:/users/servi/desktop/我的 项目", "win32"));
  assert.equal(win, "c:/users/servi/desktop/我的 项目");
  assert.equal(pythonProjectBindingId(win), pythonProjectBindingId(win), "绑定 id 必须稳定");
  // POSIX 大小写敏感：/tmp/A 与 /tmp/a 是两个不同项目
  assert.notEqual(pythonProjectDirKey("/tmp/A", "linux"), pythonProjectDirKey("/tmp/a", "linux"));
}

// 绑定存储：幂等 upsert、子目录继承、解绑、解释器失效标记
{
  const roots = makeRoots();
  try {
    const projectDir = join(roots.root, "我的 项目");
    const pythonPath = join(projectDir, ".venv", "Scripts", "python.exe");
    mkdirSync(dirname(pythonPath), { recursive: true });
    writeFileSync(pythonPath, "project interpreter", "utf8");

    const conn = makeFakeBindingConnection();
    const store = new PythonProjectBindingStore(conn, "win32");
    const binding: PythonProjectBinding = {
      projectDir,
      dirKey: pythonProjectDirKey(projectDir, "win32"),
      pythonPath,
      pythonVersion: "3.11.9",
      manifestPath: join(projectDir, "pyproject.toml"),
      boundAt: 1000,
    };

    // 未绑定不得命中：这是「有 pyproject.toml 也不切换环境」的存储层保证
    assert.equal(store.resolveForDir(projectDir), null);
    store.save(binding);

    const inherited = store.resolveForDir(join(projectDir, "src", "子包"));
    assert.ok(inherited, "子目录应继承最近的祖先绑定");
    assert.equal(inherited.pythonPath, pythonPath);
    assert.equal(inherited.available, true);

    // 继承只向上：父目录不该被子里的绑定影响
    assert.equal(store.resolveForDir(roots.root), null);

    // 同一目录改绑到另一个解释器 → 覆盖，不留两行互相打架
    store.save({ ...binding, pythonPath: join(projectDir, "别的.exe"), boundAt: 2000 });
    assert.equal(conn.rows.size, 1);
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].pythonPath, join(projectDir, "别的.exe"));
    // 新解释器不存在 → 标记失效但保留行，用户重建 venv 后绑定自动恢复
    assert.equal(listed[0].available, false);

    assert.equal(store.remove(projectDir), true);
    assert.equal(store.remove(projectDir), false, "解绑幂等");
    assert.equal(store.resolveForDir(projectDir), null);
  } finally {
    roots.dispose();
  }
}

// bindProject：先真跑解释器再落库；跑不起来就明确失败，不留下半成品绑定
{
  const roots = makeRoots();
  try {
    const projectDir = join(roots.root, "我的 项目");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "pyproject.toml"),
      '[project]\nname = "demo"\nrequires-python = ">=3.11"\ndependencies = ["pandas"]\n',
      "utf8",
    );
    const pythonPath = join(projectDir, ".venv", "Scripts", "python.exe");
    mkdirSync(dirname(pythonPath), { recursive: true });
    writeFileSync(pythonPath, "project interpreter", "utf8");

    const uv = new FakeUv({ pythonVersion: "3.11.9" });
    const service = new PythonRuntimeService(serviceOptions(roots.root, uv));
    const conn = makeFakeBindingConnection();
    service.setProjectBindingStore(new PythonProjectBindingStore(conn, "win32"));
    assert.deepEqual(service.listProjectBindings(), [], "接线后初始为空");

    // 零配置：没有手动记录时，当前项目的 .venv 应自动被识别。
    const automatic = await service.inspectProject(projectDir);
    assert.equal(automatic.source, "auto");
    assert.equal(automatic.pythonPath, pythonPath);
    assert.equal(automatic.pythonVersion, "3.11.9");
    const automaticResolution = await service.resolveForExecution(
      {},
      { taskRoot: projectDir, useProjectBinding: true },
    );
    assert.equal(automaticResolution.ok, true);
    if (automaticResolution.ok) assert.equal(automaticResolution.pythonPath, pythonPath);

    const missingDir = await service.bindProject({ projectDir: join(roots.root, "不存在"), pythonPath });
    assert.equal(missingDir.ok, false);
    if (!missingDir.ok) assert.match(missingDir.error, /不存在/);

    const missingPython = await service.bindProject({ projectDir, pythonPath: join(projectDir, "没有.exe") });
    assert.equal(missingPython.ok, false);
    assert.equal(conn.rows.size, 0, "校验失败不得留下绑定");

    // 探测失败（解释器跑不起来）→ 不落库
    const brokenUv = new FakeUv({ fail: "verify" });
    const brokenService = new PythonRuntimeService(serviceOptions(roots.root, brokenUv));
    const brokenConn = makeFakeBindingConnection();
    brokenService.setProjectBindingStore(new PythonProjectBindingStore(brokenConn, "win32"));
    const broken = await brokenService.bindProject({ projectDir, pythonPath });
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.match(broken.error, /解释器无法执行/);
    assert.equal(brokenConn.rows.size, 0, "跑不起来的解释器不得被标成可用绑定");

    const ok = await service.bindProject({ projectDir, pythonPath });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.binding.pythonVersion, "3.11.9");
      assert.equal(ok.binding.manifestPath, join(projectDir, "pyproject.toml"), "应记录项目自己的清单");
      assert.equal(ok.binding.available, true);
    }
    assert.equal(service.listProjectBindings().length, 1);

    // 绑定生效后：子目录任务用项目解释器，且完全不触发受管安装
    const resolution = await service.resolveForExecution(
      { dependencies: ["numpy"] },
      { taskRoot: join(projectDir, "src"), useProjectBinding: true },
    );
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.pythonPath, resolve(pythonPath));
      assert.equal(resolution.pythonVersion, "3.11.9");
      assert.equal(
        resolution.environmentId,
        `project:${pythonProjectBindingId(pythonProjectDirKey(projectDir, "win32"))}`,
      );
    }
    assert.equal(uv.countOf((args) => args[0] === "venv"), 0, "项目模式不应创建受管环境");

    const unbound = service.unbindProject(projectDir);
    assert.equal(unbound.ok, true);
    const autoAfterReset = await service.inspectProject(projectDir);
    assert.equal(autoAfterReset.source, "auto", "取消手动覆盖后应恢复自动识别，而不是删除项目 Python 语义");
    assert.equal(autoAfterReset.pythonPath, pythonPath);
    const projectScriptAfterReset = await service.resolveForExecution(
      {},
      { taskRoot: projectDir, useProjectBinding: true },
    );
    assert.equal(projectScriptAfterReset.ok, true);
    if (projectScriptAfterReset.ok) assert.equal(projectScriptAfterReset.pythonPath, pythonPath);

    // 不声明项目脚本模式的临时代码仍然必须走受管环境。
    const after = await service.resolveForExecution({}, { taskRoot: projectDir });
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.environmentId.startsWith("project:"), false, "临时代码不能被项目环境劫持");
    assert.equal(service.unbindProject(projectDir).ok, false);
  } finally {
    roots.dispose();
  }
}

// 回收：被取代的 uv 版本目录与下载缓存清掉，当前 pin 与解释器留着
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const toolchainDir = join(roots.root, "toolchain");
    const cacheDir = join(roots.root, "cache");
    const store = new PythonEnvironmentStore({ ...storeOptions(roots.root, uv), toolchainDir, cacheDir });

    const superseded = join(toolchainDir, "uv", "0.9.0");
    const pinned = join(toolchainDir, "uv", UV_PINNED_VERSION);
    mkdirSync(superseded, { recursive: true });
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(superseded, "uv.exe"), "superseded", "utf8");
    writeFileSync(join(pinned, "uv.exe"), "current", "utf8");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "uv-x86_64-pc-windows-msvc.zip"), "archive", "utf8");
    const interpreterDir = join(roots.root, "interpreters", "cpython-3.12.7");
    mkdirSync(interpreterDir, { recursive: true });

    const result = store.reclaimDisk();
    assert.equal(result.removed, 2, "旧 uv 副本与缓存各算一项");
    assert.equal(existsSync(superseded), false, "被取代的 uv 版本目录被回收");
    assert.equal(existsSync(pinned), true, "当前 pin 的 uv 不能删");
    assert.equal(readdirSync(cacheDir).length, 0, "下载缓存被清空（可重新下载）");
    assert.equal(existsSync(interpreterDir), true, "解释器不在回收范围内");
    assert.match(store.reclaimDisk().detail, /没有可回收/);
  } finally {
    roots.dispose();
  }
}

// 目录被外部删掉的死环境仍可回收：否则列表里永久留一行 ready=false 又删不掉的记录
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const prepared = await store.prepare({ dependencies: [] }, { label: "base" });
    assert.equal(prepared.ok, true);
    const id = prepared.environmentId;

    rmSync(store.environmentPath(id), { recursive: true, force: true });
    rmSync(store.manifestPath(id), { force: true });

    const rows = store.list();
    assert.equal(rows.length, 1, "label 仍让这条记录出现在列表里");
    assert.equal(rows[0].ready, false);

    const removed = store.remove(id);
    assert.equal(removed.ok, true);
    assert.match(removed.detail, /失效/);
    assert.deepEqual(store.list(), [], "回收后不再留下死记录");
    assert.equal(store.remove(id).ok, false, "第二次回收明确说明环境不存在");
  } finally {
    roots.dispose();
  }
}

// 诊断导出：能回答「哪个环境、哪个解释器、哪个项目被钉住」，且整份快照可序列化
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ pythonVersion: "3.12.7" });
    const service = new PythonRuntimeService(serviceOptions(roots.root, uv));

    // DB 尚未接线时也必须能导出：诊断本来就是「出问题时才用」，不能反过来依赖装配顺序
    const unwired = service.exportDiagnostics();
    assert.deepEqual(unwired.projectBindings, [], "未接线绑定存储时导出空数组而不是崩溃");
    const unwiredRoots = unwired.roots as Record<string, string>;
    assert.equal(unwiredRoots.runtime, roots.root, "导出的目录就是本次真正在用的目录");
    assert.equal(unwiredRoots.staging, join(roots.root, "staging"));

    const prepared = await service.prepare({ dependencies: ["pandas"] });
    assert.equal(prepared.ok, true);

    const projectDir = join(roots.root, "我的 项目");
    mkdirSync(projectDir, { recursive: true });
    const pythonPath = join(projectDir, ".venv", "Scripts", "python.exe");
    mkdirSync(dirname(pythonPath), { recursive: true });
    writeFileSync(pythonPath, "project interpreter", "utf8");
    const conn = makeFakeBindingConnection();
    service.setProjectBindingStore(new PythonProjectBindingStore(conn, "win32"));
    const bound = await service.bindProject({ projectDir, pythonPath });
    assert.equal(bound.ok, true);

    const snapshot = service.exportDiagnostics();
    assert.equal(typeof snapshot.exportedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(snapshot.exportedAt as string)), "exportedAt 是可解析的时间戳");
    assert.equal((snapshot.environments as unknown[]).length, 1, "导出含受管环境清单");
    assert.equal((snapshot.manifests as unknown[]).length, 1, "导出含锁定结果，便于复现依赖");
    assert.equal((snapshot.projectBindings as unknown[]).length, 1, "导出含项目绑定");

    // 主进程就是 JSON.stringify(payload, null, 2) 写盘，这里验证同样的往返
    const restored = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(restored).sort(), Object.keys(snapshot).sort());
    const bindings = restored.projectBindings as Array<Record<string, unknown>>;
    assert.equal(bindings[0].pythonVersion, "3.12.7", "绑定版本取自探测结果");
    assert.equal(bindings[0].available, true);
  } finally {
    roots.dispose();
  }
}

// 失败对象带 stage，且状态里报告的就是真正在用的目录
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv({ fail: "dependency" });
    const service = new PythonRuntimeService(serviceOptions(roots.root, uv));
    const result = await service.prepare({ dependencies: ["pandas==99"] });
    assert.equal(result.ok, false);
    assert.equal(result.failureStage, "dependency-install-failed");
    assert.equal(isPythonEnvironmentFailure(new Error("plain")), false);
    const status = await service.status();
    assert.equal(status.phase, "failed");
    assert.equal(status.failureStage, "dependency-install-failed");
    assert.match(status.detail, /依赖安装失败/);
    assert.equal(status.roots.runtime, roots.root);
    assert.equal(status.roots.environments, join(roots.root, "environments"));
    assert.equal(status.roots.staging, join(roots.root, "staging"));
    assert.equal(status.roots.cache, join(roots.root, "cache"));
    assert.equal(status.roots.toolchain, join(roots.root, "toolchain"));
    assert.equal(status.roots.manifests, join(roots.root, "manifests"));
    assert.equal(status.uv.available, true);
    assert.equal(status.uv.version, "0.12.13");
    assert.deepEqual(status.environments.filter((item) => item.ready), []);
  } finally {
    roots.dispose();
  }
}

// Download archive and executable have different digests. Reopen from disk, not cached state.
{
  const roots = makeRoots();
  try {
    const zip = new JSZip(); zip.file("uv.exe", "mock executable bytes");
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const sha = createHash("sha256").update(archive).digest("hex");
    const options = { ...storeOptions(roots.root, new FakeUv()), env: {}, platform: "win32" as const,
      fetchImpl: (async (url: string | URL | Request) => String(url).endsWith(".sha256")
        ? new Response(sha) : new Response(new Uint8Array(archive))) as typeof fetch };
    const tool = new UvToolchain(options);
    assert.equal((await tool.ensure()).available, true);
    assert.equal(new UvToolchain(options).locateSync().available, true);
    writeFileSync(tool.managedExecutablePath(), "corrupt");
    assert.equal(new UvToolchain(options).locateSync().available, false);
  } finally { roots.dispose(); }
}

// First waiter's cancellation must neither kill the second waiter nor allow GC of active staging.
{
  const roots = makeRoots();
  try {
    const uv = new FakeUv();
    const original = uv.exec.bind(uv);
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    uv.exec = async (cmd, args, opts) => { if (args[0] === "lock") { entered(); await gate; } return original(cmd, args, opts); };
    const store = new PythonEnvironmentStore(storeOptions(roots.root, uv));
    const a = new AbortController();
    const first = store.prepare({ dependencies: ["six"] }, { signal: a.signal });
    const second = store.prepare({ dependencies: ["six"] });
    await started;
    mkdirSync(store.stagingDir, { recursive: true });
    const marker = join(store.stagingDir, "active"); writeFileSync(marker, "keep");
    assert.equal(store.cleanStaging().removed, 0);
    assert.equal(existsSync(marker), true);
    a.abort();
    assert.equal((await first).failureStage, "cancelled");
    unblock();
    const finished = await second;
    assert.equal(finished.ok, true);
    assert.equal(uv.countOf(args => args[0] === "sync"), 1);
    assert.equal(store.cleanStaging().removed, 1);
    const locks = uv.countOf(args => args[0] === "lock");
    assert.equal(store.remove(finished.environmentId).ok, true);
    assert.equal((await store.prepare({ dependencies: ["six"] })).ok, true);
    assert.equal(uv.countOf(args => args[0] === "lock"), locks, "rebuild must retain the resolved lock");
    assert.equal(store.remove("../../outside").ok, false);
  } finally { roots.dispose(); }
}
assert.deepEqual(splitPythonDependencies('pandas>=2,<3, foo[a,b]>=1; python_version < "3.14", six'), ['pandas>=2,<3', 'foo[a,b]>=1; python_version < "3.14"', 'six']);
console.log("python runtime PASS");
