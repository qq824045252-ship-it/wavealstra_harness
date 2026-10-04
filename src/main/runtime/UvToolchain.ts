/**
 * uv 工具链定位与受管下载。
 *
 * uv 是内部安装工具：Agent 不定位它、不拼装它的参数。本模块负责
 * 「定位 → 校验 → 缺失则下载 → 记录清单」，并向环境层暴露唯一的 exec 入口。
 *
 * 下载安全（对齐 retrieval/SemanticModelManager 的既有约定，并补上它缺的两项）：
 *  - HTTPS-only；流式落盘并上报进度（SemanticModelManager 用 arrayBuffer 整包进内存、无进度）
 *  - 校验值取自官方 release 的 .sha256 sidecar，解析结果写入本地清单；
 *    此后每次启动按本地清单离线校验，可发现损坏或篡改
 *  - staging → 原子改名；失败只留可清理残留，绝不把半成品标成可用
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import JSZip from "jszip";
import { SharedPreparation } from "./SharedPreparation";
import {
  getPythonCacheDir,
  getPythonInterpretersDir,
  getPythonStagingDir,
  getPythonToolchainDir,
} from "../paths";

/** 钉死版本：升级是一次显式的代码变更，不做「拉最新」。 */
export const UV_PINNED_VERSION = "0.12.13";

const UV_OVERRIDE_ENV = "MYBUDDY_UV_PATH";
const RELEASE_BASE = "https://github.com/astral-sh/uv/releases/download";

export type UvSource = "managed" | "env";

export interface UvToolchainInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: UvSource | null;
}

export interface UvDownloadProgress {
  phase: "downloading" | "verifying" | "installing";
  detail: string;
  fraction: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface UvExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

export interface UvExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 环境存储真正依赖的 uv 能力面。
 * 抽成接口是为了让门禁测试能在不联网、机器上没有 Python/uv 的情况下注入假安装器——
 * UvToolchain 带私有字段，对象字面量无法满足它的结构化类型。
 */
export interface UvExecutor {
  ensure(signal?: AbortSignal): Promise<UvToolchainInfo>;
  locate(): UvToolchainInfo;
  exec(uvPath: string, args: string[], options?: UvExecOptions): Promise<UvExecResult>;
}

export interface UvInstallManifest {
  version: string;
  asset: string;
  url: string;
  sha256: string;
  executableSha256?: string;
  executable: string;
  installedAt: number;
}

export interface UvToolchainOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：覆盖四个目录，避免污染真实 ~/.mybuddy */
  toolchainDir?: string;
  cacheDir?: string;
  stagingDir?: string;
  interpretersDir?: string;
  exists?: (path: string) => boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: UvDownloadProgress) => void;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^"|"$/g, "");
  return trimmed || undefined;
}

/** 平台/架构 → 官方 asset 名。不支持的组合直接抛错，不做猜测式回退。 */
export function uvAssetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const archPart = (() => {
    switch (arch) {
      case "x64":
        return "x86_64";
      case "arm64":
        return "aarch64";
      default:
        throw new Error(`uv 受管下载不支持的架构：${arch}`);
    }
  })();
  switch (platform) {
    case "win32":
      return `uv-${archPart}-pc-windows-msvc.zip`;
    case "darwin":
      return `uv-${archPart}-apple-darwin.tar.gz`;
    case "linux":
      return `uv-${archPart}-unknown-linux-gnu.tar.gz`;
    default:
      throw new Error(`uv 受管下载不支持的平台：${platform}`);
  }
}

export function uvExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "uv.exe" : "uv";
}

/** sidecar 内容形如 "<hex>  <asset>"；只取第一个 64 位十六进制串。 */
export function parseSha256Sidecar(text: string): string | null {
  const match = text.match(/\b([a-fA-F0-9]{64})\b/);
  return match ? match[1].toLowerCase() : null;
}

/** 解析 `uv --version` 输出（形如 "uv 0.12.13"）。 */
export function parseUvVersion(stdout: string): string | null {
  const match = stdout.match(/uv\s+(\d+\.\d+\.\d+\S*)/i);
  return match ? match[1] : null;
}

function sha256FileStreaming(path: string): Promise<string> {
  return new Promise((promiseResolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => promiseResolve(hash.digest("hex").toLowerCase()));
    stream.on("error", reject);
  });
}

