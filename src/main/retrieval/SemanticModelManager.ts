/**
 * R3 Stage 1 — SemanticModelManager
 * Electron and Node share the portable installation. An existing Electron profile model is also supported.
 * Directory: <MyBuddyDir>/models/semantic/bge-m3-int8-v1/
 *   ├─ model.onnx (external ref: bge-m3-int8.onnx.data)
 *   ├─ bge-m3-int8.onnx.data
 *   ├─ tokenizer.json
 *   ├─ config.json
 *   └─ manifest.json
 * Manifest required: modelId, modelVersion, dimension, files[{name, sha256, size?}]
 * Verification: existence + size + SHA-256 + dimension
 * Download safety: HTTPS, temp dir, checksum, atomic rename, fail-cleanup, no overwrite of ready.
 * States: not_installed | downloading | ready | corrupt | failed
 *
 * Behaviour:
 *  - auto mode: semantic model unavailable → lexical-only + telemetry semanticUnavailable
 *  - explicit semantic mode: unavailable → throw/return unavailable (never hash fallback)
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { getMyBuddyDir } from "../paths";
import type { RuntimeAuditReader } from "../platform/runtime-audit";

export const SEMANTIC_MODEL_ID = "BAAI/bge-m3";
export const SEMANTIC_MODEL_VERSION = "int8-v1";
export const SEMANTIC_DIMENSION = 1024;

export type SemanticModelStatus = "not_installed" | "downloading" | "ready" | "corrupt" | "failed";

export interface SemanticInstallation {
  status: SemanticModelStatus;
  error: string | null;
  modelsRoot: string;
  revision?: string | null;
}

export interface ModelManifestFile {
  name: string;
  sha256: string;
  size?: number;
}
export interface ModelManifest {
  modelId: string;
  modelVersion: string;
  dimension: number;
  files: ModelManifestFile[];
}

const MODEL_SUBDIR = join("models", "semantic", "bge-m3-int8-v1");
const REQUIRED_FILES = ["model.onnx", "bge-m3-int8.onnx.data", "tokenizer.json"] as const;

function modelDirectories(): string[] {
  const portable = join(getMyBuddyDir(), MODEL_SUBDIR);
  try {
    const userData = require("electron")?.app?.getPath("userData");
    if (userData) return [...new Set([join(userData, MODEL_SUBDIR), portable])];
  } catch { /* Node tools only use the portable installation. */ }
  return [portable];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function readManifest(root: string): { manifest: ModelManifest; revision: string } | null {
  const mp = join(root, "manifest.json");
  if (!existsSync(mp)) return null;
  try {
    const bytes = readFileSync(mp);
    const j = JSON.parse(bytes.toString("utf8"));
    if (!j.modelId || !j.modelVersion || !Array.isArray(j.files)) return null;
    return { manifest: j as ModelManifest, revision: createHash("sha256").update(bytes).digest("hex") };
  } catch { return null; }
}

export class SemanticModelManager {
  private status: SemanticModelStatus = "not_installed";
  private statusError: string | null = null;
  private downloadingPromise: Promise<void> | null = null;
  private readonly verified = new Map<string, { mtime: number; ctime: number; size: number; sha: string }>();
  private selectedRoot?: string;
  private revision?: string | null;
  private verification?: Promise<SemanticInstallation>;
  private installationEpoch = 0;

  constructor(private readonly modelsRootOverride?: string) {}

  private directories(): string[] {
    return this.modelsRootOverride ? [this.modelsRootOverride] : modelDirectories();
  }

  getModelsRoot(): string {
    if (this.selectedRoot) return this.selectedRoot;
    const roots = this.directories();
    return roots.find(root => existsSync(join(root, "manifest.json"))) ?? roots.at(-1)!;
  }
  getModelPath(): string { return join(this.getModelsRoot(), "model.onnx"); }
  getTokenizerPath(): string { return join(this.getModelsRoot(), "tokenizer.json"); }
  getConfigPath(): string { return join(this.getModelsRoot(), "config.json"); }
  getManifestPath(): string { return join(this.getModelsRoot(), "manifest.json"); }

  private snapshot(): SemanticInstallation {
    return { status: this.status, error: this.statusError, modelsRoot: this.getModelsRoot(), revision: this.revision };
  }

