import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalCliMemoryBridge } from "../src/main/memory/ExternalCliMemoryBridge";

const root = mkdtempSync(join(tmpdir(), "mybuddy-cli-memory-bridge-"));
const grants: Array<{ id: string; name: string; enabled: boolean; mode: "read" | "read-write"; scopeType: "workspace"; scopeId: string; token: string }> = [];
let next = 1;
let writeEnabled = false;

const controller = {
  status: () => ({
    configuredEnabled: true,
    running: true,
    memoryEnabled: true,
    writeEnabled,
    httpBaseUrl: "http://127.0.0.1:3351/v1/memory",
    mcpUrl: "http://127.0.0.1:3351/mcp",
  }),
  accessControl: {
    authenticate(token: string) {
      const grant = grants.find((item) => item.enabled && item.token === token);
      if (!grant) return null;
      return { kind: "grant", id: grant.id, name: grant.name, mode: grant.mode, scopeType: grant.scopeType, scopeId: grant.scopeId, accessSince: 1 };
    },
  },
  listGrants: () => grants.map(({ token: _token, ...grant }) => ({ ...grant, accessSince: 1, createdAt: 1, updatedAt: 1 })),
  createGrant(request: { name: string; mode: "read" | "read-write"; scopeType: "workspace"; scopeId: string }) {
    const grant = { id: `g${next++}`, name: request.name, enabled: true, mode: request.mode, scopeType: request.scopeType, scopeId: request.scopeId, token: `token-${next}-${"x".repeat(32)}` };
    grants.push(grant);
    const { token, ...dto } = grant;
    return { grant: { ...dto, accessSince: 1, createdAt: 1, updatedAt: 1 }, token };
  },
  updateGrant(request: { id: string; enabled?: boolean; mode?: "read" | "read-write" }) {
    const grant = grants.find((item) => item.id === request.id)!;
    if (request.enabled !== undefined) grant.enabled = request.enabled;
    if (request.mode !== undefined) grant.mode = request.mode;
    const { token: _token, ...dto } = grant;
    return { ...dto, accessSince: 1, createdAt: 1, updatedAt: 1 };
  },
  rotateGrant(id: string) {
    const grant = grants.find((item) => item.id === id)!;
    grant.token = `rotated-${next++}-${"y".repeat(32)}`;
    const { token, ...dto } = grant;
    return { grant: { ...dto, accessSince: 1, createdAt: 1, updatedAt: 1 }, token };
  },
  deleteGrant(id: string) {
    const index = grants.findIndex((item) => item.id === id);
    if (index >= 0) grants.splice(index, 1);
  },
} as any;

try {
  const bridge = new ExternalCliMemoryBridge(controller, root);
  const first = bridge.ensureWorkspaceAccess({ workspaceId: "ws-a", workspaceName: "A", cwd: "C:\\repo-a" });
  assert.equal(first.enabled, true);
  assert.equal(first.mode, "read");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].scopeType, "workspace");
  assert.equal(grants[0].scopeId, "ws-a");
  const firstProfile = JSON.parse(readFileSync(first.profilePath!, "utf8"));
  assert.equal(firstProfile.token, grants[0].token);

  const again = bridge.ensureWorkspaceAccess({ workspaceId: "ws-a", workspaceName: "A", cwd: "C:\\repo-a" });
  assert.equal(again.enabled, true);
  assert.equal(grants.length, 1, "same workspace/profile must reuse one delegated grant");
  assert.equal(JSON.parse(readFileSync(again.profilePath!, "utf8")).token, firstProfile.token, "unchanged mode should reuse token");

  writeEnabled = true;
  const upgraded = bridge.ensureWorkspaceAccess({ workspaceId: "ws-a", workspaceName: "A", cwd: "C:\\repo-a" });
  assert.equal(upgraded.mode, "read-write");
  assert.equal(grants.length, 1, "permission upgrade must rotate/reuse the same bridge grant");
  const upgradedProfile = JSON.parse(readFileSync(upgraded.profilePath!, "utf8"));
  assert.notEqual(upgradedProfile.token, firstProfile.token, "mode change rotates delegated token");
  assert.equal(grants[0].mode, "read-write");

  bridge.ensureWorkspaceAccess({ workspaceId: "ws-b", workspaceName: "B", cwd: "D:\\repo-b" });
  assert.equal(grants.length, 2, "different workspace gets a different credential");
  assert.notEqual(grants[0].token, grants[1].token);
  assert.notEqual(grants[0].scopeId, grants[1].scopeId);

  console.log("external-cli-memory-bridge-test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