function sha256FileSync(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").toLowerCase();
  } catch {
    return null;
  }
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (child.exitCode != null || child.pid == null) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      /* 落到 child.kill */
    }
  }
  try {
    child.kill();
    setTimeout(() => {
      if (child.exitCode == null) child.kill("SIGKILL");
    }, 800);
  } catch {
    /* ignore */
  }
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(readFileSync(archivePath));
    const resolvedDest = resolvePath(destDir);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const normalized = name.replace(/\\/g, "/");
      // zip slip 防护：拒绝绝对路径与 .. 片段，并二次确认落在 destDir 内
      if (normalized.startsWith("/") || normalized.split("/").includes("..")) continue;
      const target = resolvePath(join(destDir, ...normalized.split("/").filter(Boolean)));
      if (target !== resolvedDest && !target.startsWith(resolvedDest + "/") && !target.startsWith(resolvedDest + "\\")) {
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await zip.files[name].async("nodebuffer"));
    }
    return;
  }
  // .tar.gz：Windows 10+ 自带 bsdtar，Linux/macOS 原生支持
  await new Promise<void>((promiseResolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], { windowsHide: true });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) promiseResolve();
      else reject(new Error(`tar 解压失败（退出码 ${code}）：${stderr.trim()}`));
    });
  });
}

function findFileRecursive(root: string, fileName: string): string | null {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isFile() && entry === fileName) return full;
      if (stats.isDirectory()) queue.push(full);
    }
  }
  return null;
}

export class UvToolchain implements UvExecutor {
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileExists: (path: string) => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onProgress: (progress: UvDownloadProgress) => void;
  private cached: UvToolchainInfo | null = null;
  private installing: SharedPreparation<UvToolchainInfo> | null = null;
  get busy(): boolean { return this.installing !== null; }

  constructor(private readonly options: UvToolchainOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.fileExists = options.exists ?? existsSync;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onProgress = options.onProgress ?? (() => {});
  }

  get toolchainDir(): string {
    return this.options.toolchainDir ?? getPythonToolchainDir();
  }

  get cacheDir(): string {
    return this.options.cacheDir ?? getPythonCacheDir();
  }

  get stagingDir(): string {
    return this.options.stagingDir ?? getPythonStagingDir();
  }

  get interpretersDir(): string {
    return this.options.interpretersDir ?? getPythonInterpretersDir();
  }

  managedExecutablePath(version = UV_PINNED_VERSION): string {
    return join(this.toolchainDir, "uv", version, uvExecutableName(this.platform));
  }

  managedManifestPath(version = UV_PINNED_VERSION): string {
    return join(this.toolchainDir, "uv", version, "manifest.json");
  }

