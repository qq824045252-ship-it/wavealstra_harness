/**
 * 受管 Python 环境存储：规格 → 环境目录的唯一权威。
 *
 * 冻结约束：
 *  - 环境 id 由规范化规格的 sha256 决定（见 shared/python-runtime.pythonEnvironmentSpecId）。
 *    相同兼容规格复用同一环境；依赖不同 → id 不同 → 另一套环境。
 *  - 已就绪环境绝不原地装包或升级。新增依赖只会命中不同 id，因此结构上不可能
 *    出现「任务 A 跑到一半被任务 B 升级依赖破坏」。
 *  - 在固定最终路径创建 venv；完整校验后原子发布 ready 清单，环境不搬移。
 *  - 首次创建按 id 互斥（进程内）。主进程已由 index.ts:309 的
 *    requestSingleInstanceLock 保证单实例，因此无需文件锁。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pythonFailureStageLabel,
  type PythonEnvironmentInfo,
  type PythonEnvironmentSpec,
  type PythonFailureStage,
  type PreparePythonEnvironmentResult,
} from "../../shared/python-runtime";
import {
  describePythonEnvironmentSpec,
  normalizePythonEnvironmentSpec,
  pythonEnvironmentSpecId,
} from "./python-environment-spec";
import {
  getPythonCacheDir,
  getPythonEnvironmentsDir,
  getPythonInterpretersDir,
  getPythonManifestsDir,
  getPythonStagingDir,
  getPythonToolchainDir,
} from "../paths";
import { UvToolchain, UV_PINNED_VERSION, type UvDownloadProgress, type UvExecutor } from "./UvToolchain";
import { SharedPreparation } from "./SharedPreparation";

export interface PythonEnvironmentManifest {
  schemaVersion: 1;
  id: string;
  label: string;
  pythonRequest: string;
  pythonVersion: string;
  dependencies: string[];
  /** 安装清单；真正的重建锁位于 manifests/<id>/uv.lock。 */
  lockedDependencies: string[];
  environmentPath: string;
  pythonPath: string;
  createdAt: number;
  ready: boolean;
}

export type PythonPreparePhase = "checking" | "downloading" | "installing" | "verifying" | "ready" | "failed";

export interface PythonEnvironmentProgress {
  environmentId: string | null;
  phase: PythonPreparePhase;
  detail: string;
  fraction: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface PythonEnvironmentStoreOptions {
  uv?: UvExecutor;
  environmentsDir?: string;
  manifestsDir?: string;
  stagingDir?: string;
  interpretersDir?: string;
  /** uv 的下载缓存与安装目录：不注入时由 UvToolchain 落到受管路径 */
  cacheDir?: string;
  toolchainDir?: string;
  platform?: NodeJS.Platform;
  onProgress?: (progress: PythonEnvironmentProgress) => void;
  /** 单条 uv 子命令超时；解释器下载较慢，默认给足 15 分钟 */
  commandTimeoutMs?: number;
}

export interface PythonEnvironmentFailure extends Error {
  stage: PythonFailureStage;
}

function failure(stage: PythonFailureStage, message: string): PythonEnvironmentFailure {
  const error = new Error(message) as PythonEnvironmentFailure;
  error.stage = stage;
  return error;
}

export function isPythonEnvironmentFailure(value: unknown): value is PythonEnvironmentFailure {
  return value instanceof Error && typeof (value as PythonEnvironmentFailure).stage === "string";
}

/** venv 内解释器相对路径：Windows 走 Scripts，POSIX 走 bin。 */
export function venvPythonRelativePath(platform: NodeJS.Platform): string {
  return platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
}

export class PythonEnvironmentStore {
  private readonly uv: UvExecutor;
  private readonly platform: NodeJS.Platform;
  private readonly onProgress: (progress: PythonEnvironmentProgress) => void;
  private readonly commandTimeoutMs: number;
  private readonly preparing = new Map<string, SharedPreparation<PreparePythonEnvironmentResult>>();
  private readonly inUse = new Map<string, number>();
  private readonly labels = new Map<string, string>();

  constructor(private readonly options: PythonEnvironmentStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 900_000;
    this.onProgress = options.onProgress ?? (() => {});
    const emitToUv = (progress: UvDownloadProgress): void => {
      this.onProgress({
        environmentId: null,
        phase: progress.phase === "verifying" ? "installing" : progress.phase,
        detail: progress.detail,
        fraction: progress.fraction,
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      });
    };
    this.uv =
      options.uv ??
      new UvToolchain({
        platform: this.platform,
        interpretersDir: this.interpretersDir,
        cacheDir: this.cacheDir,
        stagingDir: this.stagingDir,
        toolchainDir: this.toolchainDir,
        onProgress: emitToUv,
      });
  }

