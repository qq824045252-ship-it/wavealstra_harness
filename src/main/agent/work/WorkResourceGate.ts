import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { z } from "zod";
import { fileResourceIdentity, resourcePathContains } from "../../platform/resource-identity";
import { resolvedPathKey } from "../../platform/paths";

export const workResourceOwnerSchema = z.object({ taskId: z.string().min(1), durableStoreKey: z.string().min(1),
  conversationId: z.string().min(1), workspaceBinding: z.string().min(1), bindingId: z.string().optional(), workId: z.string().optional(),
  childId: z.string().optional() }).strict();
export type WorkResourceOwner = z.infer<typeof workResourceOwnerSchema>;
export const workResourceSchema = z.object({ kind: z.enum(["file", "directory", "git_worktree", "git_metadata", "browser", "desktop", "host"]),
  scope: z.string().min(1), key: z.string().min(1), mode: z.enum(["read", "write"]), path: z.string().optional(), sourcePath: z.string().optional(),
  entity: z.string().nullable().optional(), expectedVersion: z.string().optional() }).strict();
export type WorkResource = z.infer<typeof workResourceSchema>;
const leaseSchema = z.object({ token: z.number(), action_id: z.string(), owner_json: z.string(), resources_json: z.string(),
  host_id: z.string(), state: z.enum(["active", "quarantined", "released"]), expires_at: z.number() });
export type ResourceLease = { token: number; actionId: string; owner: WorkResourceOwner; resources: WorkResource[]; hostId: string; expiresAt: number };
export type ResourceAdmission = { ok: true; lease: ResourceLease } | { ok: false; reason: string; conflictingTokens: number[] };

