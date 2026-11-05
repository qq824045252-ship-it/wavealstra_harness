/**
 * TerminalHost — 右侧扩展栏「终端」主进程宿主（P0）
 *
 * 职责（按 owner 维护 TerminalSession/PTY，owner = task | workspace）：
 *  - spawn / attach / restart / close / dispose 生命周期
 *  - 上下文切换 PTY 保活：切走不杀，切回 attach 时回放 ring buffer 尾部
 *  - 大输出处理：有界 ring buffer（字节上限）+ 有序 chunk batching，
 *    避免每小块直发 IPC 打爆 Renderer
 *  - Chat Context Source：tail() 供「最近输出 → 加入对话」
 *
 * 安全边界：
 *  - task 终端 cwd 唯一权威 = deps.resolveCwd（AgentService.resolveTaskExecutionWorkspaceCwd 等价入口），
 *    Renderer 只传 taskId，绝不接收任意路径
 *  - workspace 终端 cwd 唯一权威 = deps.resolveWorkspaceCwd（工作空间绑定的真实文件夹）：
 *    未绑定/文件夹不可用时抛错，绝不静默回退到任意目录
 *  - shell 优先 terminalShellPath 终端偏好（deps.getShellPath），失败平台默认
 *  - env 复用 applyShellIsolationSpawnContext 的「任务根注入 + os-sandbox env 清理」，
 *    但不把用户终端纳入 Agent 写路径限制（两者执行通道独立）
 *  - node-pty 惰性加载；ptyFactory 可注入（单测用 fake pty，不依赖真实 shell）
 *
 * 输出顺序保证：data 全部走同一 send 通道；open/attach 的回放块在 handler 内
 * 同步发送，之后 pty 实时输出才可能到达 → 同一通道内顺序不乱、无重复。
 */
import { randomUUID } from "node:crypto";
import {
  TerminalIpc,
  ownerFromIds,
  type TerminalCloseRequest,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalExitReason,
  type TerminalInputRequest,
  type TerminalOpenRequest,
  type TerminalOwnerIds,
  type TerminalResizeRequest,
  type TerminalSessionInfo,
  type TerminalTailRequest,
  type TerminalTailResult,
} from "../../shared/terminal-ipc";
import { applyShellIsolationSpawnContext } from "../security/TaskExecutionIsolation";
import { ByteBoundedRingBuffer } from "./RingBuffer";
import { prependEnvPath } from "./terminal-env";
import { canonicalPathKey } from "../platform/paths";
import { defaultShellForPlatform, terminateTerminalProcess, useConpty } from "../platform/terminal";

import { TerminalScreen, type TerminalScreenResult } from "./TerminalScreen";

/** 每 owner ring buffer 字节上限（256KB） */
export const DEFAULT_RING_MAX_BYTES = 256 * 1024;
/** 实时输出 flush 周期（25ms） */
export const DEFAULT_FLUSH_INTERVAL_MS = 25;
/** 待发字节达到该值提前 flush（避免大输出撑爆单条消息） */
export const DEFAULT_FLUSH_MAX_BYTES = 64 * 1024;
/** open/attach 回放单条 data 消息最大字符数 */
export const REPLAY_CHUNK_CHARS = 128 * 1024;

/* ------------------------------------------------------------------ */
/* 可注入接口（fake pty 单测）                                          */
/* ------------------------------------------------------------------ */

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly pid?: number;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyLike;

export type TerminalHostSend = (channel: string, payload: unknown) => void;

/**
 * 终端所有者：任务终端（原有）或空间终端（空间绑定文件夹）。
 * 会话 map 以 ownerKey 为键；同一 owner 复用一个保活会话。
 */
export type TerminalOwner =
  | { kind: "task"; id: string; terminalId?: string }
  | { kind: "workspace"; id: string; terminalId?: string };

export function ownerKeyOf(owner: TerminalOwner): string {
  const sub = owner.terminalId ? `:${owner.terminalId}` : "";
  return (owner.kind === "task" ? `task:${owner.id}` : `ws:${owner.id}`) + sub;
}

/** 路径重绑审计：Windows 大小写/尾分隔符差异不应误判为 cwd 变化。 */
export function sameTerminalCwd(left: string, right: string): boolean {
  const normalize = (value: string): string => canonicalPathKey(value);
  return normalize(left) === normalize(right);
}

