/**
 * Workspace-scoped Resource Locator — R1 frozen + R2 Chunk-level extension
 * 冻结契约：
 * 1) Workspace 是 scope 权威：Current + ancestors，默认不含 sibling/child
 * 2) explicitDirectChild 仅 direct child + !effectiveArchived 时临时加入，不改继承
 * 3) Library provider 与 list/read/catalog 共用任务资料范围（项目 + 工作空间自有/继承 + 显式引用）
 * 4) Search != Injection：仅返回轻量 hit
 * 5) Source of Truth：真实 Library，索引非事实源
 * 6) R1 仅 Library FTS5 trigram + metadata，无 embedding/vector/watcher；R2 增加 chunks 但仍 lexical
 * 7) 复用 workspace-tree/resolver、LibraryService/Repository、WorkspaceLibraryBindingService，不重造
 * 8) R2：chunk 命中聚合到 Item 级 hit，hit 仅增加 location/chunkIndex/charOffset（轻量，不含全文）
 */

import type { AppDatabase } from "../db/AppDatabase";
import { LibraryService, type LibraryTaskScope } from "../library/LibraryService";
import { WorkspaceLibraryBindingService } from "./WorkspaceLibraryBindingService";
import type {
  WorkspaceResourceHit,
  WorkspaceResourceSearchRequest,
  WorkspaceResourceSearchResult,
  WorkspaceResourceSearchTelemetry,
} from "../../shared/workspace-resource-locator";
import { SemanticRouter } from "../retrieval/SemanticRouter";
import { SemanticUnavailableError } from "../retrieval/SemanticRuntime";
import { WorkspaceSemanticProvider } from "../retrieval/WorkspaceSemanticProvider";
import { fuseHits } from "./WorkspaceResourceLocator.semantic";

export class WorkspaceResourceLocator {
  private readonly semanticRouter: SemanticRouter;
  private readonly semanticProvider: WorkspaceSemanticProvider;

  constructor(
    db: AppDatabase,
    private readonly libraryService: LibraryService,
    _bindingService?: WorkspaceLibraryBindingService,
    opts?: { semanticProvider?: WorkspaceSemanticProvider; semanticRouter?: SemanticRouter },
  ) {
    this.semanticRouter = opts?.semanticRouter ?? new SemanticRouter();
    this.semanticProvider = opts?.semanticProvider ?? new WorkspaceSemanticProvider(db);
  }

  /** R3.5：异步受控语义召回入口（Lexical → Router → Semantic allowed → Fusion → aggregate by Item） */
  async searchAsync(req: WorkspaceResourceSearchRequest): Promise<WorkspaceResourceSearchResult> {
    const result = await this.searchWithSemantic(req);
    // Ownership or references can change while the semantic runtime is awaiting a model.
    // SQL was already scoped before ranking; this revalidation only revokes stale grants.
    const scope = this.resolveScope(req);
    const hits = result.hits.filter((hit) => {
      const item = this.libraryService.getItem(hit.id);
      return item && this.libraryService.isItemVisibleInScope(item, scope);
    });
    return {
      ...result,
      hits,
      scopeSpaceIds: [...scope.workspaceIds],
      semanticTelemetry: result.semanticTelemetry ? { ...result.semanticTelemetry, resultCount: hits.length } : undefined,
    };
  }