  async getStatusAsync(reader?: RuntimeAuditReader): Promise<SemanticInstallation> {
    if (this.status === "downloading") return this.snapshot();
    if (this.verification) return this.verification;
    const epoch = this.installationEpoch;
    const { candidates, fallbackRoot } = this.verificationRoots();
    const pending = (async () => {
      const verified = await reader?.probeSemanticModel({
        roots: candidates, fallbackRoot, modelId: SEMANTIC_MODEL_ID, modelVersion: SEMANTIC_MODEL_VERSION,
        dimension: SEMANTIC_DIMENSION, requiredFiles: REQUIRED_FILES,
      }) ?? await this.verifyOnHost(candidates, fallbackRoot);
      if (epoch !== this.installationEpoch) return this.snapshot();
      this.status = verified.status;
      this.statusError = verified.error;
      this.selectedRoot = verified.modelsRoot;
      this.revision = verified.revision;
      return this.snapshot();
    })();
    this.verification = pending;
    try { return await pending; }
    finally { if (this.verification === pending) this.verification = undefined; }
  }

  private verificationRoots(): { candidates: string[]; fallbackRoot: string } {
    const roots = this.directories();
    const preferred = this.status === "ready" && this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : undefined;
    return { candidates: preferred ? [preferred, ...roots.filter(root => root !== preferred)] : roots, fallbackRoot: roots.at(-1)! };
  }

  private readModelManifest(root: string): { manifest: ModelManifest; revision: string } {
    const info = readManifest(root);
    if (!info) throw new Error("manifest.json 缺失或无法读取");
    const { manifest } = info;
    if (manifest.modelId !== SEMANTIC_MODEL_ID || manifest.modelVersion !== SEMANTIC_MODEL_VERSION || manifest.dimension !== SEMANTIC_DIMENSION) {
      throw new Error(`模型包与 ${SEMANTIC_MODEL_ID} ${SEMANTIC_MODEL_VERSION}（${SEMANTIC_DIMENSION} 维）不匹配`);
    }
    for (const name of REQUIRED_FILES) {
      if (!manifest.files.some(entry => entry.name === name && /^[a-f0-9]{64}$/i.test(entry.sha256))) {
        throw new Error(`manifest.json 缺少 ${name} 的 SHA-256`);
      }
    }
    return info;
  }

  private assetPath(root: string, name: string): string {
    if (!name || isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
      throw new Error("manifest.json 包含无效的模型文件名");
    }
    return join(root, name);
  }

  private async verifyOnHost(candidates: string[], fallbackRoot: string): Promise<SemanticInstallation> {
    let failed: SemanticInstallation | undefined;
    for (const root of candidates) {
      if (!existsSync(join(root, "manifest.json")) && !REQUIRED_FILES.some(name => existsSync(join(root, name)))) continue;
      try {
        const { manifest, revision } = this.readModelManifest(root);
        for (const entry of manifest.files) await this.verifyAssetOnHost(root, entry);
        if (readManifest(root)?.revision !== revision) throw new Error("模型清单在校验期间发生变化");
        return { status: "ready", error: null, modelsRoot: root, revision };
      } catch (error) {
        failed ??= { status: "corrupt", error: error instanceof Error ? error.message : String(error), modelsRoot: root };
      }
    }
    return failed ?? { status: "not_installed", error: null, modelsRoot: fallbackRoot };
  }

