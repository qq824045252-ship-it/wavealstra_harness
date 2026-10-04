from pathlib import Path
root=Path(__file__).resolve().parent.parent
def r(p):return (root/p).read_text(encoding='utf-8')
def w(p,s):(root/p).write_text(s,encoding='utf-8',newline='\n')
p='src/main/memory/MemoryService.ts';s=r(p)
s=s.replace('      const memory = item.memory;\n      const reasons: string[] = [];','      const memory = item.memory;\n      if (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)\n        || (memory.validUntil !== undefined && memory.validUntil <= now))) continue;\n      const reasons: string[] = [];')
a=s.index('  /** Scope-first hybrid recall:');b=s.index('  async reindexSemantic(',a)
s=s[:a]+'''  /** A pending external computation must never retain an old task/scope authorization. */
  private recallScopeStamp(request: MemorySearchRequest): string {
    const task = request.taskId ? this.db.getTask(request.taskId) : undefined;
    return JSON.stringify({ task: request.taskId ? {
      exists: Boolean(task), projectId: task?.projectId ?? null,
      workspaceId: task?.spaceId ?? null, archived: task?.archived ?? false,
    } : null, chain: this.resolveScopeChain(request) });
  }

  /** Scope-first hybrid recall. Re-read facts and visibility after every async boundary. */
  async searchHybrid(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    const requestedLimit = Math.max(1, Math.min(100, request.limit ?? 20));
    const query = request.query?.trim() ?? "";
    const initialScopeStamp = this.recallScopeStamp(request);
    const freshLexical = (): MemorySearchHit[] => this.db.connection.open
      && this.recallScopeStamp(request) === initialScopeStamp
      ? this.search({ ...request, limit: Math.max(requestedLimit * 3, 40) }) : [];
    if (query.length < 4 || !this.semantic) return freshLexical().slice(0, requestedLimit);

    const scopes = this.resolveScopeChain(request);
    const visible = this.repository.listByScopes({ scopes,
      statuses: request.statuses?.length ? request.statuses : ["active"], kinds: request.kinds, limit: 1600 });
    const allowedHashes = new Map(visible.map(({ memory }) => [memory.id, memory.contentHash]));
    try {
      const semantic = await this.semantic.search(query, [...allowedHashes.keys()], Math.max(requestedLimit * 3, 40));
      if (!this.db.connection.open || this.recallScopeStamp(request) !== initialScopeStamp) return [];
      // Cached DTOs are not authorization: a forget, supersede, expiry, scope detach,
      // or update may have happened while the embedding runtime was busy.
      const lexical = freshLexical();
      const currentScopes = this.resolveScopeChain(request);
      const statuses = new Set(request.statuses?.length ? request.statuses : ["active"]);
      const now = Date.now();
      const fused = new Map<string, { lexicalRank?: number; lexicalReasons?: string[]; semanticRank?: number; memory: MemoryRecordDto }>();
      lexical.forEach((hit, index) => fused.set(hit.memory.id, { lexicalRank: index + 1, lexicalReasons: hit.reasons, memory: hit.memory }));
      semantic.forEach((hit, index) => {
        const memory = this.repository.get(hit.memoryId);
        if (!memory || allowedHashes.get(memory.id) !== memory.contentHash || !statuses.has(memory.status)
          || (request.kinds?.length && !request.kinds.includes(memory.kind))
          || (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
            || (memory.validUntil !== undefined && memory.validUntil <= now)))
          || !memory.scopes.some(s => currentScopes.some(c => c.scopeType === s.scopeType && (c.scopeId ?? "") === (s.scopeId ?? "")))) return;
        fused.set(hit.memoryId, { ...fused.get(hit.memoryId), semanticRank: index + 1, memory });
      });
      const RRF_K = 60;
      return [...fused.values()].map((entry): MemorySearchHit => {
        const scope = this.bestMatchedScope(entry.memory, currentScopes);
        const distance = currentScopes.find(item => item.scopeType === scope.scopeType && (item.scopeId ?? "") === (scope.scopeId ?? ""))?.distance ?? 10;
        let rrf = 0;
        const reasons: string[] = [];
        if (entry.lexicalRank !== undefined) { rrf += 1 / (RRF_K + entry.lexicalRank); reasons.push(entry.lexicalReasons?.includes("bm25") ? "bm25" : "lexical"); }
        if (entry.semanticRank !== undefined) { rrf += 1 / (RRF_K + entry.semanticRank); reasons.push("semantic"); }
        if (entry.lexicalRank !== undefined && entry.semanticRank !== undefined) reasons.push("rrf");
        const metadataBoost = Math.max(0, 7 - distance) + entry.memory.importance * 1.8 + entry.memory.confidence * 1.5 + (entry.memory.explicit ? 2 : 0);
        return { memory: entry.memory, score: rrf * 1000 + metadataBoost,
          reasons: [...reasons, `scope:${scope.scopeType}${distance ? `/${distance}` : ""}`], scopeDistance: distance };
      }).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt).slice(0, requestedLimit);
    } catch (error) {
      if (!(error instanceof SemanticUnavailableError)) console.warn("[MemoryKernel] semantic recall failed", error);
      return freshLexical().slice(0, requestedLimit);
    }
  }

'''+s[b:]
# The AgentService caller already checks this; enforce it in the service too so direct
# extraction callers cannot omit the task-boundary safety invariant.
s=s.replace('    const task = this.db.getTask(input.taskId);\n    const projectId', '    const extractionScopeStamp = this.recallScopeStamp({ taskId: input.taskId });\n    const assertExtractionScope = () => {\n      if (this.recallScopeStamp({ taskId: input.taskId }) !== extractionScopeStamp) {\n        throw new Error("Memory extraction scope changed: 任务绑定范围已改变，本次候选未写入");\n      }\n    };\n    const task = this.db.getTask(input.taskId);\n    const projectId')
s=s.replace('    const extracted = extractCandidates(responseText(response));','    assertExtractionScope();\n    const extracted = extractCandidates(responseText(response));')
s=s.replace('    for (const candidate of extracted) {\n      const scope', '    for (const candidate of extracted) {\n      if (!input.isEnabled()) break;\n      assertExtractionScope();\n      const scope')
w(p,s)
p='src/main/memory/MemorySemanticProvider.ts';s=r(p)
s=s.replace('    if (record.status === "invalid") return;', '    if (record.status !== "active") return;')
needle='    if (!conn.open) return;\n    conn.prepare(\n      `INSERT INTO memory_embeddings'
replacement='''    if (!conn.open) return;
    const current = conn.prepare("SELECT content_hash,status FROM memory_records WHERE id=?").get(record.id) as
      { content_hash: string; status: string } | undefined;
    // Late vectors must not resurrect forgotten records or overwrite a newer revision.
    // This check and upsert are synchronous, so no JS mutation can interleave them.
    if (!current || current.status !== "active" || current.content_hash !== record.contentHash) return;
    conn.prepare(
      `INSERT INTO memory_embeddings'''
assert needle in s;s=s.replace(needle,replacement)
s=s.replace('    const conn = this.db.connection;\n    const hits:', '    const conn = this.db.connection;\n    if (!conn.open) return [];\n    const hits:')
w(p,s)
print('Updated MemoryService return-boundary visibility and semantic index revision checks; no Pi loop changes.')
