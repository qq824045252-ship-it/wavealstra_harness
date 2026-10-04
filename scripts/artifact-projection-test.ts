/**
 * Artifact Projection Reducer Tests — V3.5 Wave 3A（3A.4/3A.5）
 *
 * 覆盖：stale-race guard（revision）、created 幂等 append、updated 不换位、
 * removed 删除、未加载 task 事件忽略、snapshot 落后 → applied=false（重拉收敛）、
 * task A/B/A 切换稳定。
 *
 * 运行：pnpm test:artifact-projection（esbuild bundle → node）
 */
import {
  applyArtifactSnapshot,
  applyArtifactEvent,
  createInitialArtifactProjection,
  isSnapshotAccepted,
  reduceArtifactProjection,
  type ArtifactProjection,
} from "../src/shared/artifact-projection";
import type {
  ArtifactCreatedEvent,
  ArtifactDescriptor,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
} from "../src/shared/artifact-types";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

let seq = 0;
function makeDescriptor(taskId: string, title: string): ArtifactDescriptor {
  seq += 1;
  return {
    id: `art-${seq}`,
    taskId,
    kind: "markdown",
    source: { type: "managed-content", storagePath: `${taskId}/art-${seq}/index.md`, rootDir: "root" },
    version: 1,
    capabilities: {},
    title,
    createdAt: seq,
    updatedAt: seq,
  };
}

function makeSnapshot(taskId: string, revision: number, descriptors: ArtifactDescriptor[]): ArtifactSnapshot {
  return { taskId, artifacts: descriptors, revision, state: "ready" };
}

function makeCreated(taskId: string, revision: number, descriptor: ArtifactDescriptor): ArtifactCreatedEvent {
  return { artifactId: descriptor.id, taskId, version: descriptor.version, revision, descriptor };
}

function makeUpdated(taskId: string, revision: number, descriptor: ArtifactDescriptor): ArtifactUpdatedEvent {
  return { artifactId: descriptor.id, taskId, version: descriptor.version, revision, descriptor };
}

function makeRemoved(taskId: string, revision: number, artifactId: string): ArtifactRemovedEvent {
  return { artifactId, taskId, revision };
}

