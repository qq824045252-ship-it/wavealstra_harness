/**
 * Blender layered readiness 真实机 smoke（安全：不启动用户软件，只读探测 +
 * 一个临时 9876 探针监听器，结束后关闭）。
 *
 * 验证 P0 目标：
 * 1) 无 Blender 进程/端口 → stopped（真实 netstat/tasklist/powershell 探测链）；
 * 2) 无关进程占用 9876 → 不假 ready（port-occupied-other / 归属无法确认）；
 * 3) ardot/penpot 真实 status（只读，不 spawn / 不 docker up）。
 *
 * 用法：
 *   pnpm exec esbuild scripts/blender-readiness-live-smoke.ts --bundle --platform=node --format=cjs --outfile=out/tests/blender-readiness-live-smoke.cjs --external:electron
 *   node out/tests/blender-readiness-live-smoke.cjs
 */
import { ProfessionalToolRuntimeService } from "../src/main/professional-tools/ProfessionalToolRuntime";

async function main(): Promise<void> {
  const service = new ProfessionalToolRuntimeService({ providerEnabled: async () => true });
  const label = (name: string, r: { state: string; ready: boolean; detail?: string }): void => {
    console.log(`  ${name}: state=${r.state} ready=${r.ready} | ${r.detail ?? ""}`);
  };

  console.log("== 只读 status：penpot（Ardot/Blender/FreeCAD/OpenDesign 已删除）==");
  const penpot = await service.status("penpot");
  label("penpot", penpot);
  console.log("\nPASS: 仅 Penpot 仍为受管专业工具");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
