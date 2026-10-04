/**
 * CAD 扩展注入回归（FreeCAD-only 主链，6 工具）：
 * - 注册面 = cad_open_freecad / cad_route / cad_plan / cad_techdraw /
 *   cad_fcstd_readback / cad_freecad_run（无 kernel 工具）；
 * - cad_freecad_run 审批链（拒绝/放行/dangerous 标记/auto 放行）；
 * - producer 溯源透传（techdraw/fcstd_readback 经 runtime facade）；
 * - 路径参数 taskRoot 边界。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCadExtension } from "../src/main/cad/cad-extension";
import type { CadRuntimeService } from "../src/main/cad/CadRuntimeService";
import type { CadArtifactService } from "../src/main/cad/CadArtifactService";
import type { FreeCadInterop } from "../src/main/cad/FreeCadInterop";

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

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: never, signal?: AbortSignal) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

function fakeApi(): { api: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool: (tool: never) => {
      tools.push(tool as unknown as RegisteredTool);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  return { api, tools };
}

function fakeRuntime(overrides: Partial<CadRuntimeService> = {}): CadRuntimeService {
  return {
    installed: true,
    releaseTask: async () => undefined,
    shutdownAll: async () => undefined,
    techdraw: async () => ({ files: {}, format: "svg", exitCode: 0, engine: "freecadcmd-techdraw" }),
    fcstdReadback: async () => ({
      summary: {
        fcstd: "part.fcstd", valid: true, document: "part", objectCount: 2, shapeObjectCount: 1,
        typeCounts: { "Part::Box": 1 }, objects: [], stepFile: "readback.step", stepBytes: 10,
      },
      files: {}, exitCode: 0, engine: "freecadcmd-readback",
    }),
    ...overrides,
  } as unknown as CadRuntimeService;
}

function makeBridge(overrides: Partial<Parameters<typeof createCadExtension>[0]> = {}) {
  const approvals: Array<{ toolName: string; dangerous: boolean }> = [];
  const bridge = {
    taskId: "task-1",
    taskRoot: "C:/task-root",
    runtime: fakeRuntime(),
    artifacts: null as CadArtifactService | null,
    freeCad: {
      available: true,
      freeCadCmdPath: () => "C:/FreeCAD/bin/freecadcmd.exe",
      runScript: async () => ({ exitCode: 0, stdout: "done", stderr: "", scriptPath: "x.py" }),
    } as unknown as FreeCadInterop,
    getPermissionMode: () => "ask" as const,
    getProducerMessageId: () => "msg-42" as string | undefined,
    requestApproval: async (info: { toolName: string; dangerous: boolean }) => {
      approvals.push(info);
      return true;
    },
    ...overrides,
  };
  return { bridge, approvals };
}

const EXPECTED_TOOLS = [
  "cad_open_freecad", "cad_route", "cad_plan", "cad_techdraw", "cad_fcstd_readback", "cad_freecad_run",
];

(async () => {
  console.log("== 工具注册（FreeCAD-only 6 工具）==");
  const { api, tools } = fakeApi();
  createCadExtension(makeBridge().bridge)(api);
  const names = tools.map((t) => t.name);
  for (const expected of EXPECTED_TOOLS) {
    assert(names.includes(expected), `注册 ${expected}`);
  }
  assert(tools.length === EXPECTED_TOOLS.length, `共 ${EXPECTED_TOOLS.length} 个 cad_* 工具（实际 ${tools.length}：${names.join(",")}）`);
  for (const removed of ["cad_create", "cad_validate", "cad_execute", "cad_export", "cad_glb", "cad_assembly_create"]) {
    assert(!names.includes(removed), `不注册已移除工具 ${removed}`);
  }
  for (const t of tools) {
    assert(t.parameters !== undefined, `${t.name} 有 TypeBox 参数 schema`);
  }

  console.log("== cad_plan 执行（新契约：read/spec/build/verify/export）==");
  {
    const apiP = fakeApi();
    createCadExtension(makeBridge().bridge)(apiP.api);
    const planTool = apiP.tools.find((t) => t.name === "cad_plan")!;
    const result = await planTool.execute("tc-plan", { goal: "做一个带中心孔的支架" } as never);
    const text = result.content[0].text;
    assert(!result.isError, "cad_plan 成功执行");
    assert(text.includes("引擎计划: freecad"), "plan 引擎=freecad");
    assert(text.includes("Sketcher") && text.includes("PartDesign"), "plan 建模步骤为 Sketcher/PartDesign");
    assert(text.includes("验证 gate: cad_fcstd_readback"), "plan verify gate=fcstd_readback");
    const plan = result.details as { modelingSteps?: unknown[] };
    assert((plan.modelingSteps?.length ?? 0) >= 4, "建模步骤 >= 4（read/spec/build/verify/export）");
  }

  console.log("== cad_freecad_run 审批链 ==");
  {
    // 拒绝
    const { bridge: rejectBridge, approvals } = makeBridge({
      requestApproval: async (info) => {
        approvals.push(info as unknown as { toolName: string; dangerous: boolean });
        return false;
      },
    });
    const api2 = fakeApi();
    createCadExtension(rejectBridge)(api2.api);
    const runTool = api2.tools.find((t) => t.name === "cad_freecad_run")!;
    const denied = await runTool.execute("tc-2", { script: "print('x')" } as never);
    assert(denied.isError === true && denied.content[0].text.includes("拒绝"), "未审批 → 拒绝执行");
    assert(approvals.length === 1 && approvals[0].dangerous === true, "审批请求标记 dangerous");

    // auto 模式直接放行（escape hatch）
    const { bridge: autoBridge, approvals: autoApprovals } = makeBridge({
      getPermissionMode: () => "auto" as const,
    });
    const api3 = fakeApi();
    createCadExtension(autoBridge)(api3.api);
    const runTool3 = api3.tools.find((t) => t.name === "cad_freecad_run")!;
    const allowed = await runTool3.execute("tc-3", { script: "print('done')" } as never);
    assert(!allowed.isError, "auto 模式直接执行");
    assert(autoApprovals.length === 0, "auto 模式不弹审批");

    // FreeCAD 不可用 → 受控错误
    const { bridge: noFcBridge } = makeBridge({ freeCad: null });
    const api3b = fakeApi();
    createCadExtension(noFcBridge)(api3b.api);
    const runTool3b = api3b.tools.find((t) => t.name === "cad_freecad_run")!;
    const noFc = await runTool3b.execute("tc-3b", { script: "print('x')" } as never);
    assert(noFc.isError === true, "FreeCAD 不可用时受控错误");
  }

  console.log("== producer 溯源（fcstd_readback → runtime facade）==");
  {
    let received: { producer?: { messageId?: string; toolCallId?: string } } | undefined;
    const runtime = fakeRuntime();
    const orig = runtime.fcstdReadback.bind(runtime);
    runtime.fcstdReadback = (async (tid: string, root: string, file: string, cmd?: string, options?: { producer?: { messageId?: string; toolCallId?: string } }) => {
      received = options;
      return orig(tid, root, file, cmd, options);
    }) as CadRuntimeService["fcstdReadback"];
    const apiP = fakeApi();
    createCadExtension(makeBridge({ runtime }).bridge)(apiP.api);
    const rbTool = apiP.tools.find((t) => t.name === "cad_fcstd_readback")!;
    const result = await rbTool.execute("tc-rb", { fcstd_file: "part.fcstd" } as never);
    assert(!result.isError, "fcstd_readback 成功执行");
    assert(
      received?.producer?.messageId === "msg-42" && received?.producer?.toolCallId === "tc-rb",
      "producer 溯源透传（messageId=msg-42, toolCallId=tc-rb）",
    );
  }

  console.log("== 路径参数 taskRoot 边界 ==");
  {
    const api4 = fakeApi();
    createCadExtension(makeBridge().bridge)(api4.api);
    const rbTool = api4.tools.find((t) => t.name === "cad_fcstd_readback")!;
    const bad = await rbTool.execute("tc-4", { fcstd_file: "../../../etc/passwd" } as never);
    assert(bad.isError === true, "非法路径被拒绝（taskRoot 边界）");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