/** 从 IPC 请求派生 owner；taskId 优先（兼容旧调用），workspaceId 次之；两者皆无返回 null */
export function ownerFromRequest(req: TerminalOwnerIds): TerminalOwner | null {
  return ownerFromIds(req);
}

export const WORKSPACE_FOLDER_UNBOUND = "当前空间尚未绑定文件夹";
export const WORKSPACE_FOLDER_UNAVAILABLE = "当前空间绑定的文件夹不可用，请重新绑定";
export const WORKSPACE_NOT_FOUND = "工作空间不存在";

/**
 * 空间终端 cwd 权威解析：只接受已绑定且当前可用的真实文件夹。
 * 未绑定 / 丢失 / 不是目录 → 抛错，绝不静默回退到 home / C:\ / 隔离目录。
 */
export function resolveBoundWorkspaceCwd(
  space: { path?: string | null; pathMissing?: boolean } | null | undefined,
  isDirectory: (path: string) => boolean,
): string {
  if (!space) throw new Error(WORKSPACE_NOT_FOUND);
  const folder = space.path?.trim() ?? "";
  if (!folder) throw new Error(WORKSPACE_FOLDER_UNBOUND);
  if (space.pathMissing || !isDirectory(folder)) {
    throw new Error(WORKSPACE_FOLDER_UNAVAILABLE);
  }
  return folder;
}

export interface TerminalHostDeps {
  /** 任务工作目录唯一权威解析（可抛错，如任务已删除） */
  resolveCwd: (taskId: string) => string;
  /**
   * 空间工作目录唯一权威解析（本阶段新增）：返回该空间绑定的真实文件夹。
   * 未绑定文件夹必须抛错 —— workspace 终端绝不静默回退到隔离目录/home/C:\。
   */
  resolveWorkspaceCwd?: (workspaceId: string) => string;
  /** Interactive terminal preference; undefined uses the platform default. */
  getShellPath?: (cwd: string) => string | undefined;
  /** 当前 Shell 隔离等级（默认 cwd-only 语义：仅注入任务根标记，不做写路径限制） */
  getIsolationLevel?: () => unknown;
  /** MyBuddy-managed CLI PATH prefixes for this terminal only. */
  getPathEntries?: () => string[];
  /** 测试注入 fake pty；缺省惰性 require node-pty */
  ptyFactory?: PtyFactory;
  ringMaxBytes?: number;
  flushIntervalMs?: number;
  flushMaxBytes?: number;
}

interface TerminalSession {
  owner: TerminalOwner;
  sessionId: string;
  pty: PtyLike | null;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  exitReason: TerminalExitReason | null;
  startedAt: number;
  /** 由宿主主动 kill（close/restart/dispose）→ exit 事件 reason=killed/disposed */
  killRequested: boolean;
  ring: ByteBoundedRingBuffer;
  pending: string[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  screen?: TerminalScreen;
}

/** 平台默认 shell（Windows 优先 pwsh，回退 powershell.exe）——实现见 platform/terminal。 */
export { defaultShellForPlatform };

export class TerminalHost {
  private readonly deps: Required<TerminalHostDeps>;
  private readonly sessions = new Map<string, TerminalSession>();
  private send: TerminalHostSend = () => {};

  constructor(deps: TerminalHostDeps) {
    this.deps = {
      resolveCwd: deps.resolveCwd,
      resolveWorkspaceCwd: deps.resolveWorkspaceCwd ?? (() => {
        throw new Error("workspace 终端未配置 resolveWorkspaceCwd");
      }),
      getShellPath: deps.getShellPath ?? (() => undefined),
      getIsolationLevel: deps.getIsolationLevel ?? (() => "cwd-only"),
      getPathEntries: deps.getPathEntries ?? (() => []),
      ptyFactory:
        deps.ptyFactory ??
        ((options: PtySpawnOptions) => {
          // 惰性加载：仅在真实 spawn 时 require，单测注入 fake 后永不触碰原生模块
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pty = require("node-pty") as {
            spawn(file: string, args: string[], forkOptions: unknown): PtyLike;
          };
          return pty.spawn(options.file, options.args, {
            name: options.name,
            cols: options.cols,
            rows: options.rows,
            cwd: options.cwd,
            env: options.env,
            useConpty: useConpty(),
          });
        }),
      ringMaxBytes: deps.ringMaxBytes ?? DEFAULT_RING_MAX_BYTES,
      flushIntervalMs: deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      flushMaxBytes: deps.flushMaxBytes ?? DEFAULT_FLUSH_MAX_BYTES,
    };
  }