function main(): void {
  // ---------- P1: snapshot 基础 ----------
  {
    const a = makeDescriptor("t1", "A");
    const b = makeDescriptor("t1", "B");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "setLoadState", taskId: "t1", state: "loading" });
    const snap = makeSnapshot("t1", 5, [a, b]);
    const { state: p2, applied } = applyArtifactSnapshot(p, snap);
    check("P1a snapshot(rev=5) 接受", applied === true);
    check("P1b 数组替换 + state=ready", p2.artifactLoadState["t1"] === "ready" && p2.artifactsByTask["t1"]?.length === 2);
    check("P1c revision 记录", p2.artifactRevisions["t1"] === 5);
    // 同 revision 重复 → 接受（全量幂等 replace）；更旧 → 拒绝（applied=false）
    const { applied: applied2 } = applyArtifactSnapshot(p2, makeSnapshot("t1", 5, []));
    const { applied: applied3 } = applyArtifactSnapshot(p2, makeSnapshot("t1", 4, []));
    check("P1d snapshot(rev=5) 重复 → 接受（全量幂等 replace）", applied2 === true && p2.artifactsByTask["t1"]?.length === 2);
    check("P1e snapshot(rev=4) 旧 → 拒绝", applied3 === false);
    check("P1f isSnapshotAccepted 一致", isSnapshotAccepted(p2, makeSnapshot("t1", 6, [])) === true);
  }

  // ---------- P2: created 幂等 append + 未加载忽略 ----------
  {
    const a = makeDescriptor("t2", "A");
    let p = createInitialArtifactProjection();
    // 未加载 task → 忽略
    p = applyArtifactEvent(p, { type: "created", event: makeCreated("t2", 1, a) });
    check("P2a 未加载 task 的 created 忽略", p.artifactsByTask["t2"] === undefined);
    // 加载后 apply
    p = reduceArtifactProjection(p, { type: "setLoadState", taskId: "t2", state: "loading" });
    p = applyArtifactEvent(p, { type: "created", event: makeCreated("t2", 1, a) });
    check("P2b created 追加", p.artifactsByTask["t2"]?.length === 1 && p.artifactRevisions["t2"] === 1);
    // 同 id 再 created（同 revision 或更高）→ 不重复
    p = applyArtifactEvent(p, { type: "created", event: makeCreated("t2", 2, a) });
    check("P2c 同 id created 不双份", p.artifactsByTask["t2"]?.length === 1, `n=${p.artifactsByTask["t2"]?.length}`);
    check("P2d revision 前进到 2", p.artifactRevisions["t2"] === 2);
  }

  // ---------- P3: updated replace 不换位 ----------
  {
    const a = makeDescriptor("t3", "A");
    const b = makeDescriptor("t3", "B");
    const c = makeDescriptor("t3", "C");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("t3", 3, [a, b, c]) });
    const b2 = { ...b, version: 2, title: "B-v2" };
    p = applyArtifactEvent(p, { type: "updated", event: makeUpdated("t3", 4, b2) });
    const list = p.artifactsByTask["t3"] ?? [];
    check("P3a updated 按 id replace", list[1]?.id === b.id && list[1]?.version === 2 && list[1]?.title === "B-v2");
    check("P3b FIFO 位置不变", list.map((x) => x.id).join(",") === `${a.id},${b.id},${c.id}`);
    // id 不存在 → 忽略
    const ghost = makeDescriptor("t3", "Ghost");
    const before = p.artifactsByTask["t3"]?.length;
    p = applyArtifactEvent(p, { type: "updated", event: makeUpdated("t3", 5, ghost) });
    check("P3c 未知 id updated 忽略（不 append）", (p.artifactsByTask["t3"]?.length ?? 0) === before);
  }

  // ---------- P4: removed 删除 + 位置保持 ----------
  {
    const a = makeDescriptor("t4", "A");
    const b = makeDescriptor("t4", "B");
    const c = makeDescriptor("t4", "C");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("t4", 3, [a, b, c]) });
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("t4", 4, b.id) });
    const list = p.artifactsByTask["t4"] ?? [];
    check("P4a removed 删除中位", list.map((x) => x.id).join(",") === `${a.id},${c.id}`);
    check("P4b revision 前进", p.artifactRevisions["t4"] === 4);
  }

  // ---------- P5: stale-race —— 增量事件先到、旧 snapshot 后到（重拉收敛语义） ----------
  {
    const a = makeDescriptor("t5", "A");
    const b = makeDescriptor("t5", "B");
    const c = makeDescriptor("t5", "C");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "setLoadState", taskId: "t5", state: "loading" });
    // 事件先到（revision 7）—— snapshot 6 仍在路上
    p = applyArtifactEvent(p, { type: "created", event: makeCreated("t5", 7, c) });
    check("P5a loading 期间 created(rev=7) apply", p.artifactsByTask["t5"]?.length === 1 && p.artifactRevisions["t5"] === 7);
    // 旧 snapshot(rev=6) 后到 → 拒绝（applied=false，调用方应重新 hydrate）
    const { applied } = applyArtifactSnapshot(p, makeSnapshot("t5", 6, [a, b]));
    check("P5b 旧 snapshot(rev=6) 拒绝，不覆盖已 apply 事件", applied === false && p.artifactsByTask["t5"]?.length === 1);
    // 重新 hydrate 返回最新 snapshot(rev=7) → 接受并全量替换
    const { state: p2, applied: applied2 } = applyArtifactSnapshot(p, makeSnapshot("t5", 7, [a, b, c]));
    check("P5c 重新 hydrate snapshot(rev=7) 接受（幂等收敛）", applied2 === true && p2.artifactsByTask["t5"]?.length === 3);
  }

  // ---------- P6: task A/B/A 切换稳定 + clearTask ----------
  {
    const a1 = makeDescriptor("A", "A1");
    const a2 = makeDescriptor("A", "A2");
    const b1 = makeDescriptor("B", "B1");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("A", 2, [a1, a2]) });
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("B", 1, [b1]) });
    check("P6a A/B 独立投影", p.artifactsByTask["A"]?.length === 2 && p.artifactsByTask["B"]?.length === 1);
    // 切回 A：events 仍按 revision guard 生效
    p = applyArtifactEvent(p, { type: "created", event: makeCreated("A", 3, makeDescriptor("A", "A3")) });
    check("P6b 切回 A 后事件正确追加", p.artifactsByTask["A"]?.length === 3 && p.artifactRevisions["A"] === 3);
    // B 的事件不影响 A
    const aBefore = p.artifactsByTask["A"]?.length;
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("B", 2, b1.id) });
    check("P6c B 事件不影响 A", p.artifactsByTask["A"]?.length === aBefore && p.artifactsByTask["B"]?.length === 0);
    // clearTask
    p = reduceArtifactProjection(p, { type: "clearTask", taskId: "A" });
    check("P6d clearTask 清空 A 全部字段", p.artifactsByTask["A"] === undefined && p.artifactRevisions["A"] === undefined && p.artifactLoadState["A"] === undefined);
  }

  // ---------- P7: removed 同 revision 批量（3B.6 task 删除广播） ----------
  {
    const a = makeDescriptor("t7", "A");
    const b = makeDescriptor("t7", "B");
    const c = makeDescriptor("t7", "C");
    let p = createInitialArtifactProjection();
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("t7", 10, [a, b, c]) });
    // task 批量删除：多个 removed 共享同 revision
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("t7", 11, a.id) });
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("t7", 11, b.id) });
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("t7", 11, c.id) });
    check("P7a 同 revision 批量 removed 全部生效", (p.artifactsByTask["t7"]?.length ?? 0) === 0);
    check("P7b revision 保持 11", p.artifactRevisions["t7"] === 11);
    // 更旧的 removed 拒绝
    p = reduceArtifactProjection(p, { type: "snapshot", snapshot: makeSnapshot("t7", 12, [a]) });
    p = applyArtifactEvent(p, { type: "removed", event: makeRemoved("t7", 11, a.id) });
    check("P7c stale removed（rev<current）拒绝", p.artifactsByTask["t7"]?.length === 1);
  }

  // ---------- 汇总 ----------
  const failed = results.filter(([, pass]) => !pass);
  console.log(`\n===== Artifact Projection: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const [name, , detail] of failed) console.log(`  - ${name}${detail ? ` (${detail})` : ""}`);
    process.exitCode = 1;
  }
}

main();
