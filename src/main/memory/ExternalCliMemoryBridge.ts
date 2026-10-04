import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { getMyBuddyDir } from "../paths";
import type { MemoryGatewayAccessMode } from "../../shared/memory-gateway";
import type { MemoryGatewayController } from "./MemoryGatewayController";
import { protectMemoryGatewaySecretFile } from "./MemoryGatewayFileSecurity";

interface ExternalCliMemoryProfile {
  version: 1;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  grantId: string;
  mode: MemoryGatewayAccessMode;
  httpBaseUrl: string;
  mcpUrl: string;
  token: string;
  updatedAt: number;
}

export interface ExternalCliMemoryBridgeResult {
  enabled: boolean;
  mode?: MemoryGatewayAccessMode;
  profilePath?: string;
  reason?: "gateway_disabled" | "gateway_not_running" | "memory_disabled";
}

function canonicalPath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function safeProfileHash(workspaceId: string, cwd: string): string {
  return createHash("sha256").update(`${workspaceId}\n${canonicalPath(cwd)}`).digest("hex").slice(0, 28);
}

function isProfile(value: unknown): value is ExternalCliMemoryProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ExternalCliMemoryProfile>;
  return profile.version === 1
    && typeof profile.workspaceId === "string"
    && typeof profile.workspaceName === "string"
    && typeof profile.cwd === "string"
    && typeof profile.grantId === "string"
    && (profile.mode === "read" || profile.mode === "read-write")
    && typeof profile.httpBaseUrl === "string"
    && typeof profile.mcpUrl === "string"
    && typeof profile.token === "string"
    && profile.token.length >= 20
    && Number.isFinite(profile.updatedAt);
}

/**
 * Bridge MyBuddy's existing Memory Gateway into external CLI sessions without
 * creating a second memory store.
 *
 * The plaintext delegated token is persisted only in a MyBuddy-owned runtime
 * profile protected with the same user-only ACL as the gateway's other secret
 * files. Each grant is workspace-scoped, so a CLI launched for workspace A
 * cannot use its credential to read workspace B.
 */
export class ExternalCliMemoryBridge {
  private readonly profileRoot: string;

  constructor(
    private readonly controller: MemoryGatewayController,
    profileRoot = join(getMyBuddyDir(), "runtime", "memory-share"),
  ) {
    this.profileRoot = profileRoot;
  }

  ensureWorkspaceAccess(input: { workspaceId: string; workspaceName: string; cwd: string }): ExternalCliMemoryBridgeResult {
    const workspaceId = input.workspaceId.trim();
    const workspaceName = input.workspaceName.trim() || workspaceId;
    const cwd = resolve(input.cwd);
    const status = this.controller.status();
    if (!status.configuredEnabled) return { enabled: false, reason: "gateway_disabled" };
    if (!status.running) return { enabled: false, reason: "gateway_not_running" };
    if (!status.memoryEnabled) return { enabled: false, reason: "memory_disabled" };

    const mode: MemoryGatewayAccessMode = status.writeEnabled ? "read-write" : "read";
    mkdirSync(this.profileRoot, { recursive: true });

    const existingProfiles = this.readProfiles().filter(({ profile }) => profile.workspaceId === workspaceId);
    let grantId: string | undefined;
    let token: string | undefined;

    for (const { profile } of existingProfiles) {
      const principal = this.controller.accessControl.authenticate(profile.token);
      if (!principal || principal.kind !== "grant") continue;
      if (principal.scopeType !== "workspace" || principal.scopeId !== workspaceId || principal.mode !== mode) continue;
      grantId = principal.id;
      token = profile.token;
      break;
    }

    const dedicatedName = this.grantName(workspaceId);
    if (!grantId || !token) {
      const grants = this.controller.listGrants();
      const reusable = grants.find((grant) => grant.name === dedicatedName && grant.scopeType === "workspace" && grant.scopeId === workspaceId);
      if (reusable) {
        this.controller.updateGrant({
          id: reusable.id,
          enabled: true,
          mode,
          scopeType: "workspace",
          scopeId: workspaceId,
        });
        const issued = this.controller.rotateGrant(reusable.id);
        grantId = issued.grant.id;
        token = issued.token;
      } else {
        const issued = this.controller.createGrant({
          name: dedicatedName,
          mode,
          scopeType: "workspace",
          scopeId: workspaceId,
        });
        grantId = issued.grant.id;
        token = issued.token;
      }

      // Rotation invalidates prior runtime profiles for this workspace; refresh
      // every one we still know about so already-open CLI shells keep working.
      for (const { path, profile } of existingProfiles) {
        this.writeProfile(path, {
          ...profile,
          workspaceName,
          grantId,
          mode,
          httpBaseUrl: status.httpBaseUrl,
          mcpUrl: status.mcpUrl,
          token,
          updatedAt: Date.now(),
        });
      }
    }

    // Remove only duplicate grants created by this bridge's deterministic name.
    // User-created grants with other names are never touched.
    for (const duplicate of this.controller.listGrants()) {
      if (duplicate.id === grantId) continue;
      if (duplicate.name !== dedicatedName || duplicate.scopeType !== "workspace" || duplicate.scopeId !== workspaceId) continue;
      try { this.controller.deleteGrant(duplicate.id); } catch { /* best effort */ }
    }

    const profilePath = join(this.profileRoot, `${safeProfileHash(workspaceId, cwd)}.json`);
    this.writeProfile(profilePath, {
      version: 1,
      workspaceId,
      workspaceName,
      cwd,
      grantId,
      mode,
      httpBaseUrl: status.httpBaseUrl,
      mcpUrl: status.mcpUrl,
      token,
      updatedAt: Date.now(),
    });

    return { enabled: true, mode, profilePath };
  }