  /** index.ts 注入：main → renderer 投递（data/exit 事件） */
  setSend(send: TerminalHostSend): void {
    this.send = send;
  }

  /** 供单测/审计只读检查 */
  sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(owner: TerminalOwner): boolean {
    return this.sessions.has(ownerKeyOf(owner));
  }

  getInfo(owner: TerminalOwner): TerminalSessionInfo | null {
    const session = this.sessions.get(ownerKeyOf(owner));
    if (!session) return null;
    return this.toInfo(session);
  }

  async readScreen(req: { owner: TerminalOwner }): Promise<TerminalScreenResult | null> {
    const session = this.sessions.get(ownerKeyOf(req.owner));
    if (!session || !session.screen) return null;
    return session.screen.read();
  }

  /**
   * 打开（spawn 或 attach）：
   * - 存活会话 → 回放 ring 尾部（data 事件），更新尺寸，返回信息
   * - 死亡/不存在 → spawn 新会话
   * resolveCwd / resolveWorkspaceCwd 抛错（任务已删除 / 空间未绑定文件夹）→ 异常向上抛，invoke 拒绝。
   */
  open(req: TerminalOpenRequest, trackScreen?: boolean): TerminalSessionInfo {
    const owner = ownerFromRequest(req);
    if (!owner) throw new Error("terminal:open 必须提供 taskId 或 workspaceId");
    const key = ownerKeyOf(owner);
    const existing = this.sessions.get(key);
    // Workspace 可以被重新绑定到另一真实目录。不能仅按 workspaceId 复用旧 PTY，
    // 否则 UI 已指向新项目而 shell 仍停在旧仓库。每次 attach 都重新解析权威 cwd。
    const resolvedCwd = this.resolveOwnerCwd(owner);
    if (existing?.alive && existing.pty && sameTerminalCwd(existing.cwd, resolvedCwd)) {
      this.resizePty(existing, req.cols, req.rows);
      this.replay(existing);
      return this.toInfo(existing);
    }
    if (existing) this.killSession(existing, "killed");
    const session = this.spawn(owner, req.cols, req.rows, resolvedCwd, trackScreen);
    return this.toInfo(session);
  }

  /** 杀当前会话并 spawn 新会话（新 sessionId、清空 ring） */
  restart(req: TerminalOpenRequest, trackScreen?: boolean): TerminalSessionInfo {
    const owner = ownerFromRequest(req);
    if (!owner) throw new Error("terminal:restart 必须提供 taskId 或 workspaceId");
    const key = ownerKeyOf(owner);
    const existing = this.sessions.get(key);
    if (existing) this.killSession(existing, "killed");
    return this.toInfo(this.spawn(owner, req.cols, req.rows, undefined, trackScreen));
  }

  input(req: TerminalInputRequest): boolean {
    const owner = ownerFromRequest(req);
    if (!owner) return false;
    const session = this.sessions.get(ownerKeyOf(owner));
    if (!session?.alive || !session.pty || session.sessionId !== req.sessionId) return false;
    try {
      session.pty.write(req.data);
      return true;
    } catch {
      return false;
    }
  }

  resize(req: TerminalResizeRequest): boolean {
    const owner = ownerFromRequest(req);
    if (!owner) return false;
    const session = this.sessions.get(ownerKeyOf(owner));
    if (!session?.alive || session.sessionId !== req.sessionId || !session.pty) return false;
    return this.resizePty(session, req.cols, req.rows);
  }

  release(owner: TerminalOwner): void {
    const key = ownerKeyOf(owner);
    const session = this.sessions.get(key);
    if (!session) return;
    this.killSession(session, "killed");
    this.sessions.delete(key);
  }

