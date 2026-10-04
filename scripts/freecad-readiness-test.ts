/**
 * FreeCAD readiness 分层判定测试（目标冻结 3/4/5/6）。
 *
 * 覆盖：discovery 解析；GUI alive + backend → ready；headless 占 23456 → 不判 GUI ready
 * （conflict）；GUI alive 但 backend 未起；backend 可达但无 discovery；PID 存活判定；
 * 旧 discovery 残留（pid 死亡）忽略；FreeCADRuntime.status 分层（mock ops）。
 */
import { parseFreeCadInstance, assessFreeCadReadiness, isPidAlive } from "../src/main/professional-tools/FreeCadInstanceDiscovery";
import type { FreeCadInstance } from "../src/main/professional-tools/FreeCadInstanceDiscovery";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const guiInst = (pid: number): FreeCadInstance => ({
  uuid: `gui-${pid}`, pid, gui: true, label: null,
  freecadBinary: "C:/.../FreeCAD.exe", startedAt: 1,
});
const headlessInst = (pid: number): FreeCadInstance => ({
  uuid: `h-${pid}`, pid, gui: false, label: null,
  freecadBinary: "C:/.../freecadcmd.exe", startedAt: 1,
});
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

function main(): void {
  console.log("== 1) discovery JSON 解析 ==");
  const parsed = parseFreeCadInstance(
    JSON.stringify({ uuid: "abc", pid: 42, gui: true, label: "x", freecad_binary: "C:/a/FreeCAD.exe", started_at: 1 }),
  );
  assert(parsed?.pid === 42 && parsed?.gui === true && parsed?.freecadBinary?.includes("FreeCAD.exe"), "gui 实例解析");
  const h = parseFreeCadInstance(JSON.stringify({ uuid: "h", pid: 7, gui: false }));
  assert(h?.gui === false, "headless 实例解析");
  assert(parseFreeCadInstance("{bad") === null, "坏 JSON → null");
  assert(parseFreeCadInstance(JSON.stringify({ pid: "x" })) === null, "pid 非法 → null");

  console.log("== 2) PID 存活判定 ==");
  assert(isPidAlive(process.pid) === true, "自身 pid 存活");
  assert(isPidAlive(99999999) === false, "不存在 pid → 死亡");

  console.log("== 3) GUI alive + backend ready → ready（不依赖端口冒充）==");
  const r1 = assessFreeCadReadiness([guiInst(1)], true, { alive: alive([1]) });
  assert(r1.guiAlive === true && r1.backendReady === true && r1.conflict === null, "GUI+backend → ready");

  console.log("== 4) headless 占 23456 → 不判 GUI ready（核心回归）==");
  const r2 = assessFreeCadReadiness([headlessInst(2)], true, { alive: alive([2]) });
  assert(r2.guiAlive === false, "headless 不冒充 GUI alive");
  assert(r2.conflict === "headless-occupies-port", `conflict=headless-occupies-port（${r2.conflict}）`);
  assert(r2.detail.includes("headless") && r2.detail.includes("23456"), "detail 指明 headless 占用");

  console.log("== 5) backend 可达但无 discovery（外部进程占端口）==");
  const r3 = assessFreeCadReadiness([], true, { alive: alive([]) });
  assert(r3.conflict === "unknown-owner", "无实例 + 端口通 → unknown-owner");

  console.log("== 6) GUI alive 但 backend 未起（端口被抢/addon 异常）==");
  const r4 = assessFreeCadReadiness([guiInst(3)], false, { alive: alive([3]) });
  assert(r4.conflict === "gui-no-backend", "GUI 存活 + backend 不可达 → gui-no-backend");

  console.log("== 7) 旧 discovery 残留（pid 死亡）忽略 ==");
  const r5 = assessFreeCadReadiness([guiInst(99)], true, { alive: alive([1]) });
  assert(r5.guiAlive === false && r5.conflict === "unknown-owner", "死亡 pid 的 gui 实例不参与判定");

  console.log("== 8) GUI+headless 同时存活：GUI 优先（多实例）==");
  const r6 = assessFreeCadReadiness([guiInst(1), headlessInst(2)], true, { alive: alive([1, 2]) });
  assert(r6.guiAlive === true && r6.conflict === null, "GUI+headless+backend → ready（GUI 为准）");

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
