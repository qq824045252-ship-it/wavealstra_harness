/**
 * Python 运行时服务门面 —— 准备 / 绑定 / 执行 / 维护的唯一入口。
 *
 * 三个动作严格分离：
 *  1. resolveRequirement：把「内置能力 / Skill 声明 / 本次代码需求」翻译成依赖规格
 *  2. prepareEnvironment：复用或新建环境，全程上报阶段与进度
 *  3. resolveForExecution：交给执行器的确定解释器路径
 *
 * 执行由 PythonExecutor 原生子进程负责；执行方在开始前获取租约、结束后释放。
 *
 * 最重要的行为约束：受管环境不可用时返回明确失败阶段，绝不静默回退系统 Python。
 */
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  pythonRuntimeDetail,
  type PreparePythonEnvironmentRequest,
  type PreparePythonEnvironmentResult,
  type PythonEnvironmentSpec,
  type PythonFailureStage,
  type PythonInterpreterInfo,
  type PythonInterpreterResolution,
  type PythonProjectBinding,
  type PythonProjectBindingMutationResult,
  type PythonProjectBindingRequest,
  type PythonProjectBindingView,
  type PythonProjectInterpreterView,
  type PythonRuntimePhase,
  type PythonRuntimeProgressEvent,
  type PythonRuntimeRoots,
  type PythonRuntimeStatus,
} from "../../shared/python-runtime";
import { getPythonRuntimeDir } from "../paths";
import {
  PythonEnvironmentStore,
  type PythonEnvironmentManifest,
  type PythonEnvironmentStoreOptions,
} from "./PythonEnvironmentStore";
import { readPythonProjectSpec } from "./PythonProjectManifest";
import type { PythonProjectBindingStore } from "./PythonProjectBindingStore";
import { discoverProjectPython } from "./PythonProjectDiscovery";
import {
  describePythonEnvironmentSpec,
  splitPythonDependencies,
  normalizePythonEnvironmentSpec,
  pythonEnvironmentSpecId,
  pythonProjectBindingId,
  pythonProjectDirKey,
} from "./python-environment-spec";
import { parseUvVersion } from "./UvToolchain";

export interface PythonRuntimeServiceOptions extends PythonEnvironmentStoreOptions {
  /** 项目解释器手动覆盖解析器；未命中时继续自动发现项目内虚拟环境 */
  projectModeResolver?: (taskRoot: string) => PythonProjectBinding | null;
  /** 运行时根目录（仅用于状态展示）；其余六个目录由 store 选项决定 */
  runtimeDir?: string;
}

interface PhaseRecord {
  phase: PythonRuntimePhase;
  detail: string;
  failureStage: PythonFailureStage | null;
  error: string | null;
  environmentId: string | null;
  updatedAt: number;
}

export class PythonRuntimeService extends EventEmitter {
  readonly store: PythonEnvironmentStore;
  private readonly platform: NodeJS.Platform;
  private projectModeResolver: ((taskRoot: string) => PythonProjectBinding | null) | null;
  /** DB 就绪前为 null：此时项目绑定不可读写，执行一律走受管环境 */
  private bindingStore: PythonProjectBindingStore | null = null;
  private readonly runtimeDirOverride: string | undefined;
  private phase: PhaseRecord = {
    phase: "idle",
    detail: pythonRuntimeDetail("idle"),
    failureStage: null,
    error: null,
    environmentId: null,
    updatedAt: Date.now(),
  };

  constructor(options: PythonRuntimeServiceOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.projectModeResolver = options.projectModeResolver ?? null;
    this.runtimeDirOverride = options.runtimeDir;
    this.store = new PythonEnvironmentStore({
      ...options,
      onProgress: (progress) => {
        this.phase = {
          phase: progress.phase,
          detail: progress.detail,
          failureStage: null,
          error: null,
          environmentId: progress.environmentId,
          updatedAt: Date.now(),
        };
        const event: PythonRuntimeProgressEvent = {
          environmentId: progress.environmentId,
          phase: progress.phase,
          detail: progress.detail,
          fraction: progress.fraction,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
        };
        this.emit("progress", event);
      },
    });
  }

