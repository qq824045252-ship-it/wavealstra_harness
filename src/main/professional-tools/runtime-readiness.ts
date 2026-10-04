/**
 * runtime-readiness — GUI 类 Runtime（Blender / Ardot / FreeCAD 模式）的分层 readiness
 * 纯判定逻辑与 Windows 探测采集。
 *
 * 分层模型（对齐 FreeCAD 既有语义，推广到所有 desktop-gui 类 provider）：
 *   A. app-visible   — 目标应用进程真实存在（用户手开或 MyBuddy spawn，不含误判）；
 *   B. backend-ready — MCP bridge 端口可达，且**端口归属是目标应用**（无关进程占端口
 *                      不得假 ready；归属未知时保守处理）。
 * 纯函数 assessGuiRuntimeReadiness 只吃布尔输入，可单测全部组合；探测采集
 * collectGuiRuntimeInputs 走注入的 ops（netstat/tasklist/wmic），测试可 mock。
 *
 * 边界纪律：绝不杀外部用户进程；只清理明确由 MyBuddy owned 的残留（由 Runtime 层
 * stopOwned 处理，本模块不做任何 kill）。
 */
import type { ProfessionalToolPlatformOps } from "./ProfessionalToolRuntime";
import { basename } from "node:path";

export type GuiRuntimeConflict =
  /** 端口被无关进程占用（归属非目标应用或无法确认） */
  | "port-occupied-other"
  /** 应用进程可见但 backend bridge 未 Ready（addon/服务未起或端口被占） */
  | "gui-no-backend"
  | null;

export interface GuiRuntimeReadinessInput {
  /** backend 端口 TCP 可达 */
  tcpReady: boolean;
  /** netstat 找到了监听该端口的 pid */
  ownerFound: boolean;
  /** 端口归属 pid 的可执行文件是目标应用（或 owned child） */
  ownerIsTarget: boolean;
  /** netstat 有结果但可执行文件查询失败（无法确认归属） */
  ownerIdentityUnknown: boolean;
  /** 目标应用进程在运行（任务列表 / owned child） */
  appProcessRunning: boolean;
  /** MyBuddy spawn 的子进程仍存活 */
  ownedChildAlive: boolean;
}

export interface GuiRuntimeReadinessVerdict {
  state: "ready" | "starting" | "stopped" | "error";
  ready: boolean;
  appVisible: boolean;
  backendReady: boolean;
  conflict: GuiRuntimeConflict;
  detail: string;
}

/**
 * 纯判定：分层 readiness 决策（唯一业务语义，测试全覆盖）。
 *
 * 规则（保守优先，杜绝假 ready 与叠开第二实例）：
 * - tcp 可达 && 归属为目标应用 && GUI 进程可见 → ready；
 * - tcp 可达 && 归属为目标应用 && GUI 不可见 → stopped（sidecar-only，可 spawn 窗口）；
 * - tcp 可达 && 归属为其它进程 → error（port-occupied-other）：不 ready、不 spawn；
 * - tcp 可达 && 归属无法确认（netstat 有结果但 exe 查询失败）→ error（port-occupied-other）；
 * - tcp 可达 && netstat 无结果（探测失败/竞态）→ 仅当应用进程可见时降级 ready（degraded），
 *   否则 error（不假 ready）；
 * - tcp 不可达 && 应用进程可见 → error（gui-no-backend）：明确失败原因，禁止叠开第二实例；
 * - tcp 不可达 && owned child 存活 → starting（等待 backend）；
 * - 其余 → stopped（可安全 spawn）。
 */
