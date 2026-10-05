/**
 * FreeCAD MCP 选型契约测试（目标 B/E）：
 * - mechanical-cad preset 声明 requiredRuntimes: ["freecad"]；
 * - freecad 是受管 provider（MANAGED_TOOL_PROVIDER_IDS）；
 * - side-effect policy：freecad = task-write 不每步审批；execute_python 强制审批；
 * - 不残留 neka uvx 配置路径（mcp.json 由用户环境管理，此处校验代码侧契约）。
 */
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_TOOL_PROVIDER_IDS, isManagedToolProvider } from "../src/shared/professional-tools";import {
  getDefaultMcpSideEffectRegistry,
  MANAGED_RUNTIME_DANGEROUS_TOOLS,
  parseMcpToolIdentity,
} from "../src/main/security/McpSideEffectPolicy";
import { resolveModePreset, type ModeProfileDto } from "../src/shared/mode-profile";

let passed = 0;
let failed = 0;
const root = process.cwd(); // 测试恒在项目根目录运行
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function main(): void {
  console.log("== 1) mechanical-cad preset 已退役 ==");
  const profile = MODE_SEEDS.bot;
  const preset = resolveModePreset(profile.policy, "mechanical-cad");
  assert(preset === undefined, "mechanical-cad preset 已退役，不可解析");
  assert(
    !(profile.policy.presets ?? []).some(
      (p) => p.id === "mechanical-cad" || p.id === "ai-ui" || p.id === "3d-blender" || p.id === "opendesign",
    ),
    "design 出厂不再含 Ardot/Blender/FreeCAD/OpenDesign Tag",
  );

  console.log("== 2) freecad 已从受管专业工具删除 ==");
  assert(!(MANAGED_TOOL_PROVIDER_IDS as readonly string[]).includes("freecad"), "freecad ∉ MANAGED_TOOL_PROVIDER_IDS");
  assert(!isManagedToolProvider("freecad"), "isManagedToolProvider(freecad) = false");

  console.log("== 3) side-effect policy：freecad 不再按受管 runtime 放行 ==");
  const registry = getDefaultMcpSideEffectRegistry();
  const structured = registry.evaluateToolCall({
    providerId: "freecad",
    toolName: "sketch_operations",
    args: { operation: "add_constraint" },
  });
  assert(structured.requiresApproval === true, `sketch_operations 需审批（${structured.reason}）`);
  const save = registry.evaluateToolCall({
    providerId: "freecad",
    toolName: "view_control",
    args: { operation: "save_document", filename: "C:/x/y.FCStd" },
  });
  assert(save.requiresApproval === true, "view_control save 需审批（freecad 已非受管）");

  console.log("== 4) execute_python 在危险集合（escape hatch 强审批）==");
  const dangerous = MANAGED_RUNTIME_DANGEROUS_TOOLS.get("freecad");
  assert(dangerous?.has("execute_python") === true, "execute_python ∈ dangerous");
  assert(dangerous?.has("execute_python_async") === true, "execute_python_async ∈ dangerous");
  assert(dangerous?.has("sketch_operations") === false, "sketch_operations ∉ dangerous");

  console.log("== 5) 工具名解析：freecad_xxx / mcp__freecad_xxx 双前缀 ==");
  assert(
    parseMcpToolIdentity("freecad_sketch_operations")?.providerId === "freecad",
    "freecad_sketch_operations → provider freecad",
  );
  assert(
    parseMcpToolIdentity("mcp__freecad_sketch_operations")?.providerId === "freecad",
    "mcp__freecad_sketch_operations → provider freecad",
  );
  assert(parseMcpToolIdentity("cad_plan") === null, "cad_* native 不误判为 MCP");

  console.log("== 6) Tag 选择 IPC → prewarm 契约 ==");
  const ipc = readFileSync(join(root, "src/shared/agent-ipc.ts"), "utf8");
  assert(ipc.includes('selectModePreset: "agent:selectModePreset"'), "AgentIpc.selectModePreset 存在");
  assert(ipc.includes("getRuntimeRequirementStates"), "AgentIpc.getRuntimeRequirementStates 存在");
  assert(ipc.includes("startRuntimeRequirement"), "AgentIpc.startRuntimeRequirement 存在");
  assert(ipc.includes("stopRuntimeRequirement"), "AgentIpc.stopRuntimeRequirement 存在");
  assert(ipc.includes("restartRuntimeRequirement"), "AgentIpc.restartRuntimeRequirement 存在");
  assert(ipc.includes("interface RuntimeRequirementStateDto"), "RuntimeRequirementStateDto 类型存在");
  const agentSvc = readFileSync(join(root, "src/main/agent/AgentService.ts"), "utf8");
  assert(agentSvc.includes("onModePresetSelected("), "AgentService.onModePresetSelected 存在");
  assert(agentSvc.includes("listRuntimeRequirementStates("), "AgentService.listRuntimeRequirementStates 存在");
  assert(agentSvc.includes("startRuntimeRequirement("), "AgentService.startRuntimeRequirement 存在");
  assert(agentSvc.includes("stopRuntimeRequirement("), "AgentService.stopRuntimeRequirement 存在");
  const preload = readFileSync(join(root, "src/preload/index.ts"), "utf8");
  assert(preload.includes("selectModePreset") && preload.includes("getRuntimeRequirementStates"), "preload 暴露两个方法");
  assert(preload.includes("startRuntimeRequirement") && preload.includes("stopRuntimeRequirement"), "preload 暴露手动启停");
  const appStoreSource = readFileSync(join(root, "src/renderer/src/store/appStore.ts"), "utf8");
  assert(appStoreSource.includes("selectModePreset"), "appStore.setModePreset 通知主进程");
  const hubRuntime = readFileSync(join(root, "src/renderer/src/components/hub/ManagedMcpRuntimeBar.tsx"), "utf8");
  assert(hubRuntime.includes("startRuntimeRequirement"), "插件 MCP 卡片调用手动启动");
  assert(hubRuntime.includes("stopRuntimeRequirement"), "插件 MCP 卡片调用手动停止");
  assert(hubRuntime.includes("hub-mcp-runtime"), "插件 MCP 卡片有本机服务启停条");
  assert(hubRuntime.includes("重试") && hubRuntime.includes("启动"), "插件 MCP 卡片暴露启动/重试按钮");
  const hubPage = readFileSync(join(root, "src/renderer/src/components/pages/HubPage.tsx"), "utf8");
  assert(hubPage.includes("ManagedMcpRuntimeBar"), "Hub MCP 已装卡片挂载本机服务启停");
  const sidebar = readFileSync(join(root, "src/renderer/src/components/Sidebar.tsx"), "utf8");
  assert(!sidebar.includes("扩展软件"), "账户菜单不再有扩展软件入口");
  const app = readFileSync(join(root, "src/renderer/src/App.tsx"), "utf8");
  assert(!app.includes("RuntimeContextInspector"), "扩展软件调试台不再挂到主界面");

  console.log("== 7) FreeCADRuntime 已从受管专业工具删除 ==");
  const rt = readFileSync(join(root, "src/main/professional-tools/ProfessionalToolRuntime.ts"), "utf8");
  assert(!rt.includes("class FreeCADRuntime"), "FreeCADRuntime 已删除");
  assert(!rt.includes('readonly executableName = "FreeCAD.exe"'), "不再注册 FreeCAD.exe runtime");
  const discovery = readFileSync(join(root, "src/main/professional-tools/FreeCadInstanceDiscovery.ts"), "utf8");
  assert(discovery.includes("gui") && discovery.includes("freecad_binary"), "discovery 解析模块仍保留给 CAD 互操作");

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