  close(req: TerminalCloseRequest): void {
    const owner = ownerFromRequest(req);
    if (!owner) return;
    if (owner.terminalId) {
      const session = this.sessions.get(ownerKeyOf(owner));
      if (session) this.killSession(session, "killed");
      return;
    }
    for (const session of Array.from(this.sessions.values())) {
      if (session.owner.kind === owner.kind && session.owner.id === owner.id) {
        this.killSession(session, "killed");
      }
    }
  }

  /** 有界最近输出（Chat Context Source）；无会话返回空 */
  tail(req: TerminalTailRequest): TerminalTailResult {
    const owner = ownerFromRequest(req);
    if (!owner) return { sessionId: null, text: "", truncated: false };
    const session = this.sessions.get(ownerKeyOf(owner));
    if (!session) return { sessionId: null, text: "", truncated: false };
    const budget = Math.max(1, Math.min(req.maxBytes ?? 8 * 1024, 1024 * 1024));
    const text = session.ring.tailBounded(budget);
    const truncated = session.ring.dropped > 0 || session.ring.size > budget;
    return { sessionId: session.sessionId, text, truncated };
  }

  /** App before-quit：kill 全部 PTY（不投递事件） */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.flushTimer = null;
      session.screen?.dispose();
      session.screen = undefined;
      if (session.pty && !session.killRequested) {
        session.killRequested = true;
        try {
          terminateTerminalProcess(session.pty);
        } catch {
          /* ignore */
        }
      }
      session.alive = false;
      session.exitReason = "disposed";
    }
    this.sessions.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 内部实现                                                            */
  /* ------------------------------------------------------------------ */