  get environmentsDir(): string {
    return this.options.environmentsDir ?? getPythonEnvironmentsDir();
  }

  get manifestsDir(): string {
    return this.options.manifestsDir ?? getPythonManifestsDir();
  }

  get stagingDir(): string {
    return this.options.stagingDir ?? getPythonStagingDir();
  }

  get interpretersDir(): string {
    return this.options.interpretersDir ?? getPythonInterpretersDir();
  }

  get cacheDir(): string {
    return this.options.cacheDir ?? getPythonCacheDir();
  }

  get toolchainDir(): string {
    return this.options.toolchainDir ?? getPythonToolchainDir();
  }

  /**
   * 复用同一个 uv 实例：下载进度的翻译只在本类构造函数里接线，
   * 门面另建实例会丢掉「下载中」的字节进度。
   */
  get uvExecutor(): UvExecutor {
    return this.uv;
  }

  environmentPath(id: string): string {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid Python environment id");
    return join(this.environmentsDir, id);
  }

  manifestPath(id: string): string {
    return join(this.manifestsDir, `${id}.json`);
  }

  pythonPathOf(id: string): string {
    return join(this.environmentPath(id), venvPythonRelativePath(this.platform));
  }

  /** 执行租约：占用期间不能回收，结束后调用幂等 release。 */
  acquire(id: string): () => void {
    if (!this.isReady(id)) throw new Error("Python environment is not ready");
    this.inUse.set(id, (this.inUse.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.inUse.get(id) ?? 1) - 1;
      if (count > 0) this.inUse.set(id, count); else this.inUse.delete(id);
    };
  }

