/**
 * Artifact Render Hydration — 生产 Artifact 打开链统一加载（V3.5 hotfix）
 *
 * 背景（V35_Artifact真实打开链路_修复与检测方案.md）：
 * 真实应用链（Artifact Domain → Projection → openArtifact → ArtifactPanel → Viewer）
 * 在 render cache 未 hydration 时会把空字符串传给二进制 Viewer（PDF/DOCX/XLSX/PPTX/
 * Image），导致 JSZip "End of data reached" 类错误。根因不在 Viewer，而在打开链。
 *
 * 本模块 = 统一 hydration 入口（纯逻辑 + 可注入依赖，node 单测友好）：
 * - cache 必须与 descriptor.version 绑定；版本不一致 → 一律 stale，重新 readContent
 * - 并发 single-flight：同 artifactId 同时请求共用同一个 Promise
 * - stale 防御：in-flight 返回后再次校验 descriptor 仍存在且版本未移动，否则 discard
 * - 禁止空字符串伪内容进入 ready（readContent 空 → error，不生成 payload）
 * - 失败记录 load error；不生成空字符串伪内容
 */
import type { ArtifactDomainReadContentResponse } from "../../../shared/artifact-ipc";
import type { ArtifactDescriptor } from "../../../shared/artifact-types";
import { toRendererKind, type ArtifactRenderPayload } from "./artifactIngest";

/** Renderer-only hydration 状态（§9：不是 Artifact Domain truth） */
export type ArtifactRenderLoadState = "unloaded" | "loading" | "ready" | "error";

/** hydration 引擎依赖（store 装配；node 测试注入 fake） */
export interface RenderHydrationDeps {
  /** projection 中按 id 找 descriptor（跨任务） */
  findDescriptor(artifactId: string): ArtifactDescriptor | null;
  getCache(artifactId: string): ArtifactRenderPayload | undefined;
  setCache(artifactId: string, payload: ArtifactRenderPayload): void;
  removeCache(artifactId: string): void;
  setLoadState(artifactId: string, state: ArtifactRenderLoadState, error?: string): void;
  clearState(artifactId: string): void;
  readContent(artifactId: string): Promise<ArtifactDomainReadContentResponse | null>;
  log?(message: string): void;
}

