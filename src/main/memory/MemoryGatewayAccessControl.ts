import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMyBuddyDir } from "../paths";
import { protectMemoryGatewaySecretFile } from "./MemoryGatewayFileSecurity";
import type {
  MemoryGatewayAccessGrantDto,
  MemoryGatewayAccessMode,
  MemoryGatewayCreateGrantRequest,
  MemoryGatewayGrantScopeType,
  MemoryGatewayIssuedGrantDto,
  MemoryGatewayUpdateGrantRequest,
} from "../../shared/memory-gateway";

interface StoredGrant extends MemoryGatewayAccessGrantDto {
  tokenHash: string;
}

interface AccessFile {
  version: 1;
  grants: StoredGrant[];
}

export interface MemoryGatewayAccessPrincipal {
  kind: "owner" | "grant";
  id: string;
  name: string;
  mode: MemoryGatewayAccessMode;
  scopeType: MemoryGatewayGrantScopeType;
  scopeId?: string;
  accessSince: number;
}

const EMPTY: AccessFile = { version: 1, grants: [] };
const VALID_MODES = new Set<MemoryGatewayAccessMode>(["read", "read-write"]);
const VALID_SCOPES = new Set<MemoryGatewayGrantScopeType>(["all", "global", "project", "workspace", "task"]);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) throw new Error("授权名称必须为 1–80 个字符");
  return name;
}

function cleanScope(scopeType: MemoryGatewayGrantScopeType, scopeId?: string | null): { scopeType: MemoryGatewayGrantScopeType; scopeId?: string } {
  if (!VALID_SCOPES.has(scopeType)) throw new Error(`不支持的授权范围：${String(scopeType)}`);
  const id = scopeId?.trim() || undefined;
  if (scopeType === "all" || scopeType === "global") {
    if (id) throw new Error(`${scopeType} 授权不能携带 scopeId`);
    return { scopeType };
  }
  if (!id || id.length > 200) throw new Error(`${scopeType} 授权必须携带有效 scopeId`);
  return { scopeType, scopeId: id };
}

function sanitize(grant: StoredGrant): MemoryGatewayAccessGrantDto {
  const { tokenHash: _secret, ...dto } = grant;
  return dto;
}

export class MemoryGatewayAccessControl {
  private readonly path: string;
  private protectionVerified = false;

  constructor(path = join(getMyBuddyDir(), "memory-access.json")) {
    this.path = path;
  }

  list(): MemoryGatewayAccessGrantDto[] {
    return this.read().grants.map(sanitize).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  count(): number {
    return this.read().grants.length;
  }

  validate(): void {
    this.read();
  }

  create(request: MemoryGatewayCreateGrantRequest): MemoryGatewayIssuedGrantDto {
    if (!VALID_MODES.has(request.mode)) throw new Error(`不支持的授权模式：${String(request.mode)}`);
    const scope = cleanScope(request.scopeType, request.scopeId);
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    const grant: StoredGrant = {
      id: `mga_${randomUUID()}`,
      name: cleanName(request.name),
      enabled: true,
      mode: request.mode,
      ...scope,
      tokenHash: tokenHash(token),
      accessSince: now,
      createdAt: now,
      updatedAt: now,
    };
    const state = this.read();
    state.grants.push(grant);
    this.write(state);
    return { grant: sanitize(grant), token };
  }

  update(request: MemoryGatewayUpdateGrantRequest): MemoryGatewayAccessGrantDto {
    const state = this.read();
    const grant = state.grants.find((item) => item.id === request.id);
    if (!grant) throw new Error(`授权不存在：${request.id}`);
    const wasEnabled = grant.enabled;
    const previousScopeType = grant.scopeType;
    const previousScopeId = grant.scopeId;
    if (request.name !== undefined) grant.name = cleanName(request.name);
    if (request.enabled !== undefined) grant.enabled = request.enabled === true;
    if (request.mode !== undefined) {
      if (!VALID_MODES.has(request.mode)) throw new Error(`不支持的授权模式：${String(request.mode)}`);
      grant.mode = request.mode;
    }
    if (request.scopeType !== undefined || request.scopeId !== undefined) {
      const scope = cleanScope(request.scopeType ?? grant.scopeType, request.scopeId === undefined ? grant.scopeId : request.scopeId);
      grant.scopeType = scope.scopeType;
      grant.scopeId = scope.scopeId;
    }
    const now = Date.now();
    if ((!wasEnabled && grant.enabled) || grant.scopeType !== previousScopeType || grant.scopeId !== previousScopeId) {
      grant.accessSince = now;
    }
    grant.updatedAt = now;
    this.write(state);
    return sanitize(grant);
  }

  rotate(id: string): MemoryGatewayIssuedGrantDto {
    const state = this.read();
    const grant = state.grants.find((item) => item.id === id);
    if (!grant) throw new Error(`授权不存在：${id}`);
    const token = randomBytes(32).toString("base64url");
    grant.tokenHash = tokenHash(token);
    grant.updatedAt = Date.now();
    this.write(state);
    return { grant: sanitize(grant), token };
  }

  delete(id: string): void {
    const state = this.read();
    const next = state.grants.filter((item) => item.id !== id);
    if (next.length === state.grants.length) throw new Error(`授权不存在：${id}`);
    state.grants = next;
    this.write(state);
  }

  authenticate(token: string): MemoryGatewayAccessPrincipal | null {
    if (!token) return null;
    const digest = tokenHash(token);
    for (const grant of this.read().grants) {
      if (!grant.enabled || !constantTimeHexEqual(digest, grant.tokenHash)) continue;
      return {
        kind: "grant",
        id: grant.id,
        name: grant.name,
        mode: grant.mode,
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
        accessSince: grant.accessSince,
      };
    }
    return null;
  }

  private read(): AccessFile {
    if (!existsSync(this.path)) return { ...EMPTY, grants: [] };
    try {
      if (!this.protectionVerified) {
        protectMemoryGatewaySecretFile(this.path);
        this.protectionVerified = true;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<AccessFile>;
      const grants = Array.isArray(parsed.grants) ? parsed.grants.filter((item): item is StoredGrant => {
        return Boolean(
          item && typeof item.id === "string" && typeof item.name === "string" &&
          typeof item.tokenHash === "string" && /^[0-9a-f]{64}$/.test(item.tokenHash) &&
          typeof item.enabled === "boolean" && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) &&
          VALID_MODES.has(item.mode) && VALID_SCOPES.has(item.scopeType),
        );
      }).map((item) => ({
        ...item,
        accessSince: Number.isFinite(item.accessSince) ? item.accessSince : item.createdAt,
      })) : [];
      return { version: 1, grants };
    } catch {
      throw new Error(`外部 Memory 授权文件损坏：${this.path}`);
    }
  }

  private write(state: AccessFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "w", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: 1, grants: state.grants }, null, 2)}\n`, "utf-8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      protectMemoryGatewaySecretFile(tmp);
      renameSync(tmp, this.path);
      protectMemoryGatewaySecretFile(this.path);
      this.protectionVerified = true;
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }
}
