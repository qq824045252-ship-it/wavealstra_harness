/**
 * Workspace Runtime Integration Tests — Phase 2B
 * 覆盖：PromptContextService 运行时注入 / Persistence adapter (memories) / Promote runtime / Task 接口 / archived / 链一致性
 * 冻结语义：Task > Current > Parent > Grandparent > Root；同级隔离；子不反向污染；Promote 仅显式 immediate parent
 * 复用单源层级：buildSpaceEffectiveMap / getSpaceAncestorsDeterministic，不建第二套算法
 * 不做：Sidebar 大 UI、LLM 自动总结、ERP/Kanban/Project Shared Context 大迁移、E2E/chaos
 *
 * Run: pnpm run test:workspace-runtime-integration
 */
import assertStrict from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { WorkspaceSharedContextService } from "../src/main/workspace/WorkspaceSharedContextService";
import {
  assembleWorkspaceSharedContext,
  formatWorkspaceSharedContextForPrompt,
} from "../src/shared/workspace-shared-context";
import { buildSpaceEffectiveMap } from "../src/shared/workspace-tree";
import { getSpaceAncestorsDeterministic } from "../src/shared/workspace-resolver";
import { PromptContextService } from "../src/main/artifact/PromptContextService";
import { formatPromptContext } from "../src/main/artifact/PromptContextFormatter";
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
import type { SpaceDto } from "../src/shared/agent-ipc";
import type { WorkspaceSharedContextItem } from "../src/shared/workspace-shared-context";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { SelectionState } from "../src/shared/selection";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
function eq<T>(a: T, b: T, label: string): void {
  try {
    assertStrict.deepStrictEqual(a, b);
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
  }
}
function mkItem(over: Partial<WorkspaceSharedContextItem> & { id: string; spaceId: string; content: string }): WorkspaceSharedContextItem {
  return { createdAt: 1000, updatedAt: 1000, source: "manual", ...over };
}
function mkSpace(id: string, name: string, parentId: string | null, extra: Partial<SpaceDto> = {}): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1, ...extra };
}
function createWorkspaceMemory(memory: MemoryService, workspaceId: string, text: string) {
  return memory.create({ kind: "fact", title: text, content: "", scopeType: "workspace", scopeId: workspaceId, sourceType: "manual", explicit: true });
}