export interface RenderHydration {
  /** 统一加载入口：descriptor → cache(version 匹配) → readContent → cache → payload */
  ensure(artifactId: string): Promise<ArtifactRenderPayload | null>;
  /** artifact:updated：cache 版本不匹配 → 移除（旧内容不得继续被认为 ready） */
  invalidate(artifactId: string, version: number): void;
  /** artifact:removed：cache / loadState / error 全清 */
  clear(artifactId: string): void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function payloadName(descriptor: ArtifactDescriptor): string {
  if (descriptor.title?.trim()) return descriptor.title;
  if (descriptor.source.type === "workspace-file") return basename(descriptor.source.entryFile);
  return descriptor.id;
}

type HydrateOutcome =
  | { ok: true; payload: ArtifactRenderPayload }
  | { ok: false; stale: boolean };

const MAX_ATTEMPTS = 3;

export function createRenderHydration(deps: RenderHydrationDeps): RenderHydration {
  const log = deps.log ?? (() => {});
  /** 并发去重（§7）：同 artifactId 同时请求 → 共用 Promise，finally 清理 */
  const inFlight = new Map<string, Promise<ArtifactRenderPayload | null>>();

  async function hydrateOnce(
    artifactId: string,
    requestedVersion: number,
  ): Promise<HydrateOutcome> {
    deps.setLoadState(artifactId, "loading");
    log(`[ArtifactRender] hydrate start id=${artifactId} version=${requestedVersion}`);
    try {
      const response = await deps.readContent(artifactId);
      // stale guard（§11/§12）：返回后重新校验，discard 不让旧结果复活 cache
      const descriptor = deps.findDescriptor(artifactId);
      if (!descriptor) {
        log(`[ArtifactRender] stale result discarded id=${artifactId} (removed)`);
        return { ok: false, stale: false };
      }
      if (descriptor.version !== requestedVersion) {
        log(
          `[ArtifactRender] stale result discarded id=${artifactId} requested=${requestedVersion} current=${descriptor.version}`,
        );
        return { ok: false, stale: true };
      }
      // 飞行期间并发 ensure 已填入同版本 → 直接用
      const cached = deps.getCache(artifactId);
      if (cached && cached.artifactVersion === descriptor.version) {
        deps.setLoadState(artifactId, "ready");
        return { ok: true, payload: cached };
      }
      const fallbackPath =
        response?.path ??
        (descriptor.source.type === "workspace-file" ? descriptor.source.entryFile : undefined) ??
        (typeof descriptor.capabilities?.diskPath === "string" ? descriptor.capabilities.diskPath : undefined);
      if (!response?.content) {
        // 空文件 / 被 ProjectLibre 占用：仍把磁盘路径写入 cache，标签栏和拖出才能用
        if (fallbackPath) {
          const emptyPayload: ArtifactRenderPayload = {
            name: payloadName(descriptor),
            kind: toRendererKind(descriptor),
            content: "",
            language: response?.language,
            path: fallbackPath,
            artifactVersion: descriptor.version,
          };
          deps.setCache(artifactId, emptyPayload);
          deps.setLoadState(artifactId, "error", "文件为空或正在被其他程序占用");
          log(`[ArtifactRender] hydrate empty-with-path id=${artifactId}`);
          return { ok: true, payload: emptyPayload };
        }
        deps.setLoadState(artifactId, "error", "内容读取失败或为空");
        log(`[ArtifactRender] hydrate failed id=${artifactId} reason=empty`);
        return { ok: false, stale: false };
      }
      const payload: ArtifactRenderPayload = {
        name: payloadName(descriptor),
        kind: toRendererKind(descriptor),
        content: response.content,
        language: response.language,
        path:
          response.path ??
          (descriptor.source.type === "workspace-file" ? descriptor.source.entryFile : undefined),
        artifactVersion: descriptor.version,
      };
      deps.setCache(artifactId, payload);
      deps.setLoadState(artifactId, "ready");
      log(`[ArtifactRender] readContent success id=${artifactId} chars=${response.content.length}`);
      return { ok: true, payload };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.setLoadState(artifactId, "error", reason);
      log(`[ArtifactRender] hydrate failed id=${artifactId} reason=${reason}`);
      return { ok: false, stale: false };
    }
  }

  function ensure(artifactId: string): Promise<ArtifactRenderPayload | null> {
    const descriptor = deps.findDescriptor(artifactId);
    if (!descriptor) return Promise.resolve(null);
    const cached = deps.getCache(artifactId);
    if (cached && cached.artifactVersion === descriptor.version) {
      deps.setLoadState(artifactId, "ready");
      return Promise.resolve(cached);
    }
    const existing = inFlight.get(artifactId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const current = deps.findDescriptor(artifactId);
          if (!current) return null; // removed
          const currentCache = deps.getCache(artifactId);
          if (currentCache && currentCache.artifactVersion === current.version) {
            deps.setLoadState(artifactId, "ready");
            return currentCache;
          }
          const outcome = await hydrateOnce(artifactId, current.version);
          if (outcome.ok) return outcome.payload;
          // stale（版本移动）→ 按当前版本重试；真失败 → 放弃
          if (!outcome.stale) return null;
          log(
            `[ArtifactRender] retry id=${artifactId} attempt=${attempt + 1} with current version=${deps
              .findDescriptor(artifactId)
              ?.version}`,
          );
        }
        deps.setLoadState(artifactId, "error", "hydration 多次重试仍失败");
        return null;
      } finally {
        inFlight.delete(artifactId);
      }
    })();
    inFlight.set(artifactId, promise);
    return promise;
  }

  function invalidate(artifactId: string, version: number): void {
    const cached = deps.getCache(artifactId);
    if (cached && cached.artifactVersion !== version) {
      log(
        `[ArtifactRender] invalidate id=${artifactId} cached=${cached.artifactVersion} current=${version}`,
      );
      deps.removeCache(artifactId);
    }
  }

  function clear(artifactId: string): void {
    deps.removeCache(artifactId);
    deps.clearState(artifactId);
  }

  return { ensure, invalidate, clear };
}
