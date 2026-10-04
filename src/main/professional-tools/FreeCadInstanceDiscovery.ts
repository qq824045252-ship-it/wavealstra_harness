/**
 * FreeCadInstanceDiscovery — blwfish/freecad-mcp 实例发现与分层 readiness 判定（纯函数，可单测）。
 *
 * 数据源：AICopilot 官方 discovery `~/.cache/freecad-mcp/instances/<uuid>.json`：
 *   { uuid, pid, socket_path, gui, label, started_at, freecad_version, freecad_binary }
 * GUI（FreeCAD.exe）与 headless（FreeCADCmd + headless_server.py）都会写 discovery，
 * `gui` 字段是区分二者的权威依据。
 *
 * 三层状态（不得把 MCP backend 当作“应用已打开”）：
 *  A. GUI application alive —— discovery 中存在 gui:true 且 PID 存活；
 *  B. AICopilot MCP backend ready —— TCP 23456 可达（GUI 与 headless 都会监听，
 *     必须结合 A 判定归属）；
 *  C. MCP stdio bridge ready —— 由 Pi 原生 MCP 层管理，本模块不判定（分层）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FreeCadInstance {
  uuid: string;
  pid: number;
  gui: boolean;
  label: string | null;
  freecadBinary: string | null;
  startedAt: number | null;
}

/** 解析单条 discovery JSON（坏行/缺字段 → null）。 */
export function parseFreeCadInstance(text: string): FreeCadInstance | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const pid = Number(raw.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      uuid: typeof raw.uuid === "string" ? raw.uuid : String(pid),
      pid,
      gui: raw.gui === true,
      label: typeof raw.label === "string" ? raw.label : null,
      freecadBinary: typeof raw.freecad_binary === "string" ? raw.freecad_binary : null,
      startedAt: typeof raw.started_at === "number" ? raw.started_at : null,
    };
  } catch {
    return null;
  }
}

/** 读取 discovery 目录全部实例（坏文件跳过）。 */
export function listFreeCadInstances(dir: string): FreeCadInstance[] {
  if (!existsSync(dir)) return [];
  const out: FreeCadInstance[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseFreeCadInstance(readFileSync(join(dir, name), "utf-8"));
      if (parsed) out.push(parsed);
    } catch {
      /* 跳过不可读文件 */
    }
  }
  return out;
}

/** PID 存活探测（Windows/Linux 通用：signal 0）。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = 不存在；EPERM = 存在但无权限（视为存活）
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type FreeCadConflictKind =
  | "headless-occupies-port" // 23456 被 headless 实例占用
  | "unknown-owner" // 23456 可达但无 discovery 可归属（外部进程）
  | "gui-no-backend" // GUI 存活但 23456 不可达/被抢占（bridge 未起来）
  | null;

export interface FreeCadReadiness {
  /** A：可见 GUI 应用存活 */
  guiAlive: boolean;
  guiPid: number | null;
  /** 存活的 headless 实例（用于冲突诊断；正常链路应避免常驻 headless） */
  headlessAlive: boolean;
  headlessPid: number | null;
  /** B：AICopilot MCP backend（TCP 23456）可达 */
  backendReady: boolean;
  conflict: FreeCadConflictKind;
  /** 面向用户/日志的清晰描述 */
  detail: string;
}

/**
 * 分层 readiness 判定（纯函数）：
 * - GUI 存活且 backend 可达 → ready（A+B 齐备）；
 * - backend 可达但无 GUI 实例 → 23456 被 headless/未知进程占用（绝不冒充 GUI ready）；
 * - GUI 存活但 backend 不可达 → GUI 已打开但 bridge 未起（端口被抢占或 addon 异常）。
 */
export function assessFreeCadReadiness(
  instances: FreeCadInstance[],
  backendReady: boolean,
  opts: { alive?: (pid: number) => boolean } = {},
): FreeCadReadiness {
  const alive = opts.alive ?? isPidAlive;
  const guiInstances = instances.filter((i) => i.gui && alive(i.pid));
  const headlessInstances = instances.filter((i) => !i.gui && alive(i.pid));
  const guiAlive = guiInstances.length > 0;
  const guiPid = guiInstances[0]?.pid ?? null;
  const headlessAlive = headlessInstances.length > 0;
  const headlessPid = headlessInstances[0]?.pid ?? null;

  let conflict: FreeCadConflictKind = null;
  let detail: string;
  if (guiAlive && backendReady) {
    detail = `FreeCAD GUI 已就绪（pid=${guiPid}），AICopilot backend 23456 Ready`;
  } else if (!guiAlive && backendReady) {
    if (headlessAlive) {
      conflict = "headless-occupies-port";
      detail = `23456 被 headless 实例占用（pid=${headlessPid}），未检测到 FreeCAD GUI；请关闭 headless 或使用 GUI 会话`;
    } else {
      conflict = "unknown-owner";
      detail = "23456 可达但未发现 FreeCAD 实例（外部进程占用端口）";
    }
  } else if (guiAlive && !backendReady) {
    conflict = "gui-no-backend";
    detail = `FreeCAD GUI 存活（pid=${guiPid}）但 AICopilot backend 未监听 23456（端口被抢占或 addon 未启动）`;
  } else if (headlessAlive) {
    conflict = "headless-occupies-port";
    detail = `仅检测到 headless 实例（pid=${headlessPid}），无 GUI；日常建模应使用可见 FreeCAD GUI`;
  } else {
    detail = "未检测到 FreeCAD 实例（GUI 与 backend 均不可用）";
  }
  return { guiAlive, guiPid, headlessAlive, headlessPid, backendReady, conflict, detail };
}