  private async searchWithSemantic(req: WorkspaceResourceSearchRequest): Promise<WorkspaceResourceSearchResult> {
    const semanticStart = Date.now();
    const syncResult = this.search(req);
    const mode = (req as any).mode ?? "auto";
    const baseTelemetry = (): WorkspaceResourceSearchTelemetry => ({
      durationMs: syncResult.durationMs,
      resultCount: syncResult.hits.length,
      provider: "library" as const,
      providerDurations: syncResult.providerDurations as any,
      scopeSize: syncResult.scopeSpaceIds.length,
      semanticTriggered: false,
      semanticTriggerReason: null,
      semanticAvailable: undefined,
      semanticModelVersion: null,
      semanticCandidateCount: 0,
      semanticAcceptedCount: 0,
      semanticDurationMs: 0,
    });
    if (mode === "lexical") {
      return { ...syncResult, semanticTelemetry: { ...baseTelemetry(), semanticTriggered: false, semanticTriggerReason: "mode=lexical" } };
    }
    // Router 判定是否 fallback (Trigger D for mode=semantic 强制)
    const decision = this.semanticRouter.shouldFallback({ lexicalHits: syncResult.hits, query: (req as any).query ?? "", mode });
    if (!decision.shouldFallback) {
      return {
        ...syncResult,
        semanticTelemetry: {
          ...baseTelemetry(),
          semanticTriggered: false,
          semanticTriggerReason: decision.reason,
          semanticAvailable: this.semanticProvider ? true : false,
          semanticModelVersion: "BAAI/bge-m3:int8-v1",
        },
      };
    }
    // Re-resolve live ownership and references before semantic recall; constrain SQL before ranking.
    const allowed = this.resolveScope(req);
    if (allowed.readableSpaceIds.size === 0 && allowed.readableCollectionIds.size === 0 && allowed.readableItemIds.size === 0) {
      return {
        ...syncResult,
        semanticTelemetry: {
          ...baseTelemetry(),
          semanticTriggered: true,
          semanticTriggerReason: decision.reason,
          semanticAvailable: true,
          semanticModelVersion: "BAAI/bge-m3:int8-v1",
          semanticCandidateCount: 0,
          semanticAcceptedCount: 0,
          semanticDurationMs: Date.now() - semanticStart,
        },
      };
    }
    // explicit semantic mode: unavailable must be surfaced
    const isExplicitSemantic = mode === "semantic";
    try {
      const semanticCandidateStart = Date.now();
      const cands = await this.semanticProvider.search({
        query: (req as any).query ?? "",
        allowedLibrarySpaceIds: [...allowed.readableSpaceIds],
        allowedLibraryCollectionIds: [...allowed.readableCollectionIds],
        allowedLibraryItemIds: [...allowed.readableItemIds],
        limit: Math.max(1, Math.min(50, Math.round((req as any).limit ?? 10))) * 2,
      });
      const candidateCount = cands.length;
      const semanticDurationMs = Date.now() - semanticCandidateStart;
      if (cands.length === 0) {
        return {
          ...syncResult,
          providerDurations: { ...syncResult.providerDurations, semantic: semanticDurationMs } as any,
          semanticTelemetry: {
            ...baseTelemetry(),
            semanticTriggered: true,
            semanticTriggerReason: decision.trigger ?? decision.reason,
            semanticAvailable: true,
            semanticModelVersion: "BAAI/bge-m3:int8-v1",
            semanticCandidateCount: 0,
            semanticAcceptedCount: 0,
            semanticDurationMs,
            resultCount: syncResult.hits.length,
          },
        };
      }
      const limit = Math.max(1, Math.min(50, Math.round((req as any).limit ?? 10)));
      const fused = fuseHits(syncResult.hits, cands, (id) => {
        const it = this.libraryService.getItem(id);
        return it ? { spaceId: (it as any).spaceId, title: (it as any).title, filename: (it as any).filename, kind: (it as any).kind, updatedAt: (it as any).updatedAt } : undefined;
      }, limit);
      const acceptedCount = fused.filter(h=>h.matchedBy==="semantic").length;
      return {
        ...syncResult,
        hits: fused,
        providerDurations: { ...syncResult.providerDurations, semantic: semanticDurationMs } as any,
        semanticTelemetry: {
          ...baseTelemetry(),
          semanticTriggered: true,
          semanticTriggerReason: decision.trigger ?? decision.reason,
          semanticAvailable: true,
          semanticModelVersion: "BAAI/bge-m3:int8-v1",
          semanticCandidateCount: candidateCount,
          semanticAcceptedCount: acceptedCount,
          semanticDurationMs,
          resultCount: fused.length,
        },
      };
    } catch (e) {
      if (e instanceof SemanticUnavailableError) {
        if (isExplicitSemantic) throw e;
        return {
          ...syncResult,
          semanticTelemetry: {
            ...baseTelemetry(),
            semanticTriggered: true,
            semanticTriggerReason: decision.reason,
            semanticAvailable: false,
            semanticModelVersion: "BAAI/bge-m3:int8-v1",
            semanticCandidateCount: 0,
            semanticAcceptedCount: 0,
            semanticDurationMs: Date.now() - semanticStart,
          },
        };
      }
      return {
        ...syncResult,
        semanticTelemetry: {
          ...baseTelemetry(),
          semanticTriggered: true,
          semanticTriggerReason: decision.reason,
          semanticAvailable: true,
          semanticModelVersion: "BAAI/bge-m3:int8-v1",
          semanticCandidateCount: 0,
          semanticAcceptedCount: 0,
          semanticDurationMs: Date.now() - semanticStart,
        },
      };
    }
  }