  /**
   * 后注入项目模式解析器。
   *
   * 本服务是模块级单例（见 pythonRuntimeInstance.ts），而绑定关系存在 SQLite 里，
   * 数据库要到 index.ts 的 app.whenReady 才创建。构造函数保持无副作用，
   * 因此这里允许 DB 就绪后再接线；未接线时 resolveForExecution 一律走受管环境。
   */
  setProjectModeResolver(resolver: ((taskRoot: string) => PythonProjectBinding | null) | null): void {
    this.projectModeResolver = resolver;
  }

  /**
   * DB 就绪后接线项目绑定：读写与执行期解析共用同一个 store，
   * 避免「UI 里看得到绑定、执行时却不生效」这种两边不一致。
   */
  setProjectBindingStore(store: PythonProjectBindingStore): void {
    this.bindingStore = store;
    this.setProjectModeResolver((taskRoot) => store.resolveForDir(taskRoot));
  }

  /* ---------------- 动作 1：解析需求 ---------------- */

  /**
   * Skill 声明 → 依赖规格。
   * 现有技能 frontmatter 没有依赖字段（SkillsService.ts:217-232 只认
   * name/description/version/disable-model-invocation），因此这里对缺失字段
   * 一律降级为基础环境，而不是猜测。字段一旦在第二期加入即可直接生效。
   */
  specFromSkillDeclaration(frontmatter: Record<string, unknown> | null | undefined): PythonEnvironmentSpec {
    if (!frontmatter) return {};
    const python = typeof frontmatter.python === "string" ? frontmatter.python.trim() : "";
    const rawDeps = frontmatter["python-dependencies"];
    const dependencies = Array.isArray(rawDeps)
      ? rawDeps.filter((item): item is string => typeof item === "string")
      : typeof rawDeps === "string"
        ? splitPythonDependencies(rawDeps)
        : [];
    const spec: PythonEnvironmentSpec = {};
    if (python) spec.python = python;
    if (dependencies.length > 0) spec.dependencies = dependencies;
    return spec;
  }

  /**
   * 内置能力（如语音）的固定环境规格。
   * profile 带能力版本：能力升级 → 环境 id 变化 → 新建环境，
   * 旧环境保持不动直到被回收，因此不会打断正在使用该能力的任务。
   */
  specForBuiltinCapability(
    capabilityId: string,
    capabilityVersion: string,
    spec: PythonEnvironmentSpec,
  ): PythonEnvironmentSpec {
    return { ...spec, profile: `capability:${capabilityId}@${capabilityVersion}` };
  }