async function main(): Promise<void> {
  console.log("== 1) PromptContextService 运行时注入：Task>Current>Parent>Root 顺序 ==");
  {
    const spaces: SpaceDto[] = [
      mkSpace("root", "Root", null),
      mkSpace("a", "A", "root"),
      mkSpace("a1", "A1", "a"),
      mkSpace("a1x", "A1X", "a1"),
      mkSpace("b", "B", "root"),
    ];
    const taskItems: WorkspaceSharedContextItem[] = [
      mkItem({ id: "task-high", spaceId: "task", content: "task ultimate", createdAt: 1, updatedAt: 5000 }),
    ];
    const itemsBySpace: Record<string, WorkspaceSharedContextItem[]> = {
      root: [mkItem({ id: "root-note", spaceId: "root", content: "root shared" })],
      a: [mkItem({ id: "a-note", spaceId: "a", content: "a constraint" })],
      a1: [mkItem({ id: "a1-note", spaceId: "a1", content: "a1 fact" })],
      a1x: [mkItem({ id: "a1x-note", spaceId: "a1x", content: "a1x local" })],
      b: [mkItem({ id: "b-note", spaceId: "b", content: "B sibling" })],
    };
    // provider：按 artifactId 映射到 currentSpaceId（模拟 main/index.ts 的 getWorkspaceSharedContext）
    const artifactSpaceMap = new Map<string, string>([
      ["art-a1x", "a1x"],
      ["art-a1", "a1"],
      ["art-a", "a"],
      ["art-b", "b"],
      ["art-root", "root"],
      ["art-standalone", ""],
    ]);
    const getWorkspaceSharedContext = (artifactId: string): string | null => {
      const cur = artifactSpaceMap.get(artifactId);
      if (cur === undefined || cur === "") return null;
      const res = assembleWorkspaceSharedContext({ spaces, currentSpaceId: cur, itemsBySpace, taskItems });
      return formatWorkspaceSharedContextForPrompt(res);
    };

    const makeArtifact = (id: string, taskId: string): ArtifactDescriptor => ({
      id, taskId, kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0,
    });
    const emptySel: SelectionState = { status: "empty", descriptor: null, updatedAt: 0 };
    const svc = new PromptContextService({
      getArtifact: (id) => {
        if (artifactSpaceMap.has(id)) return makeArtifact(id, `task-${id}`);
        return null;
      },
      readContent: async (id) => artifactSpaceMap.has(id) ? { content: "<p>hello</p>", kind: "html" } : null,
      getSelection: () => emptySel,
      getWorkspaceSharedContext,
    });
    const resA1x = await svc.collect("art-a1x");
    ok(resA1x.ok, "a1x collect ok");
    if (resA1x.ok) {
      const ws = resA1x.context.workspaceSharedContext ?? "";
      ok(ws.includes("task ultimate"), "workspace contains task (highest priority)");
      ok(ws.includes("a1x local"), "contains current");
      ok(ws.includes("a1 fact"), "contains parent");
      ok(ws.includes("a constraint"), "contains grandparent");
      ok(ws.includes("root shared"), "contains root");
      ok(!ws.includes("B sibling"), "sibling isolated (b not included for a1x)");
      // order: task before a1x before a1 before a before root
      const idxTask = ws.indexOf("task ultimate");
      const idxA1x = ws.indexOf("a1x local");
      const idxA1 = ws.indexOf("a1 fact");
      const idxA = ws.indexOf("a constraint");
      const idxRoot = ws.indexOf("root shared");
      ok(idxTask < idxA1x && idxA1x < idxA1 && idxA1 < idxA && idxA < idxRoot, `order Task>Current>Parent>Root idx ${idxTask},${idxA1x},${idxA1},${idxA},${idxRoot}`);
      const formatted = formatPromptContext(resA1x.context);
      ok(formatted.includes("task ultimate") && formatted.includes("Workspace Shared Context"), "formatter persists workspace shared context before UNTRUSTED");
    }

    // Task > Current precedence even if parent newer
    const itemsBySpace2: Record<string, WorkspaceSharedContextItem[]> = {
      root: [mkItem({ id: "root-newer", spaceId: "root", content: "root newer", updatedAt: 9999 })],
      a: [mkItem({ id: "a-older", spaceId: "a", content: "a older", updatedAt: 10 })],
      a1: [mkItem({ id: "a1-cur", spaceId: "a1", content: "a1 cur", updatedAt: 20 })],
    };
    const getWs2 = (artifactId: string): string | null => {
      if (artifactId !== "art-a1") return null;
      const r = assembleWorkspaceSharedContext({ spaces, currentSpaceId: "a1", itemsBySpace: itemsBySpace2, taskItems: [] });
      return formatWorkspaceSharedContextForPrompt(r);
    };
    const svc2 = new PromptContextService({
      getArtifact: (id) => id === "art-a1" ? makeArtifact(id, "t") : null,
      readContent: async (id) => id === "art-a1" ? { content: "<p>x</p>", kind: "html" } : null,
      getSelection: () => emptySel,
      getWorkspaceSharedContext: getWs2,
    });
    const res2 = await svc2.collect("art-a1");
    if (res2.ok) {
      const ws = res2.context.workspaceSharedContext ?? "";
      const idxA1 = ws.indexOf("a1 cur");
      const idxA = ws.indexOf("a older");
      const idxRoot = ws.indexOf("root newer");
      ok(idxA1 < idxA && idxA < idxRoot, "hierarchy priority overrides recency (parent newer still after child)");
    }
  }

  console.log("== 2) PromptContextService 兄弟隔离 & child 不反向污染 ==");
  {
    const spaces: SpaceDto[] = [
      mkSpace("root", "Root", null),
      mkSpace("a", "A", "root"),
      mkSpace("b", "B", "root"),
      mkSpace("a1", "A1", "a"),
      mkSpace("b1", "B1", "b"),
    ];
    const itemsBySpace: Record<string, WorkspaceSharedContextItem[]> = {
      a: [mkItem({ id: "a-item", spaceId: "a", content: "A local" })],
      b: [mkItem({ id: "b-item", spaceId: "b", content: "B sibling secret" })],
      a1: [mkItem({ id: "a1-item", spaceId: "a1", content: "A1 child secret" })],
    };
    const getWs = (artifactId: string): string | null => {
      const cur = artifactId === "art-a" ? "a" : artifactId === "art-b" ? "b" : null;
      if (!cur) return null;
      const r = assembleWorkspaceSharedContext({ spaces, currentSpaceId: cur, itemsBySpace });
      return formatWorkspaceSharedContextForPrompt(r);
    };
    const svc = new PromptContextService({
      getArtifact: (id) => (id === "art-a" || id === "art-b") ? ({ id, taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor) : null,
      readContent: async (id) => (id === "art-a" || id === "art-b") ? { content: "<p>x</p>", kind: "html" } : null,
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
      getWorkspaceSharedContext: getWs,
    });
    const ra = await svc.collect("art-a");
    const rb = await svc.collect("art-b");
    if (ra.ok) {
      const ws = ra.context.workspaceSharedContext ?? "";
      ok(ws.includes("A local"), "a sees own");
      ok(!ws.includes("B sibling secret"), "a does NOT see sibling b");
      ok(!ws.includes("A1 child secret"), "parent a does NOT see child a1 (no reverse)");
    }
    if (rb.ok) {
      const ws = rb.context.workspaceSharedContext ?? "";
      ok(ws.includes("B sibling secret"), "b sees own");
      ok(!ws.includes("A local"), "b not sibling polluted");
    }
  }

  console.log("== 3) PromptContextService archived effective 排除 & standalone/null/cycle/missing 安全 ==");
  {
    const spaces: SpaceDto[] = [
      mkSpace("root", "Root", null),
      mkSpace("a", "A", "root", { archived: true }),
      mkSpace("a1", "A1", "a"),
      mkSpace("b", "B", "root"),
    ];
    const itemsBySpace: Record<string, WorkspaceSharedContextItem[]> = {
      root: [mkItem({ id: "root-arch", spaceId: "root", content: "root shared" })],
      a: [mkItem({ id: "a-arch", spaceId: "a", content: "archived parent" })],
      a1: [mkItem({ id: "a1-item", spaceId: "a1", content: "a1 child" })],
      b: [mkItem({ id: "b-item", spaceId: "b", content: "b valid" })],
    };
    const getWs = (artifactId: string): string | null => {
      const cur = artifactId === "art-a1" ? "a1" : artifactId === "art-b" ? "b" : artifactId === "art-standalone" ? null : null;
      const r = assembleWorkspaceSharedContext({ spaces, currentSpaceId: cur, itemsBySpace });
      return formatWorkspaceSharedContextForPrompt(r);
    };
    const svc = new PromptContextService({
      getArtifact: (id) => ({ id, taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor),
      readContent: async () => ({ content: "<p>x</p>", kind: "html" }),
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
      getWorkspaceSharedContext: getWs,
    });
    const ra1 = await svc.collect("art-a1");
    if (ra1.ok) {
      ok(!ra1.context.workspaceSharedContext, "effectiveArchived a1 yields no workspace context (default exclude)");
    }
    const rb = await svc.collect("art-b");
    if (rb.ok) {
      const ws = rb.context.workspaceSharedContext ?? "";
      ok(ws.includes("b valid") && ws.includes("root shared"), "b inherits root (not archived)");
      ok(!ws.includes("archived parent") && !ws.includes("a1 child"), "b not sibling archived leak");
    }
    // standalone/null
    const rStand = await svc.collect("art-standalone");
    if (rStand.ok) {
      ok(!rStand.context.workspaceSharedContext, "standalone/null yields no workspace blocks");
    }
    // cycle/missing safety via provider internal assembly (should not throw)
    const cyclicSpaces: SpaceDto[] = [{ id: "A", name: "A", parentId: "A", sortOrder: 1000, createdAt: 1 }];
    const getWsCycle = (_id: string): string | null => {
      const r = assembleWorkspaceSharedContext({ spaces: cyclicSpaces, currentSpaceId: "A", itemsBySpace: { A: [mkItem({ id: "c", spaceId: "A", content: "cycle" })] } });
      return formatWorkspaceSharedContextForPrompt(r);
    };
    const svcCycle = new PromptContextService({
      getArtifact: (id) => ({ id, taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor),
      readContent: async () => ({ content: "<p>x</p>", kind: "html" }),
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
      getWorkspaceSharedContext: getWsCycle,
    });
    const rc = await svcCycle.collect("any");
    ok(rc.ok && (rc.context.workspaceSharedContext?.includes("cycle") ?? false), "self-loop cycle still returns own item, no infinite");

    // missing parent
    const missingSpaces: SpaceDto[] = [{ id: "x", name: "X", parentId: "missing", sortOrder: 1000, createdAt: 1 }, { id: "y", name: "Y", parentId: "x", sortOrder: 1000, createdAt: 2 }];
    const getWsMissing = (_id: string): string | null => {
      const r = assembleWorkspaceSharedContext({ spaces: missingSpaces, currentSpaceId: "y", itemsBySpace: { x: [mkItem({ id: "x-i", spaceId: "x", content: "x" })], y: [mkItem({ id: "y-i", spaceId: "y", content: "y" })] } });
      return formatWorkspaceSharedContextForPrompt(r);
    };
    const svcMiss = new PromptContextService({
      getArtifact: (id) => ({ id, taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor),
      readContent: async () => ({ content: "<p>x</p>", kind: "html" }),
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
      getWorkspaceSharedContext: getWsMissing,
    });
    const rm = await svcMiss.collect("any");
    ok(rm.ok && (rm.context.workspaceSharedContext?.includes("y") ?? false) && (rm.context.workspaceSharedContext?.includes("x") ?? false), "missing parent y->x stops at missing, not infinite (both x,y present)");

    // No provider (backward compat) should not throw and workspaceSharedContext undefined
    const svcNoProvider = new PromptContextService({
      getArtifact: (id) => ({ id, taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor),
      readContent: async () => ({ content: "<p>x</p>", kind: "html" }),
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
    });
    const rn = await svcNoProvider.collect("any");
    ok(rn.ok && !rn.context.workspaceSharedContext, "no provider backward compatible (no workspace)");
  }

  console.log("== 4) Unified Memory Kernel: read, promote idempotence, restart, L1 dedupe, no chained promote ==");
  {
    const dir = mkdtempSync(join(tmpdir(), "ws-runtime-"));
    const dbPath = join(dir, "test.db");
    const db = new AppDatabase(dbPath);
    try {
      db.createSpace({ id: "root", name: "Root" });
      db.createSpace({ id: "a", name: "A", parentId: "root" });
      db.createSpace({ id: "a1", name: "A1", parentId: "a" });
      db.createSpace({ id: "a1x", name: "A1X", parentId: "a1" });
      db.createSpace({ id: "b", name: "B", parentId: "root" });
      const memory = new MemoryService(db, { semantic: false });
      const local = createWorkspaceMemory(memory, "a1", "important fact");
      createWorkspaceMemory(memory, "b", "b sibling");
      const svc = new WorkspaceSharedContextService(db);

      const digestA1 = svc.getDigest({ currentSpaceId: "a1" });
      ok(digestA1?.includes("important fact"), "a1 sees own L1 memory");
      ok(!digestA1?.includes("b sibling"), "sibling workspace remains isolated");
      ok(!svc.getDigest({ currentSpaceId: "a" })?.includes("important fact"), "parent does not auto-see child before promote");

      const totalBefore = memory.stats().total;
      const promo1 = svc.promote(local.id, "a1");
      ok(promo1.ok && !promo1.alreadyExisted && promo1.targetParentId === "a", "first promote binds immediate parent");
      ok(promo1.ok && promo1.promotedItem.id === local.id, "promote keeps the same L1 Memory id");
      const promoted = memory.get(local.id)!;
      ok(promoted.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === "a" && scope.binding === "promoted"), "parent promoted scope persisted");
      ok(memory.stats().total === totalBefore, "promote does not clone memory_records");
      const parentView = svc.getView({ currentSpaceId: "a", memoryEnabled: true });
      ok(parentView.grouped.promoted.length === 1 && parentView.grouped.promoted[0]!.id === local.id, "parent view shows one promoted item");
      const childView = svc.getView({ currentSpaceId: "a1", memoryEnabled: true });
      ok(childView.grouped.local.length === 1 && childView.grouped.inherited.length === 0, "child keeps local occurrence and does not re-inherit same L1");

      const promo2 = svc.promote(local.id, "a1");
      ok(promo2.ok && promo2.alreadyExisted, "repeat promote is idempotent");
      const parentScopeCount = Number((db.connection.prepare("SELECT COUNT(1) n FROM memory_scopes WHERE memory_id=? AND scope_type='workspace' AND scope_id='a' AND binding='promoted'").get(local.id) as { n: number }).n);
      ok(parentScopeCount === 1, "repeat promote keeps exactly one promoted scope");

      const deep = createWorkspaceMemory(memory, "a1x", "deep fact");
      const deepPromo = svc.promote(deep.id, "a1x");
      ok(deepPromo.ok && deepPromo.targetParentId === "a1", "deep memory promotes only to immediate parent");
      const chained = svc.promote(deep.id, "a1");
      ok(!chained.ok, "promoted binding cannot be chained upward through IPC/service");
      ok(!memory.listExactScope("workspace", "a", ["active"]).some((m) => m.id === deep.id), "grandparent remains clean after rejected chained promote");

      db.close();
      const db2 = new AppDatabase(dbPath);
      const memory2 = new MemoryService(db2, { semantic: false });
      const svc2 = new WorkspaceSharedContextService(db2);
      const restarted = memory2.get(local.id)!;
      ok(restarted.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === "a" && scope.binding === "promoted"), "promoted scope survives restart");
      const afterRestart = svc2.promote(local.id, "a1");
      ok(afterRestart.ok && afterRestart.alreadyExisted, "idempotence survives restart");
      db2.close();
    } finally {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log("== 5) Archived source/target: reject real L1 records without scope pollution ==");
  {
    const dir = mkdtempSync(join(tmpdir(), "ws-arch-"));
    const db = new AppDatabase(join(dir, "arch.db"));
    try {
      db.createSpace({ id: "root", name: "Root" });
      db.createSpace({ id: "archParent", name: "ArchParent", parentId: "root" });
      db.archiveSpace("archParent", true);
      db.createSpace({ id: "child", name: "Child", parentId: "archParent" });
      const memory = new MemoryService(db, { semantic: false });
      const child = createWorkspaceMemory(memory, "child", "child fact");
      const svc = new WorkspaceSharedContextService(db);
      const beforeParent = memory.listExactScope("workspace", "archParent", ["active"]).length;
      const rejected = svc.promote(child.id, "child");
      ok(!rejected.ok, "effectiveArchived child promote rejected");
      ok(memory.listExactScope("workspace", "archParent", ["active"]).length === beforeParent, "archived parent gets no promoted scope");

      db.createSpace({ id: "archSrc", name: "ArchSrc", parentId: "root" });
      db.archiveSpace("archSrc", true);
      const src = createWorkspaceMemory(memory, "archSrc", "arch source fact");
      const beforeRoot = memory.listExactScope("workspace", "root", ["active"]).length;
      const rejectedSource = svc.promote(src.id, "archSrc");
      ok(!rejectedSource.ok, "explicit archived source promote rejected");
      ok(memory.listExactScope("workspace", "root", ["active"]).length === beforeRoot, "non-archived root remains unpolluted");
      db.close();
    } finally {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log("== 6) 与 resolver / shared-context ancestor chain 一致性 ==");
  {
    const spaces: SpaceDto[] = [
      mkSpace("root", "Root", null),
      mkSpace("a", "A", "root"),
      mkSpace("a1", "A1", "a"),
      mkSpace("b", "B", "root"),
    ];
    const cases = ["a", "a1", "b", "root"];
    for (const sid of cases) {
      const resolverChain = getSpaceAncestorsDeterministic(sid, spaces);
      const ctxChain = assembleWorkspaceSharedContext({ spaces, currentSpaceId: sid, itemsBySpace: {} }).ancestorChain;
      const expectedChain = [sid, ...resolverChain];
      eq(ctxChain, expectedChain, `ancestorChain for ${sid} matches resolver [${sid},...ancestors]`);
      // Effective map consistency
      const eff = buildSpaceEffectiveMap(spaces);
      const svcChain = new WorkspaceSharedContextService(new AppDatabase(":memory:") as any); // just to check helpers reuse same buildSpaceEffectiveMap?
      // Instead verify that effectiveArchived via buildSpaceEffectiveMap is same as resolver's filtering
      // For non-archived case, should be same
      ok(eff.get(sid) === false, `effectiveArchived for ${sid} false (non-arch)`);
    }
    // archived consistency
    const archSpaces: SpaceDto[] = [
      mkSpace("root", "Root", null),
      mkSpace("a", "A", "root", { archived: true }),
      mkSpace("a1", "A1", "a"),
    ];
    const eff = buildSpaceEffectiveMap(archSpaces);
    ok(eff.get("a") === true, "a effectiveArchived true");
    ok(eff.get("a1") === true, "a1 effective via parent true");
    const resA1 = assembleWorkspaceSharedContext({ spaces: archSpaces, currentSpaceId: "a1", itemsBySpace: { root: [mkItem({ id: "r", spaceId: "root", content: "r" })] } });
    ok(resA1.blocks.length === 0, "archived effectiveArchived a1 => 0 blocks (consistent)");
    const resA1Inc = assembleWorkspaceSharedContext({ spaces: archSpaces, currentSpaceId: "a1", itemsBySpace: { root: [mkItem({ id: "r", spaceId: "root", content: "r" })], a: [mkItem({ id: "a", spaceId: "a", content: "a" })], a1: [mkItem({ id: "a1", spaceId: "a1", content: "a1" })] }, includeArchived: true });
    ok(resA1Inc.blocks.length === 3, "includeArchived true includes chain");
  }

  console.log("== 7) PromptAssembly convergence: no duplicated legacy memory system segments ==");
  {
    const profile: any = {
      labelZh: "Test Mode",
      blocks: [{ label: "A", content: "mode A", source: "seed" }],
      hasUserOverride: false,
      policy: { toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] }, artifactPolicy: { mode: "soft", deny: [], allow: [] }, mcpPolicy: { mode: "soft", deny: [], allow: [] }, skillPolicy: {}, suggestedPermissionMode: undefined },
    };
    const trace = assemblePrompt({ welcomeMode: "coding", profile, soul: { name: "Bot", alias: "User", persona: "persona" }, permissionMode: "default", platform: "linux", memoryEnabled: true, skills: [], disableSkillFilter: true });
    const ids = trace.segments.map((segment) => segment.id);
    ok(!ids.includes("globalMemory") && !ids.includes("spaceMemory") && !ids.includes("workspaceSharedContext"), "legacy duplicated memory system segments are absent");
    const idxRules = ids.indexOf("memoryRules");
    const idxPerm = ids.indexOf("permission");
    ok(idxRules >= 0 && idxPerm > idxRules, "system assembly keeps only memory rules before permission");
    ok(trace.appendParts.every((part) => !part.includes("Relevant Memory")), "query-aware L1 memory is not frozen into session prefix");
  }

  console.log("== 8) Task and Workspace Memory share one L1; Task occurrence wins ==");
  {
    const db = new AppDatabase(":memory:");
    try {
      db.createSpace({ id: "root", name: "Root" });
      db.createSpace({ id: "a", name: "A", parentId: "root" });
      const now = Date.now();
      const taskId = "task-memory-priority";
      db.upsertTask({ id: taskId, title: "Task Memory", spaceId: "a", updatedAt: now } as any);
      const memory = new MemoryService(db, { semantic: false });
      const taskMemory = memory.create({ kind: "fact", title: "same-l1", content: "task wins", scopeType: "task", scopeId: taskId, sourceType: "manual", explicit: true });
      memory.promote(taskMemory.id, "workspace", "a");
      const svc = new WorkspaceSharedContextService(db);
      const taskItems = svc.loadTaskItems(taskId);
      const itemsBySpace = svc.loadItemsBySpace();
      ok(taskItems.length === 1 && taskItems[0]!.id === taskMemory.id, "task-scoped Memory loads from unified kernel");
      ok((itemsBySpace.get("a") ?? []).some((item) => item.id === taskMemory.id), "same L1 also visible through promoted workspace scope");
      const assembled = assembleWorkspaceSharedContext({ spaces: db.listSpaces(), currentSpaceId: "a", taskItems, itemsBySpace });
      ok(assembled.blocks.filter((block) => block.item.id === taskMemory.id).length === 1, "same L1 appears once across Task and Workspace scopes");
      ok(assembled.blocks[0]!.source === "task" && assembled.blocks[0]!.priority === 0, "Task occurrence wins the priority tie");
    } finally { db.close(); }
  }

  console.log("== 9) Exact-scope projection is not capped by search limit 100 ==");
  {
    const db = new AppDatabase(":memory:");
    try {
      db.createSpace({ id: "root", name: "Root" });
      db.createSpace({ id: "bulk", name: "Bulk", parentId: "root" });
      const memory = new MemoryService(db, { semantic: false });
      for (let i = 0; i < 125; i++) createWorkspaceMemory(memory, "bulk", `bulk-${String(i).padStart(3, "0")}`);
      const svc = new WorkspaceSharedContextService(db);
      const exact = svc.listItemsForSpace("bulk");
      ok(exact.length === 125, `workspace exact projection returns all 125 memories, got ${exact.length}`);
      const rawScopeCount = Number((db.connection.prepare("SELECT COUNT(DISTINCT memory_id) n FROM memory_scopes WHERE scope_type='workspace' AND scope_id='bulk'").get() as { n: number }).n);
      ok(rawScopeCount === 125, "projection count matches authoritative memory_scopes count");
    } finally { db.close(); }
  }

  console.log("== 10) 现有 prompt-context 测试语义不回归（sanitizer/formatter 基础仍通过） ==");
  {
    // Minimal smoke: sanitize + formatter still work after workspace extension
    const svc = new PromptContextService({
      getArtifact: (id) => id === "art-A" ? ({ id: "art-A", taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor) : null,
      readContent: async (id) => id === "art-A" ? { content: '<div onclick="evil()">hello</div><script>alert(1)</script>', kind: "html" } : null,
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
    });
    const r = await svc.collect("art-A");
    ok(r.ok && (r.context.document?.excerpt?.includes("hello") ?? false), "prompt-context basic still works (sanitized hello)");
    ok(r.ok && !(r.context.document?.excerpt?.includes("evil") ?? true), "sanitizer still strips handler");
    // with workspace provider returning null, should still be ok
    const svc2 = new PromptContextService({
      getArtifact: (id) => id === "art-A" ? ({ id: "art-A", taskId: "t", kind: "html", source: { type: "managed-content", storagePath: "p", rootDir: "r" }, version: 1, capabilities: {}, createdAt: 0, updatedAt: 0 } as ArtifactDescriptor) : null,
      readContent: async (id) => id === "art-A" ? { content: "<p>hello</p>", kind: "html" } : null,
      getSelection: () => ({ status: "empty", descriptor: null, updatedAt: 0 }),
      getWorkspaceSharedContext: () => null,
    });
    const r2 = await svc2.collect("art-A");
    ok(r2.ok && !r2.context.workspaceSharedContext, "workspace null does not break collect");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
