/**
 * CadArtifactService 回归（FreeCAD 主链产物注册）：
 * - registerTechDrawArtifacts：techdraw.svg（svg）+ techdraw.fcstd（code）
 * - registerFcstdReadbackArtifacts：readback.json + readback.step
 * - producer 溯源（createdByMessageId/createdByToolCallId）、幂等不覆盖首次溯源、
 *   entryPathOf 存在、removeByTask 清理。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { CadArtifactService } from "../src/main/cad/CadArtifactService";
import { artifactKindForFile, isSupportedWorkspaceFile } from "../src/main/workspace/WorkspaceService";
import type { FcstdReadbackResult } from "../src/main/cad/CadTypes";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cad-artifact-test-"));
  const taskRoot = join(dir, "task-root");
  const storageRoot = join(dir, "artifacts");
  const readbackDir = join(taskRoot, "cad", "_fcstd_readback");
  const techdrawDir = join(taskRoot, "cad", "_techdraw");
  mkdirSync(readbackDir, { recursive: true });
  mkdirSync(techdrawDir, { recursive: true });
  writeFileSync(join(readbackDir, "readback.json"), "{}", "utf-8");
  writeFileSync(join(readbackDir, "readback.step"), "ISO-10303-21;\n", "utf-8");
  writeFileSync(join(techdrawDir, "techdraw.svg"), "<svg/>", "utf-8");
  writeFileSync(join(techdrawDir, "techdraw.fcstd"), Buffer.from("PK\x03\x04fakezip"), "utf-8");

  const db = new Database(join(dir, "app.db"));
  const storage = new ArtifactStorage(storageRoot);
  const repository = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  const service = new ArtifactService(storage, repository, registry);

  const readbackResult: FcstdReadbackResult = {
    summary: {
      fcstd: "part.fcstd", valid: true, document: "part", objectCount: 2, shapeObjectCount: 1,
      typeCounts: { "Part::Box": 1 }, objects: [], stepFile: join(readbackDir, "readback.step"), stepBytes: 10,
    },
    files: { readback: join(readbackDir, "readback.json"), step: join(readbackDir, "readback.step") },
    exitCode: 0,
    engine: "freecadcmd-readback",
  };

  try {
    console.log("== Workspace 扩展名支持 ==");
    for (const f of ["a.step", "b.stp", "c.fcstd", "d.fcstd", "e.stl", "f.svg", "g.blend", "h.html"]) {
      assert(isSupportedWorkspaceFile(join(taskRoot, f)), `支持 ${f}`);
    }
    assert(artifactKindForFile("x.step") === "code", "STEP 按文本 code 处理（不按二进制）");
    assert(artifactKindForFile("x.fcstd") === "cad", "FCStd 按 cad（二进制）处理");
    assert(artifactKindForFile("x.blend") === "cad", "Blender 按 cad（二进制）处理");
    assert(artifactKindForFile("x.html") === "html", "HTML 仍按 html 处理");

    console.log("== FCStd 读回产物注册（含 producer 溯源）==");
    const cadArtifacts = new CadArtifactService({ artifactService: service });
    const registered = await cadArtifacts.registerFcstdReadbackArtifacts(
      "task-1", taskRoot, readbackResult,
      { messageId: "msg-rb-1", toolCallId: "tc-rb-1" },
    );
    assert(registered.length === 2, `注册 readback.json + readback.step（实际 ${registered.length}）`);
    const rbArtifact = service.findByEntryFile("task-1", join(readbackDir, "readback.json"));
    assert(rbArtifact !== null, "readback.json 可被 findByEntryFile 命中");
    assert(rbArtifact.capabilities?.originalKind === "fcstd-readback", "capabilities.originalKind=fcstd-readback");
    assert(rbArtifact.createdByMessageId === "msg-rb-1", "createdByMessageId 溯源（msg-rb-1）");
    assert(rbArtifact.createdByToolCallId === "tc-rb-1", "createdByToolCallId 溯源（tc-rb-1）");
    const stepArtifact = service.findByEntryFile("task-1", join(readbackDir, "readback.step"));
    assert(stepArtifact?.capabilities?.originalKind === "fcstd-readback-step", "readback.step originalKind");
    const entryPath = service.entryPathOf(rbArtifact!.id);
    assert(entryPath !== null && existsSync(entryPath), "entryPathOf 返回存在的文件路径");

    console.log("== TechDraw 产物注册 ==");
    const td = await cadArtifacts.registerTechDrawArtifacts(
      "task-1", taskRoot,
      { svg: join(techdrawDir, "techdraw.svg"), fcstd: join(techdrawDir, "techdraw.fcstd") },
      { messageId: "msg-td-2", toolCallId: "tc-td-2" },
    );
    assert(td.length === 2, "注册 techdraw.svg + techdraw.fcstd");
    const svgArtifact = service.findByEntryFile("task-1", join(techdrawDir, "techdraw.svg"));
    assert(svgArtifact?.kind === "svg" && svgArtifact.capabilities?.originalKind === "techdraw-svg", "svg kind/originalKind");

    console.log("== 幂等：重复注册不产生 duplicate，且不覆盖首次溯源 ==");
    const before = service.listByTask("task-1").length;
    await cadArtifacts.registerFcstdReadbackArtifacts(
      "task-1", taskRoot, readbackResult,
      { messageId: "msg-rb-3", toolCallId: "tc-rb-3" },
    );
    assert(service.listByTask("task-1").length === before, "重复注册幂等（无 duplicate row）");
    const refreshed = service.findByEntryFile("task-1", join(readbackDir, "readback.json"));
    assert(refreshed?.createdByMessageId === "msg-rb-1", "幂等刷新不覆盖 createdByMessageId（保持首次溯源）");
    assert(refreshed?.createdByToolCallId === "tc-rb-1", "幂等刷新不覆盖 createdByToolCallId");

    console.log("== removeByTask 清理 ==");
    const beforeRemove = service.listByTask("task-1").length;
    service.removeByTask("task-1");
    assert(service.listByTask("task-1").length === 0, `removeByTask 清空 ${beforeRemove} 条`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n结果: passed=%d failed=%d", passed, failed);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