  /** Prepare a task-scoped delegated profile for an independent Task cwd. */
  ensureTaskAccess(input: { taskId: string; taskName: string; cwd: string }): ExternalCliMemoryBridgeResult {
    const taskId = input.taskId.trim();
    const taskName = input.taskName.trim() || taskId;
    const cwd = resolve(input.cwd);
    const status = this.controller.status();
    if (!status.configuredEnabled) return { enabled: false, reason: "gateway_disabled" };
    if (!status.running) return { enabled: false, reason: "gateway_not_running" };
    if (!status.memoryEnabled) return { enabled: false, reason: "memory_disabled" };

    const mode: MemoryGatewayAccessMode = status.writeEnabled ? "read-write" : "read";
    mkdirSync(this.profileRoot, { recursive: true });
    // Keep profile v1 compatible with the existing cwd-based CLI selector. The
    // workspaceId field is a profile identity here; authorization remains a real
    // Memory Gateway task scope and never masquerades as a workspace grant.
    const profileScopeId = `task:${taskId}`;
    const existingProfiles = this.readProfiles().filter(({ profile }) => profile.workspaceId === profileScopeId);
    let grantId: string | undefined;
    let token: string | undefined;

    for (const { profile } of existingProfiles) {
      const principal = this.controller.accessControl.authenticate(profile.token);
      if (!principal || principal.kind !== "grant") continue;
      if (principal.scopeType !== "task" || principal.scopeId !== taskId || principal.mode !== mode) continue;
      grantId = principal.id;
      token = profile.token;
      break;
    }

    const dedicatedName = this.taskGrantName(taskId);
    if (!grantId || !token) {
      const grants = this.controller.listGrants();
      const reusable = grants.find((grant) =>
        grant.name === dedicatedName && grant.scopeType === "task" && grant.scopeId === taskId,
      );
      if (reusable) {
        this.controller.updateGrant({
          id: reusable.id,
          enabled: true,
          mode,
          scopeType: "task",
          scopeId: taskId,
        });
        const issued = this.controller.rotateGrant(reusable.id);
        grantId = issued.grant.id;
        token = issued.token;
      } else {
        const issued = this.controller.createGrant({
          name: dedicatedName,
          mode,
          scopeType: "task",
          scopeId: taskId,
        });
        grantId = issued.grant.id;
        token = issued.token;
      }

      for (const { path, profile } of existingProfiles) {
        this.writeProfile(path, {
          ...profile,
          workspaceName: taskName,
          grantId,
          mode,
          httpBaseUrl: status.httpBaseUrl,
          mcpUrl: status.mcpUrl,
          token,
          updatedAt: Date.now(),
        });
      }
    }

    for (const duplicate of this.controller.listGrants()) {
      if (duplicate.id === grantId) continue;
      if (duplicate.name !== dedicatedName || duplicate.scopeType !== "task" || duplicate.scopeId !== taskId) continue;
      try { this.controller.deleteGrant(duplicate.id); } catch { /* best effort */ }
    }

    const profilePath = join(this.profileRoot, `${safeProfileHash(profileScopeId, cwd)}.json`);
    this.writeProfile(profilePath, {
      version: 1,
      workspaceId: profileScopeId,
      workspaceName: taskName,
      cwd,
      grantId,
      mode,
      httpBaseUrl: status.httpBaseUrl,
      mcpUrl: status.mcpUrl,
      token,
      updatedAt: Date.now(),
    });
    return { enabled: true, mode, profilePath };
  }

  private taskGrantName(taskId: string): string {
    return `MyBuddy CLI Memory Task ${taskId}`.slice(0, 80);
  }

  private grantName(workspaceId: string): string {
    return `MyBuddy CLI Memory ${workspaceId}`.slice(0, 80);
  }

  private readProfiles(): Array<{ path: string; profile: ExternalCliMemoryProfile }> {
    if (!existsSync(this.profileRoot)) return [];
    const out: Array<{ path: string; profile: ExternalCliMemoryProfile }> = [];
    for (const name of readdirSync(this.profileRoot)) {
      if (!name.toLowerCase().endsWith(".json")) continue;
      const path = join(this.profileRoot, name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (isProfile(parsed)) out.push({ path, profile: parsed });
      } catch {
        // Corrupt profile is ignored; ensureWorkspaceAccess will issue a fresh
        // credential without weakening the gateway's authorization store.
      }
    }
    return out;
  }

  private writeProfile(path: string, profile: ExternalCliMemoryProfile): void {
    mkdirSync(this.profileRoot, { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      protectMemoryGatewaySecretFile(tmp);
      renameSync(tmp, path);
      protectMemoryGatewaySecretFile(path);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }
}

export function cwdMatchesProfile(cwd: string, profileCwd: string): boolean {
  const current = canonicalPath(cwd);
  const root = canonicalPath(profileCwd);
  return current === root || current.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