  readManifest(id: string): PythonEnvironmentManifest | null {
    const path = this.manifestPath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PythonEnvironmentManifest;
      if (parsed.schemaVersion !== 1 || parsed.id !== id || !parsed.ready) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 就绪判定：清单存在 + 环境目录存在 + 解释器文件存在。 */
  isReady(id: string): boolean {
    const manifest = this.readManifest(id);
    if (!manifest) return false;
    return existsSync(manifest.environmentPath) && existsSync(manifest.pythonPath);
  }

  list(): PythonEnvironmentInfo[] {
    const ids = new Set<string>();
    for (const id of this.inUse.keys()) ids.add(id);
    for (const id of this.labels.keys()) ids.add(id);
    try {
      for (const entry of readdirSync(this.manifestsDir)) {
        if (entry.toLowerCase().endsWith(".json")) ids.add(entry.slice(0, -".json".length));
      }
    } catch {
      /* manifests 目录尚未创建 */
    }
    try {
      for (const entry of readdirSync(this.environmentsDir)) ids.add(entry);
    } catch {
      /* environments 目录尚未创建 */
    }

    const result: PythonEnvironmentInfo[] = [];
    for (const id of [...ids].sort()) {
      if (!/^[a-f0-9]{16}$/.test(id)) continue;
      const manifest = this.readManifest(id);
      const path = this.environmentPath(id);
      const ready = this.isReady(id);
      result.push({
        id,
        label: manifest?.label ?? this.labels.get(id) ?? id,
        pythonRequest: manifest?.pythonRequest ?? "",
        pythonVersion: manifest?.pythonVersion ?? null,
        dependencies: manifest?.dependencies ?? [],
        path,
        ready,
        inUse: this.inUse.has(id),
        createdAt: manifest?.createdAt ?? null,
      });
    }
    return result;
  }

  /**
   * 准备环境：命中已就绪则复用（created=false），否则新建。
   * 按 id 互斥，并发同规格请求共享同一次安装。
   */
  async prepare(
    spec: PythonEnvironmentSpec | undefined,
    options: { label?: string; signal?: AbortSignal } = {},
  ): Promise<PreparePythonEnvironmentResult> {
    const normalized = normalizePythonEnvironmentSpec(spec);
    const id = pythonEnvironmentSpecId(spec);
    const label = options.label?.trim() || (normalized.dependencies.length === 0 ? "base" : id);
    this.labels.set(id, label);
    const cancelled = (): PreparePythonEnvironmentResult => ({ ok: false, environmentId: id, spec: normalized, failureStage: "cancelled", detail: "环境准备已取消" });
    if (options.signal?.aborted) return cancelled();

    if (this.isReady(id)) {
      const manifest = this.readManifest(id);
      return {
        ok: true,
        environmentId: id,
        spec: normalized,
        pythonPath: manifest?.pythonPath ?? this.pythonPathOf(id),
        pythonVersion: manifest?.pythonVersion ?? normalized.python,
        environmentPath: this.environmentPath(id),
        created: false,
      };
    }

    let operation = this.preparing.get(id);
    if (operation?.stopping) {
      await operation.promise;
      return this.prepare(spec, options);
    }
    if (!operation) {
      operation = new SharedPreparation(signal => this.runCreate(id, normalized, label, signal));
      this.preparing.set(id, operation);
      const current = operation;
      const clear = () => { if (this.preparing.get(id) === current) this.preparing.delete(id); };
      void operation.promise.then(clear, clear);
    }
    try { return await operation.wait(options.signal); }
    catch (error) { if (options.signal?.aborted) return cancelled(); throw error; }
  }

  /**
   * 把创建期的异常统一收敛成结构化失败结果：
   * prepare 的返回类型承诺了 ok:false + failureStage，调用方（门面、IPC）
   * 就不该各自 try/catch 再翻译一遍。
   */
  private async runCreate(
    id: string,
    normalized: { python: string; dependencies: string[] },
    label: string,
    signal?: AbortSignal,
  ): Promise<PreparePythonEnvironmentResult> {
    try {
      return await this.create(id, normalized, label, signal);
    } catch (error) {
      const stage = isPythonEnvironmentFailure(error) ? error.stage : mapUnknownFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      const detail = `准备失败（${pythonFailureStageLabel(stage)}）：${message}`;
      this.emit(id, "failed", detail);
      return { ok: false, environmentId: id, spec: normalized, failureStage: stage, detail, error: message };
    }
  }

  private async create(
    id: string,
    normalized: { python: string; dependencies: string[] },
    label: string,
    signal?: AbortSignal,
  ): Promise<PreparePythonEnvironmentResult> {
    const specText = describePythonEnvironmentSpec(normalized);
    this.emit(id, "checking", `正在检查环境：${specText}`);

    const uvInfo = await this.uv.ensure(signal);
    if (!uvInfo.available || !uvInfo.path) {
      throw failure("uv-unavailable", "安装工具 uv 不可用，且拒绝回退系统 Python");
    }
    const uvPath = uvInfo.path;

    // 目录已存在但清单缺失/损坏 → 视为脏残留，先清掉再重建
    const finalPath = this.environmentPath(id);
    if (existsSync(finalPath)) rmSync(finalPath, { recursive: true, force: true });

    // venv is created at its permanent path. Only the ready manifest is published atomically.
    const lockDir = join(this.manifestsDir, id);
    mkdirSync(lockDir, { recursive: true });
    const resolutionPath = join(lockDir, "resolution.json");
    const lockPath = join(lockDir, "uv.lock");
    let pythonVersion: string;
    let published = false;
    const run = async (args: string[], stage: PythonFailureStage, env?: NodeJS.ProcessEnv) => {
      const result = await this.uv.exec(uvPath, args, { signal, cwd: lockDir, env, timeoutMs: this.commandTimeoutMs });
      if (result.cancelled || signal?.aborted) throw failure("cancelled", "环境准备已取消");
      if (result.code !== 0) throw failure(stage, tail(result.stderr) || "uv command failed");
      return result;
    };
    try {
      if (existsSync(resolutionPath) && existsSync(lockPath)) {
        const saved = JSON.parse(readFileSync(resolutionPath, "utf8")) as { pythonVersion: string };
        pythonVersion = saved.pythonVersion;
        if (!/^\d+\.\d+\.\d+$/.test(pythonVersion)) throw failure("verify-failed", "Invalid locked Python version");
      } else {
        this.emit(id, "installing", "正在准备并锁定 Python 解释器");
        await run(["python", "install", normalized.python], "interpreter-install-failed");
        const found = await run(["python", "find", "--managed-python", normalized.python], "interpreter-install-failed");
        const probe = await this.uv.exec(found.stdout.trim(), ["-c", "import sys;print(sys.version.split()[0])"], { signal, timeoutMs: 60_000 });
        if (probe.cancelled || signal?.aborted) throw failure("cancelled", "环境准备已取消");
        pythonVersion = probe.stdout.trim();
        if (probe.code !== 0 || !/^\d+\.\d+\.\d+$/.test(pythonVersion)) throw failure("verify-failed", "Python version probe failed");
        const toml = '[project]\nname = "mybuddy-managed-runtime"\nversion = "0.0.0"\nrequires-python = ' + JSON.stringify('==' + pythonVersion) + '\ndependencies = ' + JSON.stringify(normalized.dependencies) + '\n';
        writeFileSync(join(lockDir, "pyproject.toml"), toml, "utf8");
        await run(["lock", "--project", lockDir, "--python", pythonVersion], "dependency-install-failed");
        writeFileSync(resolutionPath + ".tmp", JSON.stringify({ pythonVersion }), "utf8");
        renameSync(resolutionPath + ".tmp", resolutionPath);
      }
      await run(["python", "install", pythonVersion], "interpreter-install-failed");
      this.emit(id, "installing", "正在按锁定结果安装依赖");
      await run(["sync", "--locked", "--no-install-project", "--project", lockDir, "--python", pythonVersion], "dependency-install-failed", { UV_PROJECT_ENVIRONMENT: finalPath });
      const finalPython = this.pythonPathOf(id);
      this.emit(id, "verifying", "正在校验环境与依赖一致性");
      await run(["pip", "check", "--python", finalPython], "verify-failed");
      const verified = await this.uv.exec(finalPython, ["-c", "import sys;print(sys.version.split()[0])"], { signal, timeoutMs: 60_000 });
      if (verified.cancelled || signal?.aborted) throw failure("cancelled", "环境准备已取消");
      if (verified.code !== 0 || verified.stdout.trim() !== pythonVersion) throw failure("verify-failed", "Installed Python differs from locked version");
      const freeze = await run(["pip", "freeze", "--python", finalPython], "verify-failed");
      const manifest: PythonEnvironmentManifest = {
        schemaVersion: 1, id, label, pythonRequest: normalized.python, pythonVersion,
        dependencies: normalized.dependencies,
        lockedDependencies: freeze.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        environmentPath: finalPath, pythonPath: finalPython, createdAt: Date.now(), ready: true,
      };
      writeFileSync(this.manifestPath(id) + ".tmp", JSON.stringify(manifest, null, 2), "utf8");
      renameSync(this.manifestPath(id) + ".tmp", this.manifestPath(id));
      published = true;
      this.emit(id, "ready", "已就绪：" + specText + "（Python " + pythonVersion + "）");
      return { ok: true, environmentId: id, spec: normalized, pythonPath: finalPython, pythonVersion, environmentPath: finalPath, created: true };
    } finally {
      if (!published && existsSync(finalPath)) {
        try { rmSync(finalPath, { recursive: true, force: true }); } catch { /* unready, safe to retry */ }
      }
    }
  }

  /**
   * 解析解释器路径。受管环境不可用时返回明确失败阶段——
   * 绝不静默换成系统 Python，这是本服务最重要的行为约束。
   */
  resolve(spec: PythonEnvironmentSpec | undefined): {
    ok: boolean;
    environmentId: string;
    pythonPath?: string;
    pythonVersion?: string;
    dependencies?: string[];
    failureStage?: PythonFailureStage;
    detail?: string;
  } {
    const normalized = normalizePythonEnvironmentSpec(spec);
    const id = pythonEnvironmentSpecId(spec);
    const manifest = this.readManifest(id);
    if (!manifest || !this.isReady(id)) {
      return {
        ok: false,
        environmentId: id,
        failureStage: "uv-unavailable",
        detail: `受管环境未就绪（${describePythonEnvironmentSpec(normalized)}）；需要先准备，不回退系统 Python`,
      };
    }
    return {
      ok: true,
      environmentId: id,
      pythonPath: manifest.pythonPath,
      pythonVersion: manifest.pythonVersion,
      dependencies: manifest.dependencies,
    };
  }

  /** 删除环境。被任务绑定使用过的环境拒绝删除，避免抽掉正在运行的解释器。 */
  remove(id: string): { ok: boolean; detail: string } {
    if (!/^[a-f0-9]{16}$/.test(id)) return { ok: false, detail: "无效环境标识" };
    if (this.inUse.has(id)) {
      return { ok: false, detail: "环境正在被任务使用，拒绝删除" };
    }
    // prepare 一开始就写 label，此时环境还没成形；删掉会把正在改名进 environments/ 的目录抽走
    if (this.preparing.has(id)) {
      return { ok: false, detail: "环境正在准备中，请稍后再回收" };
    }
    // label 先清：目录已被外部删掉时也要能把这一行从 list() 里去掉，
    // 否则会永久留下一条 ready=false、又删不掉的死记录。
    const hadLabel = this.labels.delete(id);
    if (!existsSync(this.environmentPath(id)) && !existsSync(this.manifestPath(id))) {
      return hadLabel
        ? { ok: true, detail: "已移除失效的环境记录" }
        : { ok: false, detail: "环境不存在" };
    }
    try {
      rmSync(this.environmentPath(id), { recursive: true, force: true });
      rmSync(this.manifestPath(id), { force: true });
      return { ok: true, detail: "已回收环境" };
    } catch (error) {
      return { ok: false, detail: `回收失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 回收运行时更新的遗留物：被取代的 uv 版本目录 + 下载缓存。
   *
   * uv 按版本目录安装（toolchain/uv/<version>）。应用升级把 UV_PINNED_VERSION
   * 往前挪之后，locateSync 只会去看新的那个目录，旧副本再也不会被命中，
   * 却一直占着盘；cache 目录同理，存的是可重新下载的压缩包和 uv 自己的 wheel 缓存。
   *
   * 刻意不动 interpreters/：venv 靠 pyvenv.cfg 的 home 指回基础解释器，
   * 误删会让「已就绪」的环境在运行期悄悄坏掉——正是不能接受的失败模式。
   */
  reclaimDisk(): { removed: number; detail: string } {
    if (this.preparing.size > 0 || (this.uv instanceof UvToolchain && this.uv.busy)) {
      return { removed: 0, detail: "有环境正在准备中，请稍后再回收" };
    }
    let removed = 0;
    const uvRoot = join(this.toolchainDir, "uv");
    try {
      for (const entry of readdirSync(uvRoot)) {
        if (entry === UV_PINNED_VERSION) continue;
        try {
          rmSync(join(uvRoot, entry), { recursive: true, force: true });
          removed += 1;
        } catch {
          /* 单个目录被占用不阻断其余回收 */
        }
      }
    } catch {
      /* toolchain/uv 尚未创建 */
    }
    try {
      for (const entry of readdirSync(this.cacheDir)) {
        try {
          rmSync(join(this.cacheDir, entry), { recursive: true, force: true });
          removed += 1;
        } catch {
          /* 同上 */
        }
      }
    } catch {
      /* cache 目录尚未创建 */
    }
    return {
      removed,
      detail: removed > 0 ? `已回收 ${removed} 项旧版本与下载缓存` : "没有可回收的旧版本或缓存",
    };
  }

  /** 清理 staging 残留（失败安装留下的可清理目录）。 */
  cleanStaging(): { removed: number; detail: string } {
    if (this.preparing.size > 0 || (this.uv instanceof UvToolchain && this.uv.busy)) {
      return { removed: 0, detail: "有环境正在准备中，请稍后再清理" };
    }
    let removed = 0;
    try {
      for (const entry of readdirSync(this.stagingDir)) {
        const full = join(this.stagingDir, entry);
        try {
          rmSync(full, { recursive: true, force: true });
          removed += 1;
        } catch {
          /* 单个目录删不掉不阻断其余清理 */
        }
      }
    } catch {
      return { removed: 0, detail: "staging 目录不存在" };
    }
    return { removed, detail: removed > 0 ? `已清理 ${removed} 个暂存目录` : "无暂存残留" };
  }

  private emit(id: string | null, phase: PythonPreparePhase, detail: string): void {
    this.onProgress({ environmentId: id, phase, detail, fraction: null, receivedBytes: 0, totalBytes: null });
  }
}

function tail(text: string, limit = 400): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** 不带 stage 的异常（如 uv 下载/校验失败）按消息文本归类，保证 UI 始终有中文阶段可显示。 */
function mapUnknownFailure(error: unknown): PythonFailureStage {
  const message = error instanceof Error ? error.message : String(error);
  if (/取消|cancel|abort/i.test(message)) return "cancelled";
  if (/校验|checksum|sha256/i.test(message)) return "uv-checksum-mismatch";
  if (/下载|download|HTTP\s+\d/i.test(message)) return "uv-download-failed";
  return "environment-create-failed";
}