  /**
   * 从待执行代码里提取内联依赖声明。
   * 约定注释形式（第一行起任意位置）：
   *   # mybuddy-python: 3.12
   *   # mybuddy-deps: pandas, openpyxl>=2.1
   * 这让 Agent 无需新工具即可声明额外依赖，仍走统一受管入口。
   */
  specFromCode(code: string): PythonEnvironmentSpec {
    const spec: PythonEnvironmentSpec = {};
    const pythonMatch = code.match(/^\s*#\s*mybuddy-python:\s*(.+?)\s*$/im);
    if (pythonMatch) spec.python = pythonMatch[1].trim();
    const depsMatch = code.match(/^\s*#\s*mybuddy-deps:\s*(.+?)\s*$/im);
    if (depsMatch) {
      const dependencies = splitPythonDependencies(depsMatch[1]);
      if (dependencies.length > 0) spec.dependencies = dependencies;
    }
    return spec;
  }

  /* ---------------- 动作 2：准备环境 ---------------- */

  async prepare(
    request: PreparePythonEnvironmentRequest,
    signal?: AbortSignal,
  ): Promise<PreparePythonEnvironmentResult> {
    const spec: PythonEnvironmentSpec = {
      python: request.python,
      dependencies: request.dependencies,
      profile: request.profile,
    };
    const normalized = normalizePythonEnvironmentSpec(spec);
    const id = pythonEnvironmentSpecId(spec);
    this.setPhase("checking", describePythonEnvironmentSpec(normalized), id);
    const result = await this.store.prepare(spec, { label: request.label, signal });
    if (result.ok) {
      this.setPhase(
        "ready",
        pythonRuntimeDetail("ready", {
          spec: `${describePythonEnvironmentSpec(normalized)}（Python ${result.pythonVersion ?? normalized.python}）`,
        }),
        id,
      );
    } else {
      this.setPhase(
        "failed",
        result.detail ?? pythonRuntimeDetail("failed", { failureStage: result.failureStage ?? null, reason: result.error }),
        id,
        result.failureStage ?? null,
        result.error ?? null,
      );
    }
    return result;
  }

  /* ---------------- 动作 3：执行前解析 ---------------- */

  /**
   * 执行入口用的解析：未就绪则自动准备（首次运行会慢，进度已上报），
   * 准备失败返回明确阶段。任何情况下都不返回系统 Python。
   */
  async resolveForExecution(
    spec: PythonEnvironmentSpec | undefined,
    options: { signal?: AbortSignal; taskRoot?: string; label?: string; useProjectBinding?: boolean } = {},
  ): Promise<PythonInterpreterResolution> {
    // 项目解释器不是 taskRoot 的全局默认：只有明确执行项目脚本的调用方才可启用。
    // 临时代码、Skill 和内置能力必须保留受管环境的依赖隔离语义。
    // 手动覆盖优先；没有覆盖时自动识别项目内 .venv/venv/env；都没有才走受管环境。
    if (options.useProjectBinding && options.taskRoot) {
      const project = this.resolveProjectInterpreter(options.taskRoot);
      const binding = project?.binding ?? null;
      if (binding && !existsSync(binding.pythonPath)) {
        const kind = project?.source === "override" ? "手动覆盖" : "自动识别";
        return { ok: false, phase: "failed", failureStage: "verify-failed", detail: `项目 Python（${kind}）已失效，请修复环境或更换解释器`, error: `Missing project interpreter: ${binding.pythonPath}` };
      }
      if (binding && existsSync(binding.pythonPath)) {
        return {
          ok: true,
          environmentId: `project:${pythonProjectBindingId(binding.dirKey)}`,
          pythonPath: binding.pythonPath,
          pythonVersion: binding.pythonVersion ?? "",
          dependencies: [],
        };
      }
    }

    const normalized = normalizePythonEnvironmentSpec(spec);
    const id = pythonEnvironmentSpecId(spec);
    const ready = this.store.resolve(spec);
    if (ready.ok && ready.pythonPath) {
      return {
        ok: true,
        environmentId: id,
        pythonPath: ready.pythonPath,
        pythonVersion: ready.pythonVersion ?? normalized.python,
        dependencies: ready.dependencies ?? normalized.dependencies,
      };
    }

    const prepared = await this.prepare({ ...spec, label: options.label }, options.signal);
    if (!prepared.ok || !prepared.pythonPath) {
      return {
        ok: false,
        phase: "failed",
        failureStage: prepared.failureStage ?? "environment-create-failed",
        detail: prepared.detail ?? pythonRuntimeDetail("failed", { failureStage: prepared.failureStage ?? null }),
        error: prepared.error ?? "受管 Python 环境准备失败",
      };
    }
    return {
      ok: true,
      environmentId: prepared.environmentId,
      pythonPath: prepared.pythonPath,
      pythonVersion: prepared.pythonVersion ?? normalized.python,
      dependencies: normalized.dependencies,
    };
  }

  /** 手动覆盖优先，未覆盖时零配置发现项目目录内的虚拟环境。 */
  private resolveProjectInterpreter(taskRoot: string): { binding: PythonProjectBinding; source: "override" | "auto" } | null {
    const override = this.projectModeResolver?.(taskRoot) ?? null;
    if (override) return { binding: override, source: "override" };
    const discovered = discoverProjectPython(taskRoot, this.platform);
    return discovered ? { binding: discovered, source: "auto" } : null;
  }

  /** 当前项目 UI 快照：只回答“现在会用哪个 Python”，不把绑定表暴露成产品模型。 */
  async inspectProject(projectDir: string): Promise<PythonProjectInterpreterView> {
    const raw = (projectDir ?? "").trim();
    const resolvedDir = raw ? resolve(raw) : "";
    if (!resolvedDir || !existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
      return {
        projectDir: resolvedDir || raw,
        source: "managed",
        resolvedProjectDir: null,
        pythonPath: null,
        pythonVersion: null,
        manifestPath: null,
        available: false,
        detail: "当前项目文件夹不可用",
      };
    }

    const project = this.resolveProjectInterpreter(resolvedDir);
    if (!project) {
      return {
        projectDir: resolvedDir,
        source: "managed",
        resolvedProjectDir: null,
        pythonPath: null,
        pythonVersion: null,
        manifestPath: null,
        available: true,
        detail: "未发现项目虚拟环境；项目脚本将使用 MyBuddy 受管 Python",
      };
    }

    const binding = project.binding;
    const exists = existsSync(binding.pythonPath);
    let pythonVersion = binding.pythonVersion;
    if (exists && !pythonVersion) {
      const probe = await this.store.uvExecutor.exec(
        binding.pythonPath,
        ["-c", "import sys;print(sys.version.split()[0])"],
        { timeoutMs: 15_000 },
      );
      if (probe.code === 0 && /^\d+\.\d+/.test(probe.stdout.trim())) pythonVersion = probe.stdout.trim();
    }

    return {
      projectDir: resolvedDir,
      source: project.source,
      resolvedProjectDir: binding.projectDir,
      pythonPath: binding.pythonPath,
      pythonVersion,
      manifestPath: binding.manifestPath,
      available: exists,
      detail: project.source === "override"
        ? "当前项目使用手动指定的解释器；可随时恢复自动识别"
        : "已自动识别项目内虚拟环境",
    };
  }

  /* ---------------- 动作 4：项目解释器覆盖 ---------------- */

  /**
   * 手动覆盖项目环境：仅用于自动识别不符合预期时指定解释器。
   *
   * 落库前先真跑一次解释器。存下一个跑不起来的 python.exe，等于把失败推迟到
   * 用户看不见的执行期，也违反「不把半成品标成可用」——绑定失败就明确报错，
   * 让留在受管环境成为可见的默认，而不是静默的巧合。
   *
   * 注意：这里只记录用户的 override。没有 override 时会继续自动识别项目内虚拟环境。
   */
  async bindProject(request: PythonProjectBindingRequest): Promise<PythonProjectBindingMutationResult> {
    if (!this.bindingStore) return { ok: false, error: "项目绑定存储未装配（数据库尚未就绪）" };

    const projectDir = (request?.projectDir ?? "").trim();
    const pythonPath = (request?.pythonPath ?? "").trim();
    if (!projectDir) return { ok: false, error: "请先选择项目目录" };
    if (!pythonPath) return { ok: false, error: "请先选择项目自己的 Python 解释器" };
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      return { ok: false, error: `项目目录不存在或不是目录：${projectDir}` };
    }
    if (!existsSync(pythonPath)) {
      return { ok: false, error: `解释器不存在：${pythonPath}` };
    }

    const probe = await this.store.uvExecutor.exec(
      pythonPath,
      ["-c", "import sys;print(sys.version.split()[0])"],
      { timeoutMs: 30_000 },
    );
    const pythonVersion = probe.code === 0 ? probe.stdout.trim() : "";
    if (probe.cancelled) return { ok: false, error: "绑定已取消" };
    if (probe.code !== 0 || !/^\d+\.\d+/.test(pythonVersion)) {
      const reason =
        probe.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || "解释器没有输出版本";
      return { ok: false, error: `解释器无法执行（退出码 ${probe.code}）：${reason}` };
    }

    const resolvedDir = resolve(projectDir);
    // 记录项目自己的清单位置：诊断时能回答「这个环境是按哪份依赖声明来的」
    const manifest = readPythonProjectSpec(resolvedDir);
    const manifestName =
      manifest.source === "pyproject"
        ? "pyproject.toml"
        : manifest.source === "requirements"
          ? "requirements.txt"
          : manifest.source === "python-version"
            ? ".python-version"
            : null;
    const binding: PythonProjectBinding = {
      projectDir: resolvedDir,
      dirKey: pythonProjectDirKey(resolvedDir, this.platform),
      pythonPath: resolve(pythonPath),
      pythonVersion,
      manifestPath: manifestName ? join(resolvedDir, manifestName) : null,
      boundAt: Date.now(),
    };
    this.bindingStore.save(binding);
    return {
      ok: true,
      binding: { ...binding, bindingId: pythonProjectBindingId(binding.dirKey), available: true },
    };
  }

  /** 取消手动覆盖：该项目恢复自动识别；若没有项目虚拟环境，再回到受管环境。 */
  unbindProject(projectDir: string): { ok: boolean; detail: string } {
    if (!this.bindingStore) return { ok: false, detail: "项目绑定存储未装配（数据库尚未就绪）" };
    const removed = this.bindingStore.remove(projectDir ?? "");
    return removed
      ? { ok: true, detail: "已取消手动覆盖，该项目恢复自动识别" }
      : { ok: false, detail: "该目录没有手动覆盖" };
  }

  /** 诊断/兼容用：全部手动覆盖记录。产品 UI 不再管理这张表。 */
  listProjectBindings(): PythonProjectBindingView[] {
    return this.bindingStore?.list() ?? [];
  }

  /* ---------------- 维护 ---------------- */

  async status(): Promise<PythonRuntimeStatus> {
    const uvInfo = this.store.uvExecutor.locate();
    let uvVersion = uvInfo.version;
    if (uvInfo.available && uvInfo.path && !uvVersion) {
      const probe = await this.store.uvExecutor.exec(uvInfo.path, ["--version"], { timeoutMs: 15_000 });
      uvVersion = probe.code === 0 ? parseUvVersion(probe.stdout) : null;
    }
    return {
      phase: this.phase.phase,
      detail: this.phase.detail,
      uv: { available: uvInfo.available, path: uvInfo.path, version: uvVersion, source: uvInfo.source },
      interpreters: this.listInterpreters(),
      environments: this.store.list(),
      error: this.phase.error,
      failureStage: this.phase.failureStage,
      roots: this.roots(),
    };
  }

  /** 真正在用的目录：全部取自 store 的解析结果，状态展示与实际位置不会漂移 */
  private roots(): PythonRuntimeRoots {
    return {
      runtime: this.runtimeDirOverride ?? getPythonRuntimeDir(),
      toolchain: this.store.toolchainDir,
      interpreters: this.store.interpretersDir,
      environments: this.store.environmentsDir,
      manifests: this.store.manifestsDir,
      cache: this.store.cacheDir,
      staging: this.store.stagingDir,
    };
  }

  /** 受管解释器清单：uv 装在 interpreters/ 下，目录名形如 cpython-3.12.x-... */
  listInterpreters(): PythonInterpreterInfo[] {
    const root = this.store.interpretersDir;
    const result: PythonInterpreterInfo[] = [];
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return result;
    }
    for (const entry of entries.sort()) {
      const match = entry.match(/cpython-(\d+\.\d+\.\d+)/);
      const pythonPath = join(
        root,
        entry,
        this.platform === "win32" ? "python.exe" : join("bin", "python3"),
      );
      if (!existsSync(pythonPath)) continue;
      result.push({ version: match ? match[1] : entry, path: pythonPath });
    }
    return result;
  }