  private readManifest(version = UV_PINNED_VERSION): UvInstallManifest | null {
    const path = this.managedManifestPath(version);
    if (!this.fileExists(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as UvInstallManifest;
      if (parsed.version !== version || !parsed.sha256 || !parsed.executable) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 同步定位（不触发下载）。顺序：显式 env 覆盖 → 受管副本（按清单离线校验）。
   * 找不到就返回 available:false，由调用方决定下载；绝不回退系统 PATH 上的 uv。
   */
  locateSync(): UvToolchainInfo {
    const override = clean(this.env[UV_OVERRIDE_ENV]);
    if (override) {
      if (!isAbsolute(override) || !this.fileExists(override)) {
        return { available: false, path: null, version: null, source: null };
      }
      return { available: true, path: override, version: null, source: "env" };
    }

    const managed = this.managedExecutablePath();
    if (!this.fileExists(managed)) return { available: false, path: null, version: null, source: null };

    // 离线校验：清单记录了安装时从官方 sidecar 解析出的 sha256。
    // 清单缺失（例如用户手工放置）时不阻断，但也不声称版本已知。
    const manifest = this.readManifest();
    if (manifest) {
      const actual = sha256FileSync(managed);
      if (!actual || actual !== manifest.executableSha256?.toLowerCase()) {
        return { available: false, path: null, version: null, source: null };
      }
      return { available: true, path: managed, version: manifest.version, source: "managed" };
    }
    return { available: false, path: null, version: null, source: null };
  }

  locate(): UvToolchainInfo {
    if (this.cached?.available) return this.cached;
    this.cached = this.locateSync();
    return this.cached;
  }

  /** 确保 uv 可用：已就绪直接返回，否则下载安装。并发调用共享同一次安装。 */
  async ensure(signal?: AbortSignal): Promise<UvToolchainInfo> {
    if (signal?.aborted) throw new Error("Preparation cancelled");
    const found = this.locate();
    if (found.available) {
      const probe = await this.exec(found.path!, ["--version"], { signal, timeoutMs: 30_000 });
      if (probe.cancelled) throw new Error("Preparation cancelled");
      if (probe.code !== 0 || parseUvVersion(probe.stdout) !== UV_PINNED_VERSION) {
        throw new Error(`uv version must be ${UV_PINNED_VERSION}`);
      }
      return { ...found, version: UV_PINNED_VERSION };
    }
    if (this.installing?.stopping) {
      try { await this.installing.promise; } catch { /* previous owner stopped */ }
      return this.ensure(signal);
    }
    if (!this.installing) {
      const operation = new SharedPreparation<UvToolchainInfo>(s => this.install(s));
      this.installing = operation;
      const clear = () => { if (this.installing === operation) this.installing = null; };
      void operation.promise.then(clear, clear);
    }
    return this.installing.wait(signal);
  }

  private async install(signal?: AbortSignal): Promise<UvToolchainInfo> {
    const version = UV_PINNED_VERSION;
    const asset = uvAssetName(this.platform, this.arch);
    const url = `${RELEASE_BASE}/${version}/${asset}`;
    const stagingRoot = join(this.stagingDir, `uv-${version}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(this.cacheDir, { recursive: true });
    try {
      this.onProgress({
        phase: "downloading",
        detail: `正在下载 uv ${version}`,
        fraction: null,
        receivedBytes: 0,
        totalBytes: null,
      });

      const archivePath = join(this.cacheDir, asset);
      const totalBytes = await this.downloadToFile(url, archivePath, signal);

      this.onProgress({
        phase: "verifying",
        detail: `正在校验 uv ${version}`,
        fraction: null,
        receivedBytes: totalBytes,
        totalBytes,
      });

      const expected = await this.fetchExpectedSha256(`${url}.sha256`, signal);
      const actual = await sha256FileStreaming(archivePath);
      if (actual !== expected) {
        throw new Error(`uv 校验失败：期望 ${expected}，实际 ${actual}`);
      }

      this.onProgress({
        phase: "installing",
        detail: `正在安装 uv ${version}`,
        fraction: null,
        receivedBytes: totalBytes,
        totalBytes,
      });

      const extractedRoot = join(stagingRoot, "extracted");
      mkdirSync(extractedRoot, { recursive: true });
      await extractArchive(archivePath, extractedRoot);

      const executableName = uvExecutableName(this.platform);
      const located = findFileRecursive(extractedRoot, executableName);
      if (!located) throw new Error(`uv 安装失败：解压结果中找不到 ${executableName}`);

      // 先在 staging 组装出最终目录形状，再整体原子改名进 toolchain/uv/<version>
      const promoted = join(stagingRoot, "final");
      mkdirSync(promoted, { recursive: true });
      const executableTarget = join(promoted, executableName);
      copyFileSync(located, executableTarget);
      if (this.platform !== "win32") {
        try {
          chmodSync(executableTarget, 0o755);
        } catch {
          /* 非 POSIX 文件系统可忽略 */
        }
      }

      const versionDir = dirname(this.managedExecutablePath(version));
      mkdirSync(dirname(versionDir), { recursive: true });
      if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
      renameSync(promoted, versionDir);

      const manifest: UvInstallManifest = {
        version,
        asset,
        url,
        sha256: actual,
        executableSha256: await sha256FileStreaming(this.managedExecutablePath(version)),
        executable: executableName,
        installedAt: Date.now(),
      };
      writeFileSync(this.managedManifestPath(version), JSON.stringify(manifest, null, 2), "utf8");

      this.cached = null;
      const info = this.locate();
      if (!info.available) throw new Error("uv 安装后仍不可用：本地清单校验未通过");
      return info;
    } finally {
      try {
        rmSync(stagingRoot, { recursive: true, force: true });
      } catch {
        /* 残留由 cleanStaging 兜底 */
      }
    }
  }

  private async fetchExpectedSha256(sidecarUrl: string, signal?: AbortSignal): Promise<string> {
    if (!/^https:/i.test(sidecarUrl)) throw new Error(`uv 校验值地址必须为 https：${sidecarUrl}`);
    const response = await this.fetchImpl(sidecarUrl, { signal });
    if (!response.ok) throw new Error(`uv 校验值下载失败：HTTP ${response.status}`);
    const parsed = parseSha256Sidecar(await response.text());
    if (!parsed) throw new Error("uv 校验值格式异常：无法从 sidecar 解析出 sha256");
    return parsed;
  }

  /** 流式下载并上报进度；返回总字节数。 */
  private async downloadToFile(url: string, dest: string, signal?: AbortSignal): Promise<number> {
    if (!/^https:/i.test(url)) throw new Error(`uv 下载地址必须为 https：${url}`);
    const response = await this.fetchImpl(url, { signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`uv 下载失败：HTTP ${response.status}`);
    const lengthHeader = response.headers.get("content-length");
    const declaredTotal = lengthHeader && Number.isFinite(Number(lengthHeader)) ? Number(lengthHeader) : null;

    mkdirSync(dirname(dest), { recursive: true });
    const partial = `${dest}.partial`;
    let receivedBytes = 0;
    let lastEmit = 0;

    await new Promise<void>((promiseResolve, reject) => {
      const writer = createWriteStream(partial);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        writer.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = (): void => fail(new Error("uv 下载已取消"));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      writer.on("error", fail);
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            receivedBytes += value.byteLength;
            if (!writer.write(Buffer.from(value))) {
              await new Promise<void>((drainResolve) => writer.once("drain", drainResolve));
            }
            const now = Date.now();
            if (now - lastEmit > 200) {
              lastEmit = now;
              this.onProgress({
                phase: "downloading",
                detail: `正在下载 uv ${UV_PINNED_VERSION}`,
                fraction: declaredTotal ? Math.min(1, receivedBytes / declaredTotal) : null,
                receivedBytes,
                totalBytes: declaredTotal,
              });
            }
          }
          writer.end(() => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            promiseResolve();
          });
        } catch (error) {
          fail(error);
        }
      };
      void pump();
    });

    if (existsSync(dest)) rmSync(dest, { force: true });
    renameSync(partial, dest);
    this.onProgress({
      phase: "downloading",
      detail: `uv ${UV_PINNED_VERSION} 下载完成`,
      fraction: 1,
      receivedBytes,
      totalBytes: declaredTotal ?? receivedBytes,
    });
    return receivedBytes;
  }

  /**
   * 唯一的 uv 调用入口：环境层经它执行 python install / venv / pip install，
   * 受管目录环境变量在此统一注入，调用方不拼装路径。
   */
  async exec(
    uvPath: string,
    args: string[],
    options: UvExecOptions = {},
  ): Promise<UvExecResult> {
    if (options.signal?.aborted) return { code: null, stdout: "", stderr: "cancelled", cancelled: true };
    const env = { ...this.env };
    for (const key of Object.keys(env)) {
      if (/^(UV_|PYTHON|VIRTUAL_ENV$|CONDA_PREFIX$)/i.test(key)) delete env[key];
    }
    mkdirSync(this.cacheDir, { recursive: true });
    const child = spawn(uvPath, args, {
      cwd: options.cwd ?? this.cacheDir,
      windowsHide: true,
      env: {
        ...env,
        // 解释器与缓存都收敛在受管目录，不落到用户 HOME 下不可控位置
        UV_PYTHON_INSTALL_DIR: this.interpretersDir,
        UV_PYTHON_BIN_DIR: join(this.toolchainDir, "python-bin"),
        UV_CACHE_DIR: this.cacheDir,
        UV_NO_PROGRESS: "1",
        UV_PYTHON_DOWNLOADS: "automatic",
        UV_MANAGED_PYTHON: "1",
        UV_NO_CONFIG: "1",
        UV_PYTHON_INSTALL_BIN: "0",
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          cancelled = true;
          killTree(child, this.platform);
        }, options.timeoutMs)
      : null;
    const onAbort = (): void => {
      cancelled = true;
      killTree(child, this.platform);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const code = await new Promise<number | null>((promiseResolve) => {
        child.once("close", (exitCode) => promiseResolve(exitCode));
        child.once("error", (error) => { stderr += error.message; promiseResolve(null); });
      });
      return { code, stdout, stderr, cancelled };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