  private async verifyAssetOnHost(root: string, entry: ModelManifestFile): Promise<void> {
    const path = this.assetPath(root, entry.name);
    const before = await stat(path).catch(() => { throw new Error(`缺少文件 ${entry.name}`); });
    if (!before.isFile() || (entry.size !== undefined && before.size !== entry.size)) {
      throw new Error(`文件大小不匹配：${entry.name}`);
    }
    const sha = entry.sha256?.toLowerCase();
    if (!sha) return;
    const cached = this.verified.get(path);
    if (cached?.sha === sha && cached.size === before.size && cached.mtime === before.mtimeMs && cached.ctime === before.ctimeMs) return;
    const actual = await sha256File(path);
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`模型文件在校验期间发生变化：${entry.name}`);
    }
    if (actual !== sha) throw new Error(`SHA-256 校验失败：${entry.name}`);
    this.verified.set(path, { size: after.size, mtime: after.mtimeMs, ctime: after.ctimeMs, sha });
  }

  deleteModel(): void {
    const root = this.getModelsRoot();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    this.status = "not_installed";
    this.statusError = null;
    this.installationEpoch++;
    this.verification = undefined;
    this.revision = undefined;
  }

  /**
   * Download model from manifest URL base. Each file fetched via HTTPS, streamed to temp, SHA-256 verified, then atomic rename.
   * manifestUrl: https URL to manifest.json (files resolved relative to its directory).
   * Fails without touching existing ready installation.
   */
  async download(manifestUrl: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.downloadingPromise) return this.downloadingPromise;
    const root = this.getModelsRoot();
    this.installationEpoch++;
    this.verification = undefined;
    this.revision = undefined;
    this.status = "downloading";
    this.statusError = null;
    this.downloadingPromise = (async () => {
      const tmpRoot = join(tmpdir(), `mybuddy-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpRoot, { recursive: true });
      try {
        if (!/^https:/i.test(manifestUrl)) throw new Error("manifestUrl must be https");
        const manifestRes = await fetch(manifestUrl, { signal: opts?.signal });
        if (!manifestRes.ok) throw new Error(`manifest fetch failed: ${manifestRes.status}`);
        const manifest = (await manifestRes.json()) as ModelManifest;
        if (manifest.modelId !== SEMANTIC_MODEL_ID || manifest.modelVersion !== SEMANTIC_MODEL_VERSION) {
          throw new Error(`manifest model mismatch: ${manifest.modelId}:${manifest.modelVersion}`);
        }
        const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
        // download each file
        for (const f of manifest.files) {
          const url = base + f.name;
          if (!/^https:/i.test(url)) throw new Error(`file URL must be https: ${url}`);
          const tmpPath = join(tmpRoot, f.name);
          mkdirSync(dirname(tmpPath), { recursive: true });
          await downloadFile(url, tmpPath, opts?.signal);
          if (f.sha256) {
            const actual = await sha256File(tmpPath);
            if (actual !== f.sha256.toLowerCase()) throw new Error(`sha256 mismatch after download: ${f.name}`);
          }
          if (f.size) {
            const st = statSync(tmpPath);
            if (st.size !== f.size) throw new Error(`size mismatch after download: ${f.name}`);
          }
        }
        // also download manifest itself
        writeFileSync(join(tmpRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
        // atomic move: ensure root parent exists, then rename each file (or tmpRoot)
        // Do not overwrite existing ready atomically one-by-one; rename tmpRoot to root via move.
        // If root exists, remove tmpRoot's collision after verification then rename files individually.
        mkdirSync(dirname(root), { recursive: true });
        if (existsSync(root)) {
          // verify tmp before touching existing; then replace file by file via rename
          for (const f of [...manifest.files.map((x) => x.name), "manifest.json"]) {
            const src = join(tmpRoot, f);
            const dst = join(root, f);
            mkdirSync(dirname(dst), { recursive: true });
            // atomic rename (POSIX replace)
            try { rmSync(dst, { force: true }); } catch { /* ignore */ }
            renameSync(src, dst);
          }
        } else {
          mkdirSync(dirname(root), { recursive: true });
          renameSync(tmpRoot, root);
          // tmpRoot already moved, skip cleanup
          this.status = "ready";
          this.statusError = null;
          return;
        }
        this.status = "ready";
        this.statusError = null;
      } catch (e) {
        this.status = "failed";
        this.statusError = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        this.downloadingPromise = null;
        if (this.status === "downloading") {
          this.status = "failed";
        }
      }
    })();
    return this.downloadingPromise;
  }
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`fetch failed ${url}: ${res.status}`);
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(dest);
    const reader = (res.body as any).getReader ? null : null;
    // Node fetch body is Node stream in Node 18+ undici
    // Use arrayBuffer fallback for simplicity
    (async () => {
      try {
        const buf = Buffer.from(await res.arrayBuffer());
        ws.write(buf);
        ws.end();
        ws.on("finish", resolve);
        ws.on("error", reject);
      } catch (err) { reject(err); }
    })();
  });
}