  removeEnvironment(id: string): { ok: boolean; detail: string } {
    return this.store.remove(id);
  }

  acquireExecution(environmentId: string): () => void {
    return environmentId.startsWith("project:") ? () => {} : this.store.acquire(environmentId);
  }

  get executionDir(): string { return join(this.runtimeDirOverride ?? dirname(this.store.environmentsDir), "executions"); }

  cleanStaging(): { removed: number; detail: string } {
    return this.store.cleanStaging();
  }

  /** 回收运行时更新遗留的旧 uv 副本与下载缓存（不动解释器与已就绪环境）。 */
  reclaimDisk(): { removed: number; detail: string } {
    return this.store.reclaimDisk();
  }

  /**
   * 诊断导出：路径、版本、锁定结果，便于「运行结果附带环境标识与失败阶段」。
   *
   * 带上项目绑定是必要的：执行期可能走 `project:*` 环境，只看受管环境列表
   * 无法解释「为什么这个任务没用受管解释器」。
   */
  exportDiagnostics(): Record<string, unknown> {
    const manifests: PythonEnvironmentManifest[] = [];
    for (const info of this.store.list()) {
      const manifest = this.store.readManifest(info.id);
      if (manifest) manifests.push(manifest);
    }
    return {
      exportedAt: new Date().toISOString(),
      phase: this.phase,
      uv: this.store.uvExecutor.locate(),
      interpreters: this.listInterpreters(),
      environments: this.store.list(),
      manifests,
      projectBindings: this.listProjectBindings(),
      roots: this.roots(),
    };
  }

  private setPhase(
    phase: PythonRuntimePhase,
    detail: string,
    environmentId: string | null,
    failureStage: PythonFailureStage | null = null,
    error: string | null = null,
  ): void {
    this.phase = { phase, detail, failureStage, error, environmentId, updatedAt: Date.now() };
    const event: PythonRuntimeProgressEvent = {
      environmentId,
      phase,
      detail,
      fraction: null,
      receivedBytes: 0,
      totalBytes: null,
    };
    this.emit("progress", event);
  }
}