export function assessGuiRuntimeReadiness(input: GuiRuntimeReadinessInput): GuiRuntimeReadinessVerdict {
  const { tcpReady, ownerFound, ownerIsTarget, ownerIdentityUnknown, appProcessRunning, ownedChildAlive } = input;
  const guiVisible = appProcessRunning || ownedChildAlive;

  if (tcpReady && ownerIsTarget) {
    if (guiVisible) {
      return {
        state: "ready",
        ready: true,
        appVisible: true,
        backendReady: true,
        conflict: null,
        detail: "应用已打开且 MCP bridge Ready（端口归属已确认）",
      };
    }
    // Ardot 等：安装树内 sidecar 可单独监听 MCP 端口，不能当成窗口已打开。
    return {
      state: "stopped",
      ready: false,
      appVisible: false,
      backendReady: true,
      conflict: null,
      detail: "MCP bridge Ready，但应用窗口未打开（可启动 GUI）",
    };
  }
  if (tcpReady && ownerFound && !ownerIsTarget) {
    return {
      state: "error",
      ready: false,
      appVisible: appProcessRunning,
      backendReady: false,
      conflict: "port-occupied-other",
      detail: ownerIdentityUnknown
        ? "backend 端口可达但无法确认归属（可能被无关进程占用），拒绝判定 ready"
        : "backend 端口被其它进程占用（非目标应用），拒绝判定 ready；不重复启动",
    };
  }
  if (tcpReady && !ownerFound) {
    // netstat 无监听结果（探测失败/刚监听竞态）：有应用进程证据才降级 ready，否则不假 ready
    if (appProcessRunning) {
      return {
        state: "ready",
        ready: true,
        appVisible: true,
        backendReady: true,
        conflict: null,
        detail: "应用已打开且 backend 端口可达（端口归属探测未返回结果，降级判定）",
      };
    }
    return {
      state: "error",
      ready: false,
      appVisible: false,
      backendReady: true,
      conflict: "port-occupied-other",
      detail: "backend 端口可达但未发现目标应用进程（可能被无关服务占用），拒绝判定 ready",
    };
  }
  if (!tcpReady && ownedChildAlive) {
    return {
      state: "starting",
      ready: false,
      appVisible: true,
      backendReady: false,
      conflict: null,
      detail: "应用启动中，等待 MCP bridge…",
    };
  }
  if (!tcpReady && appProcessRunning) {
    return {
      state: "error",
      ready: false,
      appVisible: true,
      backendReady: false,
      conflict: "gui-no-backend",
      detail: "目标应用已打开但 MCP bridge 未 Ready（插件/服务未启动或端口被占）；不重复启动第二个实例",
    };
  }
  return {
    state: "stopped",
    ready: false,
    appVisible: false,
    backendReady: false,
    conflict: null,
    detail: "应用未运行（可安全启动）",
  };
}

export interface GuiRuntimeProbeTarget {
  host: string;
  port: number;
  /** 目标可执行镜像名（如 blender.exe / Ardot.exe；大小写不敏感） */
  imageName: string;
  /**
   * 端口归属额外认可的安装目录（Windows 路径大小写不敏感）。
   * 监听进程 exe 落在该目录下即视为目标应用（Ardot MCP 实际是
   * `<Ardot>/resources/ArdotMCP/mcp-server.exe`，不是 Ardot.exe）。
   */
  ownerPathPrefixes?: string[];
  /** pid 可能为 undefined（ChildProcess 语义）；undefined 不参与归属匹配 */
  ownedChild: { pid?: number; killed: boolean } | null;
}

function normalizeWinPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isTargetImage(exePath: string | null, imageName: string): boolean {
  if (!exePath) return false;
  return basename(exePath.replace(/\\/g, "/")).toLowerCase() === imageName.toLowerCase();
}

function isUnderPrefix(exePath: string, prefix: string): boolean {
  const exe = normalizeWinPath(exePath);
  const pre = normalizeWinPath(prefix);
  return exe === pre || exe.startsWith(`${pre}/`);
}

/** 端口监听进程是否属于目标应用：主镜像名，或落在声明的安装目录下。 */
export function isTargetOwner(exePath: string | null, target: Pick<GuiRuntimeProbeTarget, "imageName" | "ownerPathPrefixes">): boolean {
  if (!exePath) return false;
  if (isTargetImage(exePath, target.imageName)) return true;
  return (target.ownerPathPrefixes ?? []).some((prefix) => isUnderPrefix(exePath, prefix));
}

/**
 * 采集分层 readiness 输入（Windows：netstat 归属 + tasklist 应用进程；均为无副作用探测）。
 * 探测顺序：先 TCP（廉价）→ 端口可达才查归属；再扫目标 GUI 镜像。
 * sidecar 归属 ≠ 窗口可见（Ardot mcp-server.exe 可单独听端口），必须单独扫主程序。
 */
export async function collectGuiRuntimeInputs(
  ops: Pick<
    ProfessionalToolPlatformOps,
    "tcpReady" | "listListeningPids" | "pidExecutablePath" | "runningPidsByImageName"
  >,
  target: GuiRuntimeProbeTarget,
): Promise<GuiRuntimeReadinessInput> {
  const ownedAlive = Boolean(target.ownedChild && !target.ownedChild.killed);
  const tcpReady = await ops.tcpReady(target.host, target.port);

  let ownerFound = false;
  let ownerIsTarget = false;
  let ownerIdentityUnknown = false;
  if (tcpReady) {
    const pids = await ops.listListeningPids(target.port);
    ownerFound = pids.length > 0;
    for (const pid of pids) {
      if (target.ownedChild && pid === target.ownedChild.pid) {
        ownerIsTarget = true;
        break;
      }
      const exe = await ops.pidExecutablePath(pid);
      if (exe == null) {
        ownerIdentityUnknown = true;
        continue;
      }
      if (isTargetOwner(exe, target)) {
        ownerIsTarget = true;
        break;
      }
    }
  }

  const pids = await ops.runningPidsByImageName(target.imageName);
  const appProcessRunning = ownedAlive || pids.length > 0;

  return { tcpReady, ownerFound, ownerIsTarget, ownerIdentityUnknown, appProcessRunning, ownedChildAlive: ownedAlive };
}
