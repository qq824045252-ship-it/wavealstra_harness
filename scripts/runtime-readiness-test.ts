/**
 * runtime-readiness 纯判定 + 采集测试（GUI 类分层 readiness：Blender / Ardot）。
 *
 * 覆盖：用户手开复用、无关进程占端口不假 ready、归属未知保守处理、
 * GUI alive / backend dead 不叠开第二实例、死亡 owned child、stopped 可安全 spawn、
 * 降级 ready（netstat 无结果但有应用进程）、collectGuiRuntimeInputs 采集组合。
 */
import {
  assessGuiRuntimeReadiness,
  collectGuiRuntimeInputs,
  type GuiRuntimeReadinessInput,
} from "../src/main/professional-tools/runtime-readiness";
import type { ProfessionalToolPlatformOps } from "../src/main/professional-tools/ProfessionalToolRuntime";

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

function input(patch: Partial<GuiRuntimeReadinessInput>): GuiRuntimeReadinessInput {
  return {
    tcpReady: false,
    ownerFound: false,
    ownerIsTarget: false,
    ownerIdentityUnknown: false,
    appProcessRunning: false,
    ownedChildAlive: false,
    ...patch,
  };
}

async function main(): Promise<void> {
  console.log("== 1) ready：TCP + 端口归属为目标应用 + GUI 可见（用户手开复用）==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: true, ownerIsTarget: true, appProcessRunning: true }));
    assert(v.ready === true && v.state === "ready" && v.appVisible && v.backendReady, "用户手开实例 → ready（复用，不重复 spawn）");
    assert(v.conflict === null, "无冲突");
  }

  console.log("== 1b) sidecar-only：TCP + 归属目标但 GUI 不可见 → 不 ready，可 spawn ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: true, ownerIsTarget: true, appProcessRunning: false }));
    assert(v.ready === false && v.state === "stopped" && v.conflict === null, "sidecar 在听但窗口未开 → stopped（允许启动 GUI）");
    assert(v.backendReady === true && v.appVisible === false, "backend ready、窗口不可见");
  }

  console.log("== 2) 无关进程占端口：TCP 可达但归属非目标 → 不假 ready ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: true, ownerIsTarget: false, appProcessRunning: false }));
    assert(v.ready === false && v.state === "error", "不判定 ready");
    assert(v.conflict === "port-occupied-other", "冲突 = port-occupied-other（不 spawn）");
  }

  console.log("== 3) 归属未知：netstat 有结果但 exe 查询失败 → 保守 error ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: true, ownerIsTarget: false, ownerIdentityUnknown: true, appProcessRunning: false }));
    assert(v.ready === false && v.conflict === "port-occupied-other", "归属未知 → 不假 ready、不 spawn");
  }

  console.log("== 4) GUI alive / backend dead：明确失败，禁止叠开第二实例 ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: false, appProcessRunning: true }));
    assert(v.ready === false && v.state === "error", "state=error（不是 stopped）");
    assert(v.conflict === "gui-no-backend", "冲突 = gui-no-backend（明确失败原因）");
    assert(v.appVisible === true && v.backendReady === false, "分层状态正确");
  }

  console.log("== 5) stopped：无应用、无端口 → 可安全 spawn ==");
  {
    const v = assessGuiRuntimeReadiness(input({}));
    assert(v.state === "stopped" && v.ready === false && v.conflict === null, "stopped 且无冲突（start 允许 spawn）");
  }

  console.log("== 6) starting：owned child 存活但 backend 未起 → 等待不叠开 ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: false, ownedChildAlive: true, appProcessRunning: true }));
    assert(v.state === "starting" && v.ready === false, "starting（等 backend）");
  }

  console.log("== 7) 死亡 owned child：不冒充 app 存活 ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: false, ownedChildAlive: false, appProcessRunning: false }));
    assert(v.state === "stopped", "死亡 owned child 不参与判定 → stopped");
  }

  console.log("== 8) 降级 ready：TCP 可达但 netstat 无结果 + 应用进程在跑 ==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: false, appProcessRunning: true }));
    assert(v.ready === true && v.detail.includes("降级"), "有应用进程证据 → 降级 ready");
  }

  console.log("== 9) TCP 可达但无应用进程且无归属 → error（防无关服务假 ready）==");
  {
    const v = assessGuiRuntimeReadiness(input({ tcpReady: true, ownerFound: false, appProcessRunning: false }));
    assert(v.ready === false && v.state === "error" && v.conflict === "port-occupied-other", "不假 ready");
  }

  console.log("== 10) collectGuiRuntimeInputs：用户手开 Blender（tasklist + 端口归属）==");
  {
    // 模拟：9876 由 blender.exe 监听；tasklist 发现 blender.exe
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [4242],
      pidExecutablePath: async (pid: number) => (pid === 4242 ? "C:\\Blender\\blender.exe" : null),
      runningPidsByImageName: async (name: string) => (name.toLowerCase() === "blender.exe" ? [4242] : []),
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, { host: "127.0.0.1", port: 9876, imageName: "blender.exe", ownedChild: null });
    assert(collected.tcpReady && collected.ownerFound && collected.ownerIsTarget, "端口归属确认为 blender.exe");
    const v = assessGuiRuntimeReadiness(collected);
    assert(v.ready === true, "手开 Blender → ready（复用）");
  }

  console.log("== 11) collect：无关服务占 9876（非 blender）→ 不假 ready ==");
  {
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [777],
      pidExecutablePath: async (pid: number) => (pid === 777 ? "C:\\Windows\\System32\\svchost.exe" : null),
      runningPidsByImageName: async () => [],
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, { host: "127.0.0.1", port: 9876, imageName: "blender.exe", ownedChild: null });
    const v = assessGuiRuntimeReadiness(collected);
    assert(v.ready === false && v.conflict === "port-occupied-other", "无关服务占 9876 → 不假 ready");
  }

  console.log("== 12) collect：owned child 即端口归属（MyBuddy spawn 场景）==");
  {
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [4242],
      pidExecutablePath: async () => null, // exe 查询失败，但 owned child 直接命中
      runningPidsByImageName: async () => [],
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, {
      host: "127.0.0.1",
      port: 9876,
      imageName: "blender.exe",
      ownedChild: { pid: 4242, killed: false },
    });
    assert(collected.ownerIsTarget === true, "owned child pid 直接确认归属");
    assert(collected.ownedChildAlive === true, "owned child 计为 GUI 存活");
    assert(assessGuiRuntimeReadiness(collected).ready === true, "MyBuddy spawn 的实例 → ready");
  }

  console.log("== 13) collect：GUI 已打开（tasklist 命中）但 backend 未起 ==");
  {
    const ops = {
      tcpReady: async () => false,
      listListeningPids: async () => [],
      pidExecutablePath: async () => null,
      runningPidsByImageName: async (name: string) => (name.toLowerCase() === "ardot.exe" ? [9999] : []),
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, { host: "127.0.0.1", port: 50501, imageName: "Ardot.exe", ownedChild: null });
    const v = assessGuiRuntimeReadiness(collected);
    assert(v.appVisible === true && v.conflict === "gui-no-backend", "手开 Ardot 但 50501 未起 → gui-no-backend");
  }

  console.log("== 14) collect：Ardot MCP sidecar 单独听 50501（无 Ardot.exe）→ 不 ready，可 spawn GUI ==");
  {
    const ardotRoot = "C:\\Users\\servi\\Desktop\\mybuddy\\MyBuddyTools\\Ardot";
    const sidecar = `${ardotRoot}\\resources\\ArdotMCP\\mcp-server.exe`;
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [26172],
      pidExecutablePath: async (pid: number) => (pid === 26172 ? sidecar : null),
      runningPidsByImageName: async () => [],
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, {
      host: "127.0.0.1",
      port: 50501,
      imageName: "Ardot.exe",
      ownerPathPrefixes: [ardotRoot],
      ownedChild: null,
    });
    assert(collected.ownerIsTarget === true, "安装树内 mcp-server.exe 视为 Ardot 归属（不误判占用）");
    assert(collected.appProcessRunning === false, "未扫到 Ardot.exe");
    const v = assessGuiRuntimeReadiness(collected);
    assert(v.ready === false && v.state === "stopped" && v.conflict === null, "sidecar-only 不 ready，允许拉起 GUI");
    assert(v.backendReady === true, "backend 仍记为 Ready");
  }

  console.log("== 14b) collect：sidecar + Ardot.exe 同时在 → ready ==");
  {
    const ardotRoot = "C:\\Users\\servi\\Desktop\\mybuddy\\MyBuddyTools\\Ardot";
    const sidecar = `${ardotRoot}\\resources\\ArdotMCP\\mcp-server.exe`;
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [26172],
      pidExecutablePath: async (pid: number) => (pid === 26172 ? sidecar : null),
      runningPidsByImageName: async (name: string) => (name.toLowerCase() === "ardot.exe" ? [1001] : []),
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, {
      host: "127.0.0.1",
      port: 50501,
      imageName: "Ardot.exe",
      ownerPathPrefixes: [ardotRoot],
      ownedChild: null,
    });
    assert(collected.appProcessRunning === true, "扫到 Ardot.exe");
    assert(assessGuiRuntimeReadiness(collected).ready === true, "窗口 + sidecar → ready");
  }

  console.log("== 15) collect：其它目录的 mcp-server.exe 占 50501 → 仍不假 ready ==");
  {
    const ops = {
      tcpReady: async () => true,
      listListeningPids: async () => [88],
      pidExecutablePath: async (pid: number) =>
        pid === 88 ? "C:\\OtherApp\\mcp-server.exe" : null,
      runningPidsByImageName: async () => [],
    } satisfies Pick<ProfessionalToolPlatformOps, "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName">;
    const collected = await collectGuiRuntimeInputs(ops, {
      host: "127.0.0.1",
      port: 50501,
      imageName: "Ardot.exe",
      ownerPathPrefixes: ["C:\\Users\\servi\\Desktop\\mybuddy\\MyBuddyTools\\Ardot"],
      ownedChild: null,
    });
    const v = assessGuiRuntimeReadiness(collected);
    assert(v.ready === false && v.conflict === "port-occupied-other", "非 Ardot 树内的 mcp-server.exe 仍拒绝 ready");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
