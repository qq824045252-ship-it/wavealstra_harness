/**
 * preset runtime contract 测试：working/coding Tag 的 requiredRuntimes 声明
 * 与目标策略一致（统一框架 + 每 Tag 不同 launch policy）。
 *
 * 断言：
 * - web-prototype（penpot）→ backend + http + 系统浏览器打开 9001；
 * - drawio-ai / 其它 preset → 零自动启动（不声明 requiredRuntimes）；
 * - Ardot / Blender / FreeCAD / OpenDesign Tag 已退役，不再出厂（design 模式已删除）。
 */
import { WORKING_MODE_PRESETS, CODING_MODE_PRESETS } from "../src/main/agent/mode-defaults";
import { resolveRuntimeRequirementList } from "../src/shared/runtime-requirement";

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

function requirementsFor(presetId: string, list: typeof WORKING_MODE_PRESETS) {
  const preset = list.find((p) => p.id === presetId);
  if (!preset) return { preset: undefined as typeof list[number] | undefined, requirements: [] as ReturnType<typeof resolveRuntimeRequirementList> };
  return { preset, requirements: resolveRuntimeRequirementList(preset.requiredRuntimes) };
}

async function main(): Promise<void> {
  console.log("== 1) Ardot / Blender / FreeCAD / OpenDesign Tag 已退役 ==");
  {
    for (const id of ["ai-ui", "3d-blender", "mechanical-cad", "opendesign", "general"]) {
      const { preset } = requirementsFor(id, WORKING_MODE_PRESETS);
      assert(preset === undefined, `${id} 不再出厂`);
    }
  }

  console.log("== 2) 服务类 Tag：backend + http ==");
  {
    const penpot = requirementsFor("web-prototype", WORKING_MODE_PRESETS).requirements.find((x) => x.providerId === "penpot");
    assert(penpot !== undefined, "web-prototype 声明 requiredRuntimes[penpot]");
    assert(penpot?.launchPolicy === "backend", "web-prototype → launchPolicy=backend（只起服务）");
    assert(penpot?.readinessPolicy === "http", "web-prototype → readinessPolicy=http");
    assert(penpot?.openUi === "browser", "web-prototype → openUi=browser（Ready 后系统浏览器打开 9001）");
  }

  console.log("== 3) 零自动启动：drawio-ai / 其它 preset ==");
  {
    const drawio = requirementsFor("drawio-ai", WORKING_MODE_PRESETS);
    assert(drawio.preset !== undefined && drawio.requirements.length === 0, "drawio-ai（流程图）零自动启动（进程由会话 adapter 托管）");
    for (const p of WORKING_MODE_PRESETS) {
      if (p.id === "web-prototype") continue;
      assert((p.requiredRuntimes ?? []).length === 0, `${p.id} 未声明 requiredRuntimes`);
    }
  }

  console.log("== 4) 旧 string 声明归一化：未知/已删除 provider 跳过 ==");
  {
    const r = resolveRuntimeRequirementList(["freecad"]);
    assert(r.length === 0, "已删除的 freecad provider string → 跳过");
    const penpot = resolveRuntimeRequirementList(["penpot"])[0];
    assert(penpot?.providerId === "penpot" && penpot.launchPolicy === "backend", "penpot string → provider 默认");
  }

  console.log("== 5) working/coding 除 Penpot 外不声明 runtime ==");
  {
    for (const p of [...WORKING_MODE_PRESETS, ...CODING_MODE_PRESETS]) {
      if (p.id === "web-prototype") continue;
      assert((p.requiredRuntimes ?? []).length === 0, `${p.id} 未声明 requiredRuntimes`);
    }
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