  private resolveScope(req: WorkspaceResourceSearchRequest): LibraryTaskScope {
    return this.libraryService.resolveTaskScope(req.taskId, null, {
      // The resolver ignores this fallback when taskId was supplied, even for an unknown task.
      workspaceFallback: req.currentSpaceId,
      additionalWorkspaceIds: req.explicitDirectChildSpaceId ? [req.explicitDirectChildSpaceId] : [],
    });
  }

  /**
   * 统一搜索入口：Workspace scope + Library provider（含 R2 chunk 聚合）
   * 输入 taskId 或 currentSpaceId + query + limit + optional explicitDirectChild
   * R3.6：支持 mode auto/lexical/semantic（sync 仅处理 lexical；semantic 需 searchAsync）
   */
  search(req: WorkspaceResourceSearchRequest): WorkspaceResourceSearchResult {
    const started = Date.now();
    const rawQuery: string = (req as any).query ?? "";
    const query: string = rawQuery.trim();
    const limit = Math.max(1, Math.min(50, Math.round(req.limit ?? 10)));

    // 空 query 按现有 Library 契约返回空（不抛）
    if (!query) {
      return {
        hits: [],
        scopeSpaceIds: [],
        durationMs: Date.now() - started,
        providerDurations: { library: 0 },
        query: rawQuery,
        normalizedQuery: query,
      };
    }

    // Task identity, ownership, inheritance, bindings and exact item references have one resolver.
    // req.projectId is intentionally ignored; only a persisted task can establish project authority.
    const scope = this.resolveScope(req);
    const scopeSpaceIds = [...scope.workspaceIds];
    const allowedLibraryIds = scope.readableSpaceIds;
    const allowedCollectionIds = scope.readableCollectionIds;
    const allowedItemIds = scope.readableItemIds;

    const providerStart = Date.now();
    let hits: WorkspaceResourceHit[] = [];

    if (allowedLibraryIds.size > 0 || allowedCollectionIds.size > 0 || allowedItemIds.size > 0) {
      // Scope is applied to SQL candidates before rank/limit, including single-item references.
      const rawHits = this.libraryService.retrieveInScope(query, scope, { limit });

      // 映射为轻量 hit：不含 full content，仅 snippet/preview
      hits = rawHits.slice(0, limit).map((h: any) => {
        const matchedBy: WorkspaceResourceHit["matchedBy"] =
          h.rank === 0 ? "title" : h.rank === 1 ? "filename" : "fts";
        // preview 为 FTS snippet（已 14 字符上下文）或空，绝不含全文 body
        const preview = (h.snippet ?? "").trim();
        return {
          resourceType: "library" as const,
          id: h.itemId,
          spaceId: h.spaceId ?? "",
          title: h.title ?? "",
          filename: "", // 将在下层补
          preview,
          matchedBy,
          score: h.rank,
          freshness: h.updatedAt ?? Date.now(),
          provider: "library" as const,
          kind: (h.kind as any) ?? "markdown",
        };
      });

      // 补 filename（轻量，不读文件）
      for (const hit of hits) {
        const item = this.libraryService.getItem(hit.id);
        if (item) {
          (hit as any).filename = item.filename;
        }
      }

      // 短 query (<3) 时 FTS 不可用（LibraryRepository 仅 q.length>=3 才查 FTS），此时 retrieve 仅返回 exact/prefix
      // 按现有 LibraryService.search 的 fallback 契约，短查询应回退扫描 body LIKE（256KB 上限）
      // R1 为保持不复制全文索引，短查询的 body 命中通过额外的 LIKE 扫描补充，但仍受 allowedLibraryIds 限域且不读全文
      if (hits.length < limit && query.length < 3) {
        const fallbackRows = this.libraryService.searchInScope(query, scope);
        for (const row of fallbackRows) {
          if (hits.length >= limit) break;
          if (hits.some((h) => h.id === row.id)) continue;
          hits.push({
            resourceType: "library",
            id: (row as any).id ?? "",
            spaceId: (row as any).spaceId ?? "",
            title: (row as any).title ?? "",
            filename: (row as any).filename ?? "",
            preview: "",
            matchedBy: "fallback" as const,
            score: 3,
            freshness: (row as any).updatedAt ?? Date.now(),
            provider: "library" as const,
            kind: (row as any).kind ?? "markdown",
          });
        }
      }

      // R2：Chunk-level 聚合 —— chunk FTS 命中补充 Item 级 hit（仅定位辅助，不改变 R1 排名/限域）
      // - 同一 Item 若已被 title/prefix/fts 命中则不重复；仅补充“长文档中段落级命中但 whole-doc 未命中”的情况
      // - chunk hit 携带 chunkIndex/charOffset/location，preview 为 chunk snippet
      // - 仍需满足 allowedLibraryIds 限域（searchChunks 内部已按 spaceIds 过滤）
      const needChunkFallback = hits.length < limit && query.length >= 3;
      if (needChunkFallback) {
        try {
          const repo: any = (this.libraryService as any).repo ?? (this.libraryService as any).repository;
          if (repo && typeof repo.searchChunks === "function") {
            const chunkRows: Array<{
              chunkId: string;
              itemId: string;
              score: number;
              snippet: string;
              charOffset: number;
              chunkIndex: number;
            }> = repo.searchChunks(query, { spaceIds: allowedLibraryIds, collectionIds: allowedCollectionIds, itemIds: allowedItemIds, limit: limit * 3 });
            // 按 itemId 去重，取每 item 最优 chunk（bm25 最小）
            const bestByItem = new Map<string, (typeof chunkRows)[number]>();
            for (const cr of chunkRows) {
              const prev = bestByItem.get(cr.itemId);
              if (!prev || cr.score < prev.score) bestByItem.set(cr.itemId, cr);
            }
            for (const cr of [...bestByItem.values()].sort((a, b) => a.score - b.score)) {
              if (hits.length >= limit) break;
              if (hits.some((h) => h.id === cr.itemId)) continue;
              const item = this.libraryService.getItem(cr.itemId);
              if (!item) continue;
              hits.push({
                resourceType: "library",
                id: cr.itemId,
                spaceId: item.spaceId ?? cr.itemId,
                title: item.title ?? "",
                filename: item.filename ?? "",
                preview: cr.snippet.trim(),
                matchedBy: "chunk" as const,
                score: 2,
                freshness: item.updatedAt ?? Date.now(),
                provider: "library" as const,
                kind: item.kind ?? "markdown",
                chunkIndex: cr.chunkIndex,
                charOffset: cr.charOffset,
                location: `chunk ${cr.chunkIndex} @ offset ${cr.charOffset}`,
              });
            }
          }
        } catch {
          // chunk 检索失败不影响主检索
        }
      }

      // R2：对已有 hit 补充 chunk location（即使已被 whole-doc 命中，也补充最优 chunk 位置用于定位）
      // 保证长文档 hit 具备可定位的 chunk_index/char_offset
      try {
        const repo: any = (this.libraryService as any).repo ?? (this.libraryService as any).repository;
        if (repo && typeof repo.searchChunks === "function" && query.length >= 3) {
          const locRows: Array<{ chunkId: string; itemId: string; score: number; chunkIndex: number; charOffset: number }> =
            repo.searchChunks(query, { spaceIds: allowedLibraryIds, collectionIds: allowedCollectionIds, itemIds: allowedItemIds, limit: limit * 2 });
          const locByItem = new Map<string, (typeof locRows)[number]>();
          for (const r of locRows) {
            const prev = locByItem.get(r.itemId);
            if (!prev || r.score < prev.score) locByItem.set(r.itemId, r);
          }
          for (const hit of hits) {
            if (hit.chunkIndex !== undefined) continue; // 已有 chunk 定位
            const loc = locByItem.get(hit.id);
            if (loc) {
              (hit as any).chunkIndex = loc.chunkIndex;
              (hit as any).charOffset = loc.charOffset;
              (hit as any).location = `chunk ${loc.chunkIndex} @ offset ${loc.charOffset}`;
            }
          }
        }
      } catch {
        // 定位补充失败不影响主结果
      }
    }

    // Determinism：按 score( rank 小优先 ) → freshness DESC → id ASC，与 LibraryRepository.retrieve 一致
    hits.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (b.freshness !== a.freshness) return b.freshness - a.freshness;
      return a.id.localeCompare(b.id);
    });

    const sliced = hits.slice(0, limit);

    const durationMs = Date.now() - started;
    const providerDurations = { library: Date.now() - providerStart } as Record<"library", number>;

    return {
      hits: sliced,
      scopeSpaceIds,
      durationMs,
      providerDurations,
      query: rawQuery,
      normalizedQuery: query,
    };
  }
}
