import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryCoreProfileDto, MemoryDismissedProjectionDto, MemoryProjectionDeleteRequest, MemoryProjectionDeleteResult, MemoryProjectionProposalDto, MemoryScenarioDto } from "../../shared/memory-kernel";

export type MemoryProjectionScope = {
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
};

export interface MemoryScenarioDraft {
  title: string;
  summary: string;
  sourceMemoryIds: string[];
}

export interface MemoryCoreProfileDraft {
  title: string;
  content: string;
  sourceScenarioIds: string[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(scope: MemoryProjectionScope): string {
  return `${scope.scopeType}:${scope.scopeId ?? ""}`;
}

function scenarioId(scope: MemoryProjectionScope, title: string): string {
  return `mscn_${hash(`${scopeKey(scope)}\n${title.trim().toLowerCase()}`).slice(0, 28)}`;
}

function profileId(scope: MemoryProjectionScope): string {
  return `mprof_${hash(scopeKey(scope)).slice(0, 28)}`;
}

function whereScope(alias: string, scope: MemoryProjectionScope): { sql: string; args: unknown[] } {
  if (scope.scopeType === "global") {
    return { sql: `${alias}.scope_type='global' AND ${alias}.scope_id IS NULL`, args: [] };
  }
  return { sql: `${alias}.scope_type=? AND ${alias}.scope_id=?`, args: [scope.scopeType, scope.scopeId ?? ""] };
}

function mapScenario(row: Record<string, unknown>): MemoryScenarioDto {
  let sourceMemoryIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.source_memory_ids_json ?? "[]"));
    if (Array.isArray(parsed)) sourceMemoryIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    sourceMemoryIds = [];
  }
  return {
    id: String(row.id),
    scopeType: row.scope_type as MemoryScenarioDto["scopeType"],
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    status: row.status as MemoryScenarioDto["status"],
    sourceMemoryIds,
    contentHash: String(row.content_hash ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function projectionSignature(items: Array<{ id: string; contentHash: string }>): string {
  return items.map((item) => `${item.id}:${item.contentHash}`).sort().join("|");
}

function proposalId(kind: "scenario" | "profile", scope: MemoryProjectionScope, title: string, body: string, sources: string): string {
  return `mprop_${hash(`${kind}\n${scopeKey(scope)}\n${title.trim().toLowerCase()}\n${body}\n${sources}`).slice(0, 28)}`;
}

function mapProposal(row: Record<string, unknown>): MemoryProjectionProposalDto {
  let sourceIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.source_ids_json ?? "[]"));
    if (Array.isArray(parsed)) sourceIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    sourceIds = [];
  }
  return {
    id: String(row.id),
    kind: row.kind as MemoryProjectionProposalDto["kind"],
    scopeType: row.scope_type as MemoryProjectionProposalDto["scopeType"],
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    sourceIds,
    targetId: String(row.target_id ?? ""),
    status: row.status as MemoryProjectionProposalDto["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapProfile(row: Record<string, unknown>): MemoryCoreProfileDto {
  let sourceScenarioIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.source_scenario_ids_json ?? "[]"));
    if (Array.isArray(parsed)) sourceScenarioIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    sourceScenarioIds = [];
  }
  return {
    id: String(row.id),
    scopeType: row.scope_type as MemoryCoreProfileDto["scopeType"],
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    status: row.status as MemoryCoreProfileDto["status"],
    sourceScenarioIds,
    contentHash: String(row.content_hash ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Durable storage for L2/L3 *derived projections* only.
 * memory_records remains the sole durable cognition truth; these rows are disposable/rebuildable views over L1.
 */
export class MemoryProjectionRepository {
  constructor(private readonly db: AppDatabase) {}
  private get conn() { return this.db.connection; }

  captureSourceVersions(kind: "scenario" | "profile", scope: MemoryProjectionScope, ids: readonly string[]): string | undefined {
    return this.sourceStamp(kind, scope, ids);
  }

  /** Bind approval to the exact active source versions and their scope. */
  private sourceStamp(kind: "scenario" | "profile", scope: MemoryProjectionScope, ids: readonly string[]): string | undefined {
    if (!ids.length) return undefined;
    const values: unknown[] = [];
    for (const id of [...new Set(ids)].sort()) {
      if (kind === "scenario") {
        const row = this.conn.prepare(
          `SELECT m.content_hash,m.updated_at,m.valid_from,m.valid_until,
             (SELECT MAX(r.revision) FROM memory_revisions r WHERE r.memory_id=m.id) revision
           FROM memory_records m WHERE m.id=? AND m.status='active'
             AND EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type=? AND s.scope_id IS ?)`,
        ).get(id, scope.scopeType, scope.scopeId ?? null) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        const now = Date.now();
        if ((typeof row.valid_from === "number" && row.valid_from > now)
          || (typeof row.valid_until === "number" && row.valid_until <= now)) return undefined;
        values.push([id, row]);
      } else {
        const row = this.conn.prepare(
          "SELECT content_hash,updated_at,source_memory_ids_json FROM memory_scenarios WHERE id=? AND status='active' AND scope_type=? AND scope_id IS ?",
        ).get(id, scope.scopeType, scope.scopeId ?? null) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        const atoms = JSON.parse(String(row.source_memory_ids_json)) as string[];
        const grounding = this.sourceStamp("scenario", scope, atoms);
        if (!grounding) return undefined;
        values.push([id, row.content_hash, row.updated_at, grounding]);
      }
    }
    return hash(JSON.stringify(values));
  }

  listScenarios(scope?: MemoryProjectionScope, status: MemoryScenarioDto["status"] | "all" = "active", limit = 300): MemoryScenarioDto[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (scope) {
      const scoped = whereScope("s", scope);
      where.push(`(${scoped.sql})`);
      args.push(...scoped.args);
    }
    if (status !== "all") {
      where.push("s.status=?");
      args.push(status);
    }
    args.push(Math.max(1, Math.min(2000, limit)));
    return (this.conn.prepare(
      `SELECT * FROM memory_scenarios s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.updated_at DESC,s.id ASC LIMIT ?`,
    ).all(...args) as Array<Record<string, unknown>>).map(mapScenario);
  }

  replaceScenarios(scope: MemoryProjectionScope, drafts: readonly MemoryScenarioDraft[], now = Date.now()): MemoryScenarioDto[] {
    const beforeActive = this.listScenarios(scope, "active", 200);
    const beforeSignature = projectionSignature(beforeActive);
    const normalized = new Map<string, { id: string; title: string; summary: string; sourceMemoryIds: string[]; contentHash: string }>();
    for (const draft of drafts) {
      const title = draft.title.trim().slice(0, 160);
      const summary = draft.summary.trim().slice(0, 2400);
      const sourceMemoryIds = [...new Set(draft.sourceMemoryIds.filter(Boolean))].slice(0, 32);
      if (!title || !summary || sourceMemoryIds.length === 0) continue;
      const id = scenarioId(scope, title);
      const contentHash = hash(`${title}\n${summary}\n${[...sourceMemoryIds].sort().join("\n")}`);
      normalized.set(id, { id, title, summary, sourceMemoryIds, contentHash });
    }

    const dismissed = this.dismissedIds("scenario");
    for (const id of dismissed) normalized.delete(id);

    let active: MemoryScenarioDto[] = [];
    this.conn.transaction(() => {
      const scoped = whereScope("memory_scenarios", scope);
      if (normalized.size === 0) {
        this.conn.prepare(`UPDATE memory_scenarios SET status='stale',updated_at=? WHERE ${scoped.sql} AND status='active'`)
          .run(now, ...scoped.args);
      } else {
        const ids = [...normalized.keys()];
        const placeholders = ids.map(() => "?").join(",");
        this.conn.prepare(
          `UPDATE memory_scenarios SET status='stale',updated_at=?
           WHERE ${scoped.sql} AND status='active' AND id NOT IN (${placeholders})`,
        ).run(now, ...scoped.args, ...ids);
      }

      const stmt = this.conn.prepare(
        `INSERT INTO memory_scenarios (
          id,scope_type,scope_id,title,summary,status,source_memory_ids_json,content_hash,created_at,updated_at
        ) VALUES (?,?,?,?,?,'active',?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          summary=excluded.summary,
          status='active',
          source_memory_ids_json=excluded.source_memory_ids_json,
          content_hash=excluded.content_hash,
          updated_at=CASE
            WHEN memory_scenarios.content_hash<>excluded.content_hash OR memory_scenarios.status<>'active' THEN excluded.updated_at
            ELSE memory_scenarios.updated_at
          END`,
      );
      for (const row of normalized.values()) {
        stmt.run(
          row.id,
          scope.scopeType,
          scope.scopeId ?? null,
          row.title,
          row.summary,
          JSON.stringify(row.sourceMemoryIds),
          row.contentHash,
          now,
          now,
        );
      }
      active = this.listScenarios(scope, "active", 200);
      if (projectionSignature(active) !== beforeSignature) {
        // L3 derives from the complete active L2 set for a scope. A newly-added
        // scenario is not referenced by the old profile, so id-only invalidation
        // would incorrectly leave that profile active until the next L3 interval.
        this.invalidateProfilesForScope(scope, now);
      }
    })();
    return active;
  }

  listCoreProfiles(scope?: MemoryProjectionScope, status: MemoryCoreProfileDto["status"] | "all" = "active", limit = 100): MemoryCoreProfileDto[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (scope) {
      const scoped = whereScope("p", scope);
      where.push(`(${scoped.sql})`);
      args.push(...scoped.args);
    }
    if (status !== "all") {
      where.push("p.status=?");
      args.push(status);
    }
    args.push(Math.max(1, Math.min(500, limit)));
    return (this.conn.prepare(
      `SELECT * FROM memory_core_profiles p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY p.updated_at DESC,p.id ASC LIMIT ?`,
    ).all(...args) as Array<Record<string, unknown>>).map(mapProfile);
  }

  invalidateByMemoryIds(memoryIds: readonly string[], now = Date.now()): { scenarios: number; profiles: number } {
    const ids = [...new Set(memoryIds.filter(Boolean))];
    if (ids.length === 0) return { scenarios: 0, profiles: 0 };
    const affectedScenarios = new Set<string>();
    for (const memoryId of ids) {
      const rows = this.conn.prepare(
        `SELECT s.id FROM memory_scenarios s
         WHERE s.status='active'
           AND EXISTS (SELECT 1 FROM json_each(s.source_memory_ids_json) j WHERE j.value=?)`,
      ).all(memoryId) as Array<{ id: string }>;
      for (const row of rows) affectedScenarios.add(row.id);
    }
    if (affectedScenarios.size === 0) return { scenarios: 0, profiles: 0 };

    const affectedProfiles = this.findProfilesByScenarioIds([...affectedScenarios]);
    this.conn.transaction(() => {
      const staleScenario = this.conn.prepare("UPDATE memory_scenarios SET status='stale',updated_at=? WHERE id=? AND status='active'");
      for (const id of affectedScenarios) staleScenario.run(now, id);
      const staleProfile = this.conn.prepare("UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE id=? AND status='active'");
      for (const id of affectedProfiles) staleProfile.run(now, id);
    })();
    return { scenarios: affectedScenarios.size, profiles: affectedProfiles.size };
  }

  /**
   * A projection represents the full L1/L2 input set for its exact scope. New
   * records and new promoted bindings therefore invalidate by scope, even when
   * their ids were not part of the previous projection source list.
   */
  invalidateScopes(
    scopes: ReadonlyArray<{ scopeType: import("../../shared/memory-kernel").MemoryScopeType; scopeId?: string }>,
    now = Date.now(),
  ): { scenarios: number; profiles: number } {
    const unique = new Map<string, MemoryProjectionScope>();
    for (const scope of scopes) {
      if (scope.scopeType !== "global" && scope.scopeType !== "workspace" && scope.scopeType !== "project") continue;
      const normalized: MemoryProjectionScope = { scopeType: scope.scopeType, scopeId: scope.scopeId };
      unique.set(`${scope.scopeType}:${scope.scopeId ?? ""}`, normalized);
    }
    let scenarios = 0;
    let profiles = 0;
    this.conn.transaction(() => {
      for (const scope of unique.values()) {
        const scenarioWhere = whereScope("memory_scenarios", scope);
        scenarios += this.conn.prepare(
          `UPDATE memory_scenarios SET status='stale',updated_at=? WHERE ${scenarioWhere.sql} AND status='active'`,
        ).run(now, ...scenarioWhere.args).changes;
        const profileWhere = whereScope("memory_core_profiles", scope);
        profiles += this.conn.prepare(
          `UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE ${profileWhere.sql} AND status='active'`,
        ).run(now, ...profileWhere.args).changes;
      }
    })();
    return { scenarios, profiles };
  }

  private invalidateProfilesByScenarioIds(scenarioIds: readonly string[], now = Date.now()): number {
    const affected = this.findProfilesByScenarioIds(scenarioIds);
    if (affected.size === 0) return 0;
    const stmt = this.conn.prepare("UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE id=? AND status='active'");
    this.conn.transaction(() => { for (const id of affected) stmt.run(now, id); })();
    return affected.size;
  }

  private invalidateProfilesForScope(scope: MemoryProjectionScope, now = Date.now()): number {
    const scoped = whereScope("memory_core_profiles", scope);
    return this.conn.prepare(
      `UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE ${scoped.sql} AND status='active'`,
    ).run(now, ...scoped.args).changes;
  }

  private findProfilesByScenarioIds(scenarioIds: readonly string[]): Set<string> {
    const affected = new Set<string>();
    for (const scenarioId of new Set(scenarioIds.filter(Boolean))) {
      const rows = this.conn.prepare(
        `SELECT p.id FROM memory_core_profiles p
         WHERE p.status='active'
           AND EXISTS (SELECT 1 FROM json_each(p.source_scenario_ids_json) j WHERE j.value=?)`,
      ).all(scenarioId) as Array<{ id: string }>;
      for (const row of rows) affected.add(row.id);
    }
    return affected;
  }

  replaceCoreProfile(scope: MemoryProjectionScope, draft?: MemoryCoreProfileDraft, now = Date.now()): MemoryCoreProfileDto | undefined {
    const scoped = whereScope("memory_core_profiles", scope);
    const title = draft?.title.trim().slice(0, 160) ?? "";
    const content = draft?.content.trim().slice(0, 4200) ?? "";
    const sourceScenarioIds = [...new Set(draft?.sourceScenarioIds.filter(Boolean) ?? [])].slice(0, 48);
    if (!title || !content || sourceScenarioIds.length === 0) {
      this.conn.prepare(`UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE ${scoped.sql} AND status='active'`)
        .run(now, ...scoped.args);
      return undefined;
    }

    const id = profileId(scope);
    if (this.dismissedIds("profile").has(id)) return undefined;
    const contentHash = hash(`${title}\n${content}\n${[...sourceScenarioIds].sort().join("\n")}`);
    this.conn.prepare(
      `INSERT INTO memory_core_profiles (
        id,scope_type,scope_id,title,content,status,source_scenario_ids_json,content_hash,created_at,updated_at
      ) VALUES (?,?,?,?,?,'active',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        content=excluded.content,
        status='active',
        source_scenario_ids_json=excluded.source_scenario_ids_json,
        content_hash=excluded.content_hash,
        updated_at=CASE
          WHEN memory_core_profiles.content_hash<>excluded.content_hash OR memory_core_profiles.status<>'active' THEN excluded.updated_at
          ELSE memory_core_profiles.updated_at
        END`,
    ).run(
      id,
      scope.scopeType,
      scope.scopeId ?? null,
      title,
      content,
      JSON.stringify(sourceScenarioIds),
      contentHash,
      now,
      now,
    );
    return this.listCoreProfiles(scope, "active", 1)[0];
  }

  private dismissedIds(kind: "scenario" | "profile"): Set<string> {
    const rows = this.conn.prepare("SELECT id FROM memory_projection_dismissals WHERE kind=?").all(kind) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Delete the projection row and record the dismissal. Regeneration keeps the
   * same content-derived id, so the ledger entry is what keeps it suppressed.
   * Dismissing a scenario also stales profiles that referenced it.
   */
  dismissProjection(id: string, kind: "scenario" | "profile", now = Date.now()): boolean {
    const table = kind === "scenario" ? "memory_scenarios" : "memory_core_profiles";
    const row = this.conn.prepare(`SELECT id, title, scope_type, scope_id FROM ${table} WHERE id=?`).get(id) as
      | { id: string; title: string; scope_type: string; scope_id: string | null }
      | undefined;
    if (!row) return false;
    this.conn.transaction(() => {
      this.conn.prepare(
        `INSERT INTO memory_projection_dismissals (id,kind,title,scope_type,scope_id,dismissed_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET dismissed_at=excluded.dismissed_at`,
      ).run(id, kind, row.title ?? "", row.scope_type, row.scope_id, now);
      this.conn.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      if (kind === "scenario") {
        const affected = this.findProfilesByScenarioIds([id]);
        const staleProfile = this.conn.prepare("UPDATE memory_core_profiles SET status='stale',updated_at=? WHERE id=? AND status='active'");
        for (const profileIdToStale of affected) staleProfile.run(now, profileIdToStale);
      }
    })();
    return true;
  }

  /** Revocation differs from ordinary grounding becoming stale during a frozen turn. */
  isRevoked(id: string, kind: "scenario" | "profile"): boolean {
    const table = kind === "scenario" ? "memory_scenarios" : "memory_core_profiles";
    const row = this.conn.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row || this.conn.prepare("SELECT 1 FROM memory_projection_dismissals WHERE id=?").get(id)) return true;
    // A frozen L3 capsule may contain only the profile ID, so follow its L2 provenance too.
    return kind === "profile" && mapProfile(row).sourceScenarioIds.some((sourceId) => this.isRevoked(sourceId, "scenario"));
  }

  deleteRecords(request: MemoryProjectionDeleteRequest, now = Date.now()): MemoryProjectionDeleteResult {
    if (!request || (request.kind !== "scenario" && request.kind !== "profile")
      || (request.all !== undefined && typeof request.all !== "boolean")
      || [request.targetIds, request.proposalIds].some((ids) => ids !== undefined
        && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())))
      || (request.all && (request.targetIds?.length || request.proposalIds?.length))) {
      throw new Error("请选择有效的场景或画像记录");
    }
    const kind = request.kind;
    const table = kind === "scenario" ? "memory_scenarios" : "memory_core_profiles";
    return this.conn.transaction(() => {
      const result: MemoryProjectionDeleteResult = { projections: 0, dismissals: 0, proposals: 0, invalidatedProfiles: 0, dependentProposals: 0 };
      const targetIds = request.all
        ? (this.conn.prepare(`SELECT id FROM ${table}
            UNION SELECT id FROM memory_projection_dismissals WHERE kind=?
            UNION SELECT target_id AS id FROM memory_projection_proposals WHERE kind=?`).all(kind, kind) as Array<{ id: string }>).map((row) => row.id)
        : [...new Set(request.targetIds ?? [])];
      // Removing a scene withdraws dependent live profiles and unusable profile proposals.
      if (kind === "scenario") {
        result.invalidatedProfiles = this.invalidateProfilesByScenarioIds(targetIds, now);
        const removeDependent = this.conn.prepare(`DELETE FROM memory_projection_proposals
          WHERE kind='profile' AND EXISTS (SELECT 1 FROM json_each(source_ids_json) j WHERE j.value=?)`);
        for (const id of targetIds) result.dependentProposals += removeDependent.run(id).changes;
      }
      if (request.all) {
        result.projections = this.conn.prepare(`DELETE FROM ${table}`).run().changes;
        result.dismissals = this.conn.prepare("DELETE FROM memory_projection_dismissals WHERE kind=?").run(kind).changes;
        result.proposals = this.conn.prepare("DELETE FROM memory_projection_proposals WHERE kind=?").run(kind).changes;
      } else {
        const removeProjection = this.conn.prepare(`DELETE FROM ${table} WHERE id=?`);
        const removeDismissal = this.conn.prepare("DELETE FROM memory_projection_dismissals WHERE id=? AND kind=?");
        const removeProposals = this.conn.prepare("DELETE FROM memory_projection_proposals WHERE target_id=? AND kind=?");
        for (const id of targetIds) {
          result.projections += removeProjection.run(id).changes;
          result.dismissals += removeDismissal.run(id, kind).changes;
          result.proposals += removeProposals.run(id, kind).changes;
        }
        const removeProposal = this.conn.prepare("DELETE FROM memory_projection_proposals WHERE id=? AND kind=?");
        for (const id of new Set(request.proposalIds ?? [])) result.proposals += removeProposal.run(id, kind).changes;
      }
      return result;
    })();
  }

  /** Allow a dismissed projection id to be regenerated by the next manual L2/L3 proposal. */
  restoreProjection(id: string): boolean {
    return this.conn.prepare("DELETE FROM memory_projection_dismissals WHERE id=?").run(id).changes > 0;
  }

  listDismissed(): MemoryDismissedProjectionDto[] {
    return (this.conn.prepare(
      "SELECT * FROM memory_projection_dismissals ORDER BY dismissed_at DESC",
    ).all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      kind: row.kind as MemoryDismissedProjectionDto["kind"],
      title: String(row.title ?? ""),
      scopeType: row.scope_type as MemoryDismissedProjectionDto["scopeType"],
      scopeId: row.scope_id ? String(row.scope_id) : undefined,
      dismissedAt: Number(row.dismissed_at),
    }));
  }

  /**
   * Manual-approval pipeline: generated drafts land as proposals, never as live
   * projections. Skips content already live, suppressed, or previously rejected.
   * Returns the number of newly created proposals.
   */
  proposeScenarios(scope: MemoryProjectionScope, drafts: readonly MemoryScenarioDraft[], now = Date.now()): number {
    const dismissed = this.dismissedIds("scenario");
    const stmt = this.conn.prepare(
      `INSERT INTO memory_projection_proposals
         (id,kind,scope_type,scope_id,title,body,source_ids_json,target_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?,?)
       ON CONFLICT(id) DO UPDATE SET
         body=excluded.body, source_ids_json=excluded.source_ids_json,
         target_id=excluded.target_id, updated_at=excluded.updated_at
       WHERE memory_projection_proposals.status='pending'`,
    );
    const live = this.conn.prepare("SELECT status, content_hash FROM memory_scenarios WHERE id=?");
    let created = 0;
    this.conn.transaction(() => {
      for (const draft of drafts) {
        const title = draft.title.trim().slice(0, 160);
        const summary = draft.summary.trim().slice(0, 2400);
        const sourceIds = [...new Set(draft.sourceMemoryIds.filter(Boolean))].slice(0, 32);
        if (!title || !summary || sourceIds.length === 0) continue;
        const sources = this.sourceStamp("scenario", scope, sourceIds);
        if (!sources) continue;
        const targetId = scenarioId(scope, title);
        if (dismissed.has(targetId)) continue;
        const contentHash = hash(`${title}\n${summary}\n${[...sourceIds].sort().join("\n")}`);
        const existing = live.get(targetId) as { status: string; content_hash: string } | undefined;
        if (existing?.status === "active" && existing.content_hash === contentHash) continue;
        const result = stmt.run(
          proposalId("scenario", scope, title, summary, sources),
          "scenario", scope.scopeType, scope.scopeId ?? null, title, summary,
          JSON.stringify(sourceIds), targetId, now, now,
        );
        if (result.changes > 0) created += 1;
      }
    })();
    return created;
  }

  proposeProfile(scope: MemoryProjectionScope, draft: MemoryCoreProfileDraft, now = Date.now()): boolean {
    const title = draft.title.trim().slice(0, 160);
    const content = draft.content.trim().slice(0, 4200);
    const sourceIds = [...new Set(draft.sourceScenarioIds.filter(Boolean))].slice(0, 48);
    if (!title || !content || sourceIds.length === 0) return false;
    const sources = this.sourceStamp("profile", scope, sourceIds);
    if (!sources) return false;
    const targetId = profileId(scope);
    if (this.dismissedIds("profile").has(targetId)) return false;
    const contentHash = hash(`${title}\n${content}\n${[...sourceIds].sort().join("\n")}`);
    const existing = this.conn.prepare("SELECT status, content_hash FROM memory_core_profiles WHERE id=?").get(targetId) as
      | { status: string; content_hash: string } | undefined;
    if (existing?.status === "active" && existing.content_hash === contentHash) return false;
    const result = this.conn.prepare(
      `INSERT INTO memory_projection_proposals
         (id,kind,scope_type,scope_id,title,body,source_ids_json,target_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?,?)
       ON CONFLICT(id) DO UPDATE SET
         body=excluded.body, source_ids_json=excluded.source_ids_json,
         target_id=excluded.target_id, updated_at=excluded.updated_at
       WHERE memory_projection_proposals.status='pending'`,
    ).run(
      proposalId("profile", scope, title, content, sources),
      "profile", scope.scopeType, scope.scopeId ?? null, title, content,
      JSON.stringify(sourceIds), targetId, now, now,
    );
    return result.changes > 0;
  }

  listProposals(status?: "pending" | "rejected", limit = 300): MemoryProjectionProposalDto[] {
    const capped = Math.max(1, Math.min(1000, limit));
    const rows = (status
      ? this.conn.prepare("SELECT * FROM memory_projection_proposals WHERE status=? ORDER BY updated_at DESC,id ASC LIMIT ?").all(status, capped)
      : this.conn.prepare("SELECT * FROM memory_projection_proposals ORDER BY updated_at DESC,id ASC LIMIT ?").all(capped)) as Array<Record<string, unknown>>;
    return rows.map(mapProposal);
  }

  private getProposal(id: string): MemoryProjectionProposalDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_projection_proposals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapProposal(row) : undefined;
  }

  /** Approve writes the live projection row, clears any matching dismissal, and consumes the proposal. */
  approveProposal(id: string, now = Date.now()): boolean {
    const proposal = this.getProposal(id);
    if (!proposal || proposal.status !== "pending" || !proposal.targetId) return false;
    const sourceIdsJson = JSON.stringify(proposal.sourceIds);
    this.conn.transaction(() => {
      const scope = { scopeType: proposal.scopeType, scopeId: proposal.scopeId };
      const sources = this.sourceStamp(proposal.kind, scope, proposal.sourceIds);
      if (!sources || proposal.id !== proposalId(proposal.kind, scope, proposal.title, proposal.body, sources)) {
        throw new Error("派生记忆提案的来源已变化或缺少版本证据，请重新生成后再批准");
      }
      if (proposal.kind === "scenario") {
        const contentHash = hash(`${proposal.title}\n${proposal.body}\n${[...proposal.sourceIds].sort().join("\n")}`);
        this.conn.prepare(
          `INSERT INTO memory_scenarios (
            id,scope_type,scope_id,title,summary,status,source_memory_ids_json,content_hash,created_at,updated_at
          ) VALUES (?,?,?,?,?,'active',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, summary=excluded.summary, status='active',
            source_memory_ids_json=excluded.source_memory_ids_json,
            content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
        ).run(proposal.targetId, proposal.scopeType, proposal.scopeId ?? null, proposal.title, proposal.body, sourceIdsJson, contentHash, now, now);
        this.invalidateProfilesForScope({ scopeType: proposal.scopeType, scopeId: proposal.scopeId }, now);
      } else {
        const contentHash = hash(`${proposal.title}\n${proposal.body}\n${[...proposal.sourceIds].sort().join("\n")}`);
        this.conn.prepare(
          `INSERT INTO memory_core_profiles (
            id,scope_type,scope_id,title,content,status,source_scenario_ids_json,content_hash,created_at,updated_at
          ) VALUES (?,?,?,?,?,'active',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, content=excluded.content, status='active',
            source_scenario_ids_json=excluded.source_scenario_ids_json,
            content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
        ).run(proposal.targetId, proposal.scopeType, proposal.scopeId ?? null, proposal.title, proposal.body, sourceIdsJson, contentHash, now, now);
      }
      this.conn.prepare("DELETE FROM memory_projection_dismissals WHERE id=?").run(proposal.targetId);
      this.conn.prepare("DELETE FROM memory_projection_proposals WHERE id=?").run(id);
    })();
    return true;
  }

  rejectProposal(id: string, now = Date.now()): boolean {
    return this.conn.prepare(
      "UPDATE memory_projection_proposals SET status='rejected',updated_at=? WHERE id=? AND status='pending'",
    ).run(now, id).changes > 0;
  }

  /** Move a rejected proposal back to pending so it can be approved or re-evaluated. */
  restoreProposal(id: string, now = Date.now()): boolean {
    return this.conn.prepare(
      "UPDATE memory_projection_proposals SET status='pending',updated_at=? WHERE id=? AND status='rejected'",
    ).run(now, id).changes > 0;
  }
}