export function ensureWorkResourceTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_resource_leases (
    token INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL UNIQUE,
    owner_json TEXT NOT NULL CHECK(json_valid(owner_json)), resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
    host_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','quarantined','released')),
    expires_at INTEGER NOT NULL, admitted_at INTEGER NOT NULL, settled_at INTEGER, settlement_json TEXT);
    CREATE INDEX IF NOT EXISTS idx_resource_live ON work_resource_leases(state,expires_at);
    CREATE TABLE IF NOT EXISTS work_resource_denials (
      action_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_resource_recovery (
      token INTEGER PRIMARY KEY REFERENCES work_resource_leases(token), attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, exhausted_at INTEGER, reason TEXT, receipt_json TEXT);
    CREATE TABLE IF NOT EXISTS work_resource_waiters (
      action_id TEXT PRIMARY KEY, owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
      reason TEXT NOT NULL, updated_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_resource_fingerprints (
      owner_key TEXT NOT NULL, source_key TEXT NOT NULL, resource_key TEXT NOT NULL, path TEXT NOT NULL, entity TEXT, version TEXT NOT NULL,
      observation_seq INTEGER NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(owner_key,source_key));
    CREATE TABLE IF NOT EXISTS work_resource_observation_clock (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO work_resource_observation_clock(singleton,sequence) VALUES (1,0);
    CREATE TABLE IF NOT EXISTS work_resource_opaque_observations (
      owner_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL, tool_name TEXT NOT NULL, observed_at INTEGER NOT NULL);`);
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const changes = new EventEmitter();
changes.setMaxListeners(0);
export const resourceOwnerKey = (owner: WorkResourceOwner) => digest([owner.taskId, owner.durableStoreKey, owner.conversationId,
  owner.workspaceBinding, owner.bindingId ?? null, owner.childId ?? null]);

export function fileResource(path: string, mode: WorkResource["mode"], subtree = false): WorkResource {
  const identity = fileResourceIdentity(path);
  return { kind: subtree || identity.directory ? "directory" : "file", scope: "host-filesystem", key: identity.pathKey,
    path: identity.path, sourcePath: path, entity: identity.entity, mode, expectedVersion: identity.version };
}

export function resourcesConflict(a: WorkResource, b: WorkResource): boolean {
  if (a.mode === "read" && b.mode === "read") return false;
  // An unclassified local operation can reach any managed resource on this host.
  if (a.kind === "host" || b.kind === "host") return true;
  if (a.scope !== b.scope) return false;
  if (a.entity && b.entity && a.entity === b.entity) return true;
  if (a.key === b.key) return true;
  if (a.path && b.path) return (a.kind === "directory" || a.kind === "git_worktree") && resourcePathContains(a.path, b.path)
    || (b.kind === "directory" || b.kind === "git_worktree") && resourcePathContains(b.path, a.path);
  return false;
}

/** Persistent action admission, not a second executor. Expiry only fences and quarantines. */
export class WorkResourceGate {
  constructor(private readonly db: Database.Database, private readonly options: {
    hostId: string; isAuthority?: () => boolean; authorize?: (owner: WorkResourceOwner, resources: WorkResource[]) => string | undefined; now?: () => number;
  }) { ensureWorkResourceTables(db); }

  acquire(input: { actionId: string; owner: WorkResourceOwner; resources: WorkResource[]; leaseMs?: number }): ResourceAdmission {
    const owner = workResourceOwnerSchema.parse(input.owner);
    const resources = [...new Map(z.array(workResourceSchema).parse(input.resources).map(resource =>
      [`${resource.scope}:${resource.kind}:${resource.key}:${resource.mode}`, resource])).values()]
      .sort((a, b) => `${a.scope}:${a.key}:${a.mode}`.localeCompare(`${b.scope}:${b.key}:${b.mode}`));
    if (!input.actionId || resources.length === 0) throw new Error("资源准入必须包含稳定动作身份和非空资源集合");
    return this.db.transaction((): ResourceAdmission => {
      this.assertAuthority();
      const now = this.now();
      this.db.prepare("DELETE FROM work_resource_waiters WHERE deadline_at<=?").run(now);
      const refused = this.db.prepare("SELECT 1 FROM work_resource_denials WHERE action_id=?").get(input.actionId);
      if (refused) return { ok: false, reason: "原动作已明确拒绝且未启动，请使用新的计划动作身份", conflictingTokens: [] };
      this.db.prepare("UPDATE work_resource_leases SET state='quarantined' WHERE state='active' AND (expires_at<=? OR host_id<>?)")
        .run(now, this.options.hostId);
      const denied = this.options.authorize?.(owner, resources);
      if (denied) return { ok: false, reason: denied, conflictingTokens: [] };
      const existing = this.readAction(input.actionId);
      if (existing) {
        if (resourceOwnerKey(existing.owner) !== resourceOwnerKey(owner) || digest(existing.resources) !== digest(resources))
          return { ok: false, reason: "资源动作身份不能改绑执行或资源", conflictingTokens: [existing.token] };
        const current = this.row(existing.token);
        if (current?.state === "active" && existing.hostId === this.options.hostId && existing.expiresAt > now) return { ok: true, lease: existing };
        return { ok: false, reason: "原资源动作已结束或隔离，必须查回原效果，不能重新授予同一动作", conflictingTokens: [existing.token] };
      }
      const conflicts = this.live().filter(lease => resources.some(a => lease.resources.some(b => resourcesConflict(a, b))));
      if (conflicts.length) {
        const reason = conflicts.some(lease => this.row(lease.token)?.state === "quarantined")
          ? "共享资源已隔离，等待原执行、后端队列和输入释放回执" : "等待共享资源在途操作结算";
        const exists = this.db.prepare("SELECT 1 FROM work_resource_waiters WHERE action_id=?").get(input.actionId);
        const queueSize = z.object({ count: z.number() }).parse(this.db.prepare("SELECT count(*) count FROM work_resource_waiters WHERE json_extract(owner_json,'$.taskId')=?").get(owner.taskId)).count;
        const total = z.object({ count: z.number() }).parse(this.db.prepare("SELECT count(*) count FROM work_resource_waiters").get()).count;
        if (!exists && (queueSize >= 128 || total >= 2048)) return { ok: false, reason: "资源等待队列已满，请缩小并发或取消等待中的动作", conflictingTokens: conflicts.map(lease => lease.token) };
        this.db.prepare(`INSERT INTO work_resource_waiters(action_id,owner_json,reason,updated_at,deadline_at) VALUES (?,?,?,?,?)
          ON CONFLICT(action_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`)
          .run(input.actionId, JSON.stringify(owner), reason, now, now + 30_000);
        return { ok: false, reason, conflictingTokens: conflicts.map(lease => lease.token) };
      }
      const expiresAt = now + Math.min(60_000, Math.max(100, input.leaseMs ?? 30_000));
      const result = this.db.prepare(`INSERT INTO work_resource_leases(action_id,owner_json,resources_json,host_id,state,expires_at,admitted_at)
        VALUES (?,?,?,?,'active',?,?)`).run(input.actionId, JSON.stringify(owner), JSON.stringify(resources), this.options.hostId, expiresAt, now);
      this.db.prepare("DELETE FROM work_resource_waiters WHERE action_id=?").run(input.actionId);
      return { ok: true, lease: { token: Number(result.lastInsertRowid), actionId: input.actionId, owner, resources, hostId: this.options.hostId, expiresAt } };
    }).immediate();
  }

  validate(lease: ResourceLease): string | undefined {
    const row = this.row(lease.token);
    if (!row || row.action_id !== lease.actionId || row.host_id !== this.options.hostId || row.state !== "active" || row.expires_at <= this.now()
      || resourceOwnerKey(workResourceOwnerSchema.parse(JSON.parse(row.owner_json))) !== resourceOwnerKey(lease.owner)) return "资源 fencing 已失效，拒绝旧持有者操作";
    if (this.options.isAuthority?.() === false) return "资源宿主已失去 authority";
    return this.options.authorize?.(lease.owner, lease.resources);
  }

  validateSettlement(lease: ResourceLease): string | undefined {
    const row = this.row(lease.token);
    if (!row || row.action_id !== lease.actionId || row.host_id !== this.options.hostId || row.state === "released"
      || resourceOwnerKey(workResourceOwnerSchema.parse(JSON.parse(row.owner_json))) !== resourceOwnerKey(lease.owner)) return "输入清理身份或宿主代次不匹配";
    if (this.options.isAuthority?.() === false) return "资源宿主已失去 authority";
    return undefined;
  }

  /** Call outside SQLite transactions, immediately before the actual managed action. */
  validateVersions(lease: ResourceLease): string | undefined {
    const denied = this.validate(lease); if (denied) return denied;
    for (const resource of lease.resources) {
      if (!resource.path || !resource.expectedVersion) continue;
      const current = fileResourceIdentity(resource.sourcePath ?? resource.path);
      if (current.pathKey !== resource.key || current.entity !== resource.entity || current.version !== resource.expectedVersion)
        return `version_conflict: 原读取版本或资源别名已变化：${resource.path}`;
    }
    return this.validate(lease);
  }

  release(lease: ResourceLease, outcome: "confirmed" | "not_started" | "unknown", detail = ""): boolean {
    return this.db.transaction(() => {
      this.assertAuthority();
      const row = this.row(lease.token);
      if (!row || row.action_id !== lease.actionId || row.host_id !== this.options.hostId
        || resourceOwnerKey(workResourceOwnerSchema.parse(JSON.parse(row.owner_json))) !== resourceOwnerKey(lease.owner)) return false;
      if (row.state === "released") return true;
      // A stale action may settle its own row, but never a successor's row or generation.
      this.db.prepare("UPDATE work_resource_leases SET state=?,settled_at=?,settlement_json=? WHERE token=?")
        .run(outcome === "unknown" ? "quarantined" : "released", this.now(), JSON.stringify({ outcome, detail }), lease.token);
      changes.emit(this.db.name);
      return true;
    }).immediate();
  }

  markInputHeld(lease: ResourceLease, controls: readonly string[]): void {
    if (this.validateSettlement(lease) || this.leaseState(lease) !== "active") return;
    this.db.prepare("UPDATE work_resource_leases SET settlement_json=? WHERE token=? AND host_id=? AND state<>'released'")
      .run(JSON.stringify({ kind: "held_input", effectKnown: true, controls }), lease.token, this.options.hostId);
  }

  settleInputCleanup(taskId: string | undefined, evidence: { inputReleased: boolean; queueDrained: boolean; receipt: string }): number {
    if (!evidence.inputReleased || !evidence.queueDrained || !evidence.receipt) return 0;
    let settled = 0;
    for (const lease of this.live()) {
      if (lease.hostId !== this.options.hostId || taskId !== undefined && lease.owner.taskId !== taskId) continue;
      const marker = z.object({ settlement_json: z.string().nullable() }).parse(this.db.prepare("SELECT settlement_json FROM work_resource_leases WHERE token=?").get(lease.token));
      if (!marker.settlement_json) continue;
      const held = z.object({ kind: z.literal("held_input"), effectKnown: z.literal(true), controls: z.array(z.string()) }).safeParse(JSON.parse(marker.settlement_json));
      if (held.success && this.release(lease, "confirmed", evidence.receipt)) settled++;
    }
    return settled;
  }

  reconcileQuarantine(token: number, evidence: { executionStopped: boolean; queueDrained: boolean; inputReleased: boolean; effectKnown: boolean; receipt: string }): boolean {
    return this.db.transaction(() => {
      this.assertAuthority();
      if (!evidence.executionStopped || !evidence.queueDrained || !evidence.inputReleased || !evidence.effectKnown || !evidence.receipt) return false;
      return this.db.prepare("UPDATE work_resource_leases SET state='released',settled_at=?,settlement_json=? WHERE token=? AND state='quarantined'")
        .run(this.now(), JSON.stringify(evidence), token).changes === 1;
    }).immediate();
  }

  observe(owner: WorkResourceOwner, resource: WorkResource): void {
    this.assertAuthority();
    if (!resource.path || !resource.expectedVersion) return;
    const path = resource.path, version = resource.expectedVersion;
    this.db.transaction(() => {
      this.assertAuthority();
      const sequence = this.nextObservation();
      this.db.prepare(`INSERT INTO work_resource_fingerprints(owner_key,source_key,resource_key,path,entity,version,observation_seq,observed_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_key,source_key) DO UPDATE SET resource_key=excluded.resource_key,path=excluded.path,entity=excluded.entity,
        version=excluded.version,observation_seq=excluded.observation_seq,observed_at=excluded.observed_at`)
        .run(resourceOwnerKey(owner), resolvedPathKey(resource.sourcePath ?? path), resource.key, resource.sourcePath ?? path, resource.entity ?? null, version, sequence, this.now());
    }).immediate();
  }
  noteOpaqueObservation(owner: WorkResourceOwner, toolName: string): void {
    this.db.transaction(() => {
      this.assertAuthority();
      this.db.prepare(`INSERT INTO work_resource_opaque_observations(owner_key,sequence,tool_name,observed_at) VALUES (?,?,?,?)
        ON CONFLICT(owner_key) DO UPDATE SET sequence=excluded.sequence,tool_name=excluded.tool_name,observed_at=excluded.observed_at`)
        .run(resourceOwnerKey(owner), this.nextObservation(), toolName, this.now());
    }).immediate();
  }
  opaqueObservation(owner: WorkResourceOwner): { sequence: number; tool_name: string } | undefined {
    return z.object({ sequence: z.number(), tool_name: z.string() }).optional()
      .parse(this.db.prepare("SELECT sequence,tool_name FROM work_resource_opaque_observations WHERE owner_key=?").get(resourceOwnerKey(owner)));
  }
  observedAfter(owner: WorkResourceOwner, resource: WorkResource, sequence: number): boolean {
    const source = resolvedPathKey(resource.sourcePath ?? resource.path ?? resource.key);
    return Boolean(this.db.prepare(`SELECT 1 FROM work_resource_fingerprints WHERE owner_key=? AND source_key=? AND observation_seq>?`)
      .get(resourceOwnerKey(owner), source, sequence));
  }
  observed(owner: WorkResourceOwner, resource: WorkResource): string | undefined {
    const source = resolvedPathKey(resource.sourcePath ?? resource.path ?? resource.key);
    return z.object({ version: z.string() }).optional().parse(this.db.prepare(`SELECT version FROM work_resource_fingerprints WHERE owner_key=?
      AND (source_key=? OR resource_key=? OR (entity IS NOT NULL AND entity=?)) ORDER BY CASE WHEN source_key=? THEN 0 ELSE 1 END,observed_at DESC LIMIT 1`)
      .get(resourceOwnerKey(owner), source, resource.key, resource.entity ?? null, source))?.version;
  }
  observedResources(owner: WorkResourceOwner): Array<{ path: string; version: string }> {
    return this.db.prepare("SELECT path,version FROM work_resource_fingerprints WHERE owner_key=?").all(resourceOwnerKey(owner))
      .map(row => z.object({ path: z.string(), version: z.string() }).parse(row));
  }
  live(): ResourceLease[] { return this.db.prepare("SELECT * FROM work_resource_leases WHERE state<>'released'").all().map(row => this.dto(leaseSchema.parse(row))); }
  fenceLost(): ResourceLease[] {
    this.assertAuthority();
    this.db.prepare("UPDATE work_resource_leases SET state='quarantined' WHERE state='active' AND (expires_at<=? OR host_id<>?)")
      .run(this.now(), this.options.hostId);
    return this.live().filter(lease => this.leaseState(lease) === "quarantined");
  }
  waiting(workId: string): string[] {
    return this.db.prepare("SELECT owner_json,reason FROM work_resource_waiters WHERE deadline_at>?").all(this.now()).map(row => z.object({ owner_json: z.string(), reason: z.string() }).parse(row))
      .filter(row => workResourceOwnerSchema.parse(JSON.parse(row.owner_json)).workId === workId).map(row => row.reason);
  }
  cancelWaiting(input: { workId?: string; taskId?: string; actionId?: string }): number {
    if (!input.workId && !input.taskId && !input.actionId) throw new Error("取消资源等待必须指定真实作用域");
    this.assertAuthority();
    return this.db.prepare(`DELETE FROM work_resource_waiters WHERE (? IS NULL OR json_extract(owner_json,'$.workId')=?)
      AND (? IS NULL OR json_extract(owner_json,'$.taskId')=?) AND (? IS NULL OR action_id=?)`)
      .run(input.workId ?? null, input.workId ?? null, input.taskId ?? null, input.taskId ?? null, input.actionId ?? null, input.actionId ?? null).changes;
  }
  async waitForChange(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); changes.removeListener(this.db.name, finish); signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { clearTimeout(timer); changes.removeListener(this.db.name, finish); reject(signal?.reason ?? new Error("资源等待已取消")); };
      const timer = setTimeout(finish, 250); // Bounded cross-process fallback; no transaction spans the wait.
      changes.once(this.db.name, finish); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  readAction(actionId: string): ResourceLease | undefined {
    const row = leaseSchema.optional().parse(this.db.prepare("SELECT * FROM work_resource_leases WHERE action_id=?").get(actionId));
    return row ? this.dto(row) : undefined;
  }
  leaseState(lease: ResourceLease): "active" | "quarantined" | "released" | undefined {
    const row = this.row(lease.token);
    return row?.action_id === lease.actionId ? row.state : undefined;
  }
  recordNotStarted(actionId: string, owner: WorkResourceOwner, reason: string): boolean {
    return this.db.transaction(() => {
      this.assertAuthority();
      if (this.readAction(actionId)) return this.wasNotStarted(actionId, owner);
      this.db.prepare("INSERT OR IGNORE INTO work_resource_denials(action_id,owner_key,reason,recorded_at) VALUES (?,?,?,?)")
        .run(actionId, resourceOwnerKey(owner), reason, this.now());
      this.cancelWaiting({ actionId });
      return this.wasNotStarted(actionId, owner);
    }).immediate();
  }
  wasNotStarted(actionId: string, owner: WorkResourceOwner): boolean {
    if (this.db.prepare("SELECT 1 FROM work_resource_denials WHERE action_id=? AND owner_key=?").get(actionId, resourceOwnerKey(owner))) return true;
    const lease = this.readAction(actionId);
    if (!lease || resourceOwnerKey(lease.owner) !== resourceOwnerKey(owner) || this.leaseState(lease) !== "released") return false;
    const row = z.object({ settlement_json: z.string().nullable() }).parse(this.db.prepare("SELECT settlement_json FROM work_resource_leases WHERE token=?").get(lease.token));
    return Boolean(row.settlement_json && z.object({ outcome: z.literal("not_started") }).safeParse(JSON.parse(row.settlement_json)).success);
  }
  private dto(row: z.infer<typeof leaseSchema>): ResourceLease {
    return { token: row.token, actionId: row.action_id, owner: workResourceOwnerSchema.parse(JSON.parse(row.owner_json)),
      resources: z.array(workResourceSchema).parse(JSON.parse(row.resources_json)), hostId: row.host_id, expiresAt: row.expires_at };
  }
  private row(token: number) { return leaseSchema.optional().parse(this.db.prepare("SELECT * FROM work_resource_leases WHERE token=?").get(token)); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private nextObservation(): number {
    this.db.prepare("UPDATE work_resource_observation_clock SET sequence=sequence+1 WHERE singleton=1").run();
    return z.object({ sequence: z.number() }).parse(this.db.prepare("SELECT sequence FROM work_resource_observation_clock WHERE singleton=1").get()).sequence;
  }
  assertAuthority(): void { if (this.options.isAuthority?.() === false) throw new Error("资源宿主不持有 authority"); }
}