  private spawn(owner: TerminalOwner, cols: number, rows: number, resolvedCwd?: string, trackScreen?: boolean): TerminalSession {
    // 1) 权威 cwd：失败（任务不存在 / 空间未绑定文件夹）→ 抛错，不降级
    const cwd = resolvedCwd ?? this.resolveOwnerCwd(owner);
    // 2) shell：terminalShellPath 终端偏好 → 平台默认
    let shell: string;
    try {
      shell = this.deps.getShellPath?.(cwd)?.trim() || defaultShellForPlatform();
    } catch {
      shell = defaultShellForPlatform();
    }
    // 3) env：任务根注入 + os-sandbox env 清理（不引入写路径限制）
    const level = this.deps.getIsolationLevel?.() ?? "cwd-only";
    const isolatedEnv = applyShellIsolationSpawnContext(level, cwd, {
      command: "terminal",
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    }).env;
    const env = prependEnvPath(isolatedEnv, this.deps.getPathEntries());

    const session: TerminalSession = {
      owner,
      sessionId: randomUUID(),
      pty: null,
      cwd,
      shell,
      cols,
      rows,
      alive: false,
      exitCode: null,
      exitReason: null,
      startedAt: Date.now(),
      killRequested: false,
      ring: new ByteBoundedRingBuffer(this.deps.ringMaxBytes),
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      screen: trackScreen ? new TerminalScreen(cols, rows) : undefined,
    };

    let pty: PtyLike;
    try {
      pty = this.deps.ptyFactory({
        file: shell,
        args: [],
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch (error) {
      // shell 不可执行等：记录 spawn-failed 会话，投递 exit 事件，renderer 显示可重启状态
      session.exitReason = "spawn-failed";
      session.exitCode = null;
      this.sessions.set(ownerKeyOf(owner), session);
      this.emitExit(session);
      return session;
    }

    session.pty = pty;
    session.alive = true;
    this.sessions.set(ownerKeyOf(owner), session);

    pty.onData((data) => {
      if (session.killRequested || this.sessions.get(ownerKeyOf(owner)) !== session) return;
      session.ring.push(data);
      session.pending.push(data);
      session.pendingBytes += Buffer.byteLength(data, "utf8");
      session.screen?.write(data);
      this.scheduleFlush(session);
    });
    pty.onExit((event) => {
      session.alive = false;
      session.exitCode = event.exitCode;
      session.exitReason = session.killRequested ? "killed" : "exit";
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
        session.flushTimer = null;
      }
      // 退出前先冲刷待发输出，避免最后 <=25ms 的数据丢失；
      // flushSession 幂等（pending 为空则不发），与 exit 事件同栈有序，无重复。
      this.flushSession(session);
      this.emitExit(session);
    });
    return session;
  }

  /** owner → 权威 cwd；错误向上抛（不降级） */
  private resolveOwnerCwd(owner: TerminalOwner): string {
    if (owner.kind === "task") return this.deps.resolveCwd(owner.id);
    return this.deps.resolveWorkspaceCwd(owner.id);
  }

  private resizePty(session: TerminalSession, cols: number, rows: number): boolean {
    const nextCols = Math.max(2, Math.floor(cols) || session.cols);
    const nextRows = Math.max(1, Math.floor(rows) || session.rows);
    if (nextCols === session.cols && nextRows === session.rows) return true;
    try {
      session.pty?.resize(nextCols, nextRows);
      session.screen?.resize(nextCols, nextRows);
      session.cols = nextCols;
      session.rows = nextRows;
      return true;
    } catch {
      return false;
    }
  }

  private killSession(session: TerminalSession, reason: "killed" | "disposed"): void {
    const alreadyClosing = session.killRequested;
    session.killRequested = true;
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    session.screen?.dispose();
    session.screen = undefined;
    if (alreadyClosing) return;
    if (session.pty) {
      try { terminateTerminalProcess(session.pty); } catch { /* 进程已退出 */ }
    }
    // onExit 会置 alive=false 并投递 exit 事件（reason=killed）；这里兜底（fake pty 可能不同步触发）
    if (session.alive && reason === "disposed") {
      session.alive = false;
    }
    if (reason === "killed") {
      // 兜底：若 1500ms 后 onExit 仍未被触发（如平台 ConPTY 僵死），强制置 alive=false 并投递 exit，避免主进程残留
      setTimeout(() => {
        if (session.alive) {
          session.alive = false;
          session.exitCode = session.exitCode ?? -1073741510;
          session.exitReason = "killed";
          this.emitExit(session);
        }
      }, 1500).unref();
    }
  }

  /** 回放 ring 尾部：同步分块发送（顺序保证见文件头注释） */
  private replay(session: TerminalSession): void {
    const tail = session.ring.tail();
    if (!tail) return;
    for (let i = 0; i < tail.length; i += REPLAY_CHUNK_CHARS) {
      this.emitData(session, tail.slice(i, i + REPLAY_CHUNK_CHARS));
    }
  }

  private scheduleFlush(session: TerminalSession): void {
    if (session.flushTimer) return;
    if (session.pendingBytes >= this.deps.flushMaxBytes) {
      this.flushSession(session);
      return;
    }
    session.flushTimer = setTimeout(() => this.flushSession(session), this.deps.flushIntervalMs);
  }

  private flushSession(session: TerminalSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending.length === 0) return;
    const data = session.pending.join("");
    session.pending = [];
    session.pendingBytes = 0;
    this.emitData(session, data);
  }

  private emitData(session: TerminalSession, data: string): void {
    const payload: TerminalDataEvent = { ...sessionOwnerIds(session), sessionId: session.sessionId, data };
    this.send(TerminalIpc.data, payload);
  }

  private emitExit(session: TerminalSession): void {
    const payload: TerminalExitEvent = {
      ...sessionOwnerIds(session),
      sessionId: session.sessionId,
      exitCode: session.exitCode,
      reason: session.exitReason ?? "exit",
    };
    this.send(TerminalIpc.exit, payload);
  }

  private toInfo(session: TerminalSession): TerminalSessionInfo {
    return {
      ...sessionOwnerIds(session),
      sessionId: session.sessionId,
      cwd: session.cwd,
      shell: session.shell,
      alive: session.alive,
      exitCode: session.exitCode,
      exitReason: session.exitReason,
      startedAt: session.startedAt,
    };
  }
}

/** 从 session.owner 生成事件/Info 中的 owner id 字段 */
function sessionOwnerIds(session: TerminalSession): TerminalOwnerIds {
  const ids: TerminalOwnerIds =
    session.owner.kind === "task" ? { taskId: session.owner.id } : { workspaceId: session.owner.id };
  if (session.owner.terminalId) {
    ids.terminalId = session.owner.terminalId;
  }
  return ids;
}
