/**
 * runtime.ts — SubagentRuntime：Task-scoped disposable worker（生命周期重构）。
 *
 * 产品语义：Subagent Instance 是父 Task 内的临时执行者。
 * - 每个实例绑定父 Task 作用域（scope = pi 会话 sessionId）；跨 Task 禁止复用。
 * - terminal（completed/failed/cancelled/timedout）或父 Task 结束时立即清理：
 *   kill worker、删除 session 文件与 transcript、从 active 注册表移除。
 * - 不保留任何跨 Task 历史；结果摘要由工具返回承载。
 *
 * 保留的底层能力（不因生命周期重构回退）：
 *   Windows node+CLI runner、Pi RPC 持久 worker、运行中 steer ack、per-record 互斥、
 *   权限只收紧不放宽、默认安全工具集、递归阻断、模型/思考三级优先级、降级重试。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { writeCacheRequestTrace } from "../../agent/CacheRequestTrace";
import {
  SubagentRegistry,
  createRecord,
  applyOutcome,
  type SubagentRecord,
  type SubagentStatus,
  type SubagentUsage,
  EMPTY_USAGE,
} from "./registry.ts";
import { spawnRpcChild, type RpcChild, type RpcEvent } from "./rpc.ts";
import { DEFAULT_SUBAGENT_TOOLS, RECURSION_TOOLS, tightenPolicy, permissionStrictness } from "./policy.ts";

export type { SubagentRecord } from "./registry.ts";

export const MAX_SUBAGENT_DEPTH = 2;
export const MAX_IDLE_WORKERS = 3;
export const IDLE_WORKER_TIMEOUT_MS = 30 * 60_000;
/**
 * 等待子进程 ready 的上限。并行上限提到 100 后，冷启动是「100 个 node 同时拉起」，
 * 15s 在慢盘/CPU 抢占下会误判启动失败，因此放宽到 45s（只影响失败判定的等待时长，
 * 正常启动仍是毫秒级就绪）。
 */
export const WORKER_START_TIMEOUT_MS = 45_000;
export const ABORT_SETTLE_GRACE_MS = 5_000;
export const TRANSCRIPT_MAX_LINES = 1000;

export interface MessageLike {
  role: string;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  model?: string;
  stopReason?: string;
}

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "timedout";
  messages: MessageLike[];
  finalText: string;
  errorMessage?: string;
  stopReason?: string;
  usage: SubagentUsage;
  model?: string;
  subagentId: string;
  workerReused: boolean;
  /** 模型解析/降级等用户可见诊断（来源见 config.ts） */
  diagnostics?: string[];
}

export interface RunPromptOptions {
  task: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (snapshot: { messages: MessageLike[]; status: SubagentStatus; finalText: string }) => void;
  systemPromptFile?: string;
  /** 最终生效模型（provider/id 限定或 null=不传）；由 index.ts 按三级优先级解析 */
  model?: string;
  /** 最终生效思考强度（pi CLI 档位或 null=不传） */
  thinking?: string;
  /** 模型/思考来源（record 持久化 + UI 诊断） */
  modelSource?: SubagentRecord["modelSource"];
  thinkingSource?: SubagentRecord["thinkingSource"];
  /** P1-2：计算 toolArgs 时的宿主 permissionMode（记录为 toolPolicyMode 收敛基准） */
  permissionMode?: string;
  toolArgs: { tools: string[] | null; excludeTools: string[] };
}

export interface SteerResult {
  ok: boolean;
  delivered: "rpc-steer" | "prompt" | "queued" | "spawned";
  message: string;
}

export interface SpawnConfig {
  /** 父 Task 作用域（pi 会话 sessionId）——跨 Task 禁止复用 */
  scope: string;
  role: SubagentRecord["role"];
  roleSource: SubagentRecord["roleSource"];
  roleDescription: string;
  /** 可选显示名（调用方已归一化；纯展示） */
  displayName?: string;
  project: string;
  sourceProject?: string;
  depth: number;
  model?: string;
  subagentId?: string;
}

interface Worker {
  recordId: string;
  child: RpcChild;
  state: "starting" | "idle" | "running";
  startedAt: number;
  lastActivity: number;
  sessionId?: string;
  sessionFile?: string;
}

function safeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "subagent";
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export class SubagentRuntime {
  private readonly registry: SubagentRegistry;
  private records: SubagentRecord[] = [];
  private readonly workers = new Map<string, Worker>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveInvocation: () => { command: string; args: string[] } | null;
  private readonly baseDir: string;
  private readonly validateModel?: (modelId: string | undefined, cwd: string) => Promise<void>;
  private shutdownGeneration = 0;
  // P2-3：per-record 串行互斥（可重入）。覆盖 runPrompt/steer/closeWorker 等
  // 生命周期操作，杜绝 closeWorker 窗口/并发调用导致同 session 双 spawn。
  private readonly lockChains = new Map<string, Promise<void>>();
  private readonly lockHolders = new Set<string>();
  // 事件推送（renderer 刷新）：registry 变化时通知
  private readonly changeListeners = new Set<() => void>();

  /**
   * per-record 互斥：同一 subagentId 的生命周期操作串行执行。
   * 同一异步上下文链内的重入（如 runPrompt 内部调用 closeWorker）直接执行，避免自死锁。
   */
  private async withRecordLock<T>(recordId: string, fn: () => Promise<T>): Promise<T> {
    if (this.lockHolders.has(recordId)) return fn(); // 重入
    const prev = this.lockChains.get(recordId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.lockChains.set(recordId, prev.then(() => next));
    await prev;
    this.lockHolders.add(recordId);
    try {
      return await fn();
    } finally {
      this.lockHolders.delete(recordId);
      release();
    }
  }

  /** 订阅 registry 变化（renderer 事件推送）；返回退订函数。 */
  onRegistryChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private notifyRegistryChange(): void {
    for (const fn of [...this.changeListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  /** 诊断辅助（测试/面板）：某 subagent 当前 worker 数（应为 0 或 1） */
  debugWorkerCount(recordId: string): number {
    return this.workers.has(recordId) ? 1 : 0;
  }

  constructor(opts: {
    baseDir: string;
    env: NodeJS.ProcessEnv;
    resolveInvocation: () => { command: string; args: string[] } | null;
    validateModel?: (modelId: string | undefined, cwd: string) => Promise<void>;
  }) {
    this.baseDir = opts.baseDir;
    this.env = opts.env;
    this.resolveInvocation = opts.resolveInvocation;
    this.validateModel = opts.validateModel;
    this.registry = new SubagentRegistry(path.join(opts.baseDir, "active.json"));
  }

  // ---------- 记录（active-only） ----------

  /**
   * 启动 GC（扩展加载时调用一次）：清理所有 Subagent 临时数据。
   * - 旧 registry.json 历史（一次性迁移）：删除其记录的 session/transcript 文件后移除文件；
   * - active.json 遗留（进程崩溃残留）：kill pid、删 session/transcript 文件；
   * - sessions/transcripts 目录内孤儿文件：全部清理（启动时无运行实例，安全）；
   * - 内存清空：本进程只从零开始创建新的 active 实例。
   */
  gcLegacy(): void {
    // 1) 旧 registry.json（持久历史时代）一次性清理
    const legacyRegistry = path.join(this.baseDir, "registry.json");
    if (fs.existsSync(legacyRegistry)) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyRegistry, "utf-8")) as {
          records?: Array<{ subagentId?: string; sessionFile?: string }>;
        };
        for (const r of raw.records ?? []) {
          if (r.sessionFile) {
            try {
              fs.rmSync(r.sessionFile, { force: true });
            } catch {
              /* ignore */
            }
          }
          if (r.subagentId) {
            try {
              fs.rmSync(path.join(this.baseDir, "transcripts", `${safeId(r.subagentId)}.jsonl`), { force: true });
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(legacyRegistry, { force: true });
      } catch {
        /* ignore */
      }
    }
    // 2) active.json 遗留（进程崩溃残留）：kill + 删文件
    for (const inst of this.registry.loadActive()) {
      if (inst.pid) {
        try {
          process.kill(inst.pid);
        } catch {
          /* ignore */
        }
      }
      if (inst.sessionFile) {
        try {
          fs.rmSync(inst.sessionFile, { force: true });
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(path.join(this.baseDir, "transcripts", `${safeId(inst.subagentId)}.jsonl`), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.registry.clearActive();
    // 3) sessions/transcripts 目录内孤儿文件
    for (const dir of ["sessions", "transcripts"]) {
      const d = path.join(this.baseDir, dir);
      try {
        for (const f of fs.readdirSync(d)) {
          try {
            fs.rmSync(path.join(d, f), { force: true });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    // 4) 内存清空（本进程从零开始）
    this.records = [];
    this.registry.saveActive([]);
  }

  get recordsSnapshot(): SubagentRecord[] {
    return [...this.records];
  }

  /**
   * 取实例。scope 传入时校验父 Task 匹配（跨 Task 禁止访问）。
   */
  get(id: string, scope?: string): SubagentRecord | undefined {
    const rec = this.records.find((r) => r.subagentId === id);
    if (!rec) return undefined;
    if (scope !== undefined && rec.scope !== scope) return undefined;
    return rec;
  }

  /** 当前 scope 的 active 实例（active-only；terminal 已移除） */
  listActive(scope: string): SubagentRecord[] {
    return this.records.filter((r) => r.scope === scope);
  }

  /**
   * 更新 record。默认仅更新已存在（不复活已被清理的实例）；
   * allowCreate=true 仅用于创建新实例（ensureSubagent）。
   */
  private upsert(patch: SubagentRecord, allowCreate = false): void {
    const i = this.records.findIndex((r) => r.subagentId === patch.subagentId);
    if (i >= 0) {
      this.records[i] = patch;
    } else if (allowCreate) {
      this.records.push(patch);
    } else {
      return; // 已被清理（cleanupTask/cleanupInstance 竞态）——丢弃更新
    }
    this.registry.saveActive(this.records);
    this.notifyRegistryChange();
  }

  ensureSubagent(cfg: SpawnConfig): SubagentRecord {
    const id = cfg.subagentId ? safeId(cfg.subagentId) : `${safeId(cfg.role)}-${shortId()}`;
    if (this.records.some((r) => r.subagentId === id)) {
      throw new Error(`subagentId ${id} 已存在；请使用新的 ID，或通过 subagent_steer 引导活动实例`);
    }
    const record = createRecord({
      subagentId: id,
      scope: cfg.scope,
      role: cfg.role,
      displayName: cfg.displayName,
      roleSource: cfg.roleSource,
      roleDescription: cfg.roleDescription,
      project: cfg.project,
      sourceProject: cfg.sourceProject,
      depth: cfg.depth,
      model: cfg.model,
    });
    this.upsert(record, true);
    return record;
  }

  /** 纯磁盘操作：追加一条 transcript 记录（真实历史，UI 读取）。subagentId 先净化防路径穿越。 */
  private appendTranscript(subagentId: string, entry: Record<string, unknown>): void {
    try {
      const safe = safeId(subagentId);
      const dir = path.join(this.baseDir, "transcripts");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safe}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", "utf-8");
      // 截断防无限增长
      const stat = fs.statSync(file);
      if (stat.size > 512 * 1024) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        const kept = lines.slice(-TRANSCRIPT_MAX_LINES);
        fs.writeFileSync(file, kept.join("\n"), "utf-8");
      }
    } catch {
      /* ignore */
    }
  }

  readTranscript(subagentId: string, limit = 500): RpcEvent[] {
    try {
      const safe = safeId(subagentId);
      const file = path.join(this.baseDir, "transcripts", `${safe}.jsonl`);
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-limit);
      const out: RpcEvent[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ---------- worker ----------

  private workerFor(record: SubagentRecord): Worker | undefined {
    return this.workers.get(record.subagentId);
  }

  private async ensureWorker(
    record: SubagentRecord,
    opts: {
      model?: string;
      thinking?: string;
      toolArgs: { tools: string[] | null; excludeTools: string[] };
      systemPromptFile?: string;
    },
  ): Promise<{ worker: Worker; reused: boolean; degraded: boolean; actualThinking?: string }> {
    const existing = this.workerFor(record);
    if (existing) {
      existing.lastActivity = Date.now();
      return { worker: existing, reused: true, degraded: false, actualThinking: undefined };
    }
    // 淘汰超龄 idle worker（LRU 上限）
    const idle = [...this.workers.values()].filter((w) => w.state === "idle");
    while (idle.length >= MAX_IDLE_WORKERS) {
      const victim = idle.sort((a, b) => a.lastActivity - b.lastActivity)[0];
      this.closeWorker(this.records.find((r) => r.subagentId === victim.recordId)?.subagentId ?? victim.recordId);
      idle.splice(0, 1);
    }
    const invocation = this.resolveInvocation();
    if (!invocation) {
      throw new Error("无法定位 pi CLI（dist/cli.js）。请设置 PI_CLI_PATH 或安装 pi。");
    }
    const sessionDir = path.join(this.baseDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });

    // The host has already admitted an explicit model. Never remove that choice
    // on startup failure: Pi's default could be outside the allowed scope.
    const buildArgs = (): string[] => {
      const args: string[] = [
        "--mode", "rpc",
        "--no-extensions",
        "--session-dir", sessionDir,
        "--session-id", record.subagentId,
        "--name", record.subagentId,
      ];
      if (opts.model) args.push("--model", opts.model);
      if (opts.thinking) args.push("--thinking", opts.thinking);
      if (opts.toolArgs.tools && opts.toolArgs.tools.length > 0) {
        args.push("--tools", opts.toolArgs.tools.join(","));
      } else if (opts.toolArgs.tools) {
        args.push("--no-tools");
      }
      if (opts.toolArgs.excludeTools.length > 0) {
        args.push("--exclude-tools", opts.toolArgs.excludeTools.join(","));
      }
      args.push("--no-approve");
      return args;
    };
    // P2-3：仅“全新 session”注入系统提示。判定不能只看 record.sessionId：
    // session 文件被清理/丢失时（用户清理 sessions 目录、换机残留 registry），
    // pi 会用同一 id 新建空 session —— 必须重新注入角色，否则子代理失忆。
    const sessionFileGone =
      record.sessionFile != null && !fs.existsSync(record.sessionFile);
    const firstSpawn = !record.sessionId || sessionFileGone;
    const spawnArgs = buildArgs();
    if (firstSpawn && opts.systemPromptFile) {
      spawnArgs.push("--append-system-prompt", opts.systemPromptFile);
    }
    const env: NodeJS.ProcessEnv = { ...this.env, PI_SUBAGENT_DEPTH: String(record.depth), MYBUDDY_SUBAGENT_POLICY_CWD: record.sourceProject ?? record.project };

    const degraded = false;
    const attemptArgs = spawnArgs;
    {
      const child = spawnRpcChild({
        command: invocation.command,
        args: [...invocation.args, ...attemptArgs],
        cwd: record.project,
        env,
        onCacheTrace: (metadata) => writeCacheRequestTrace({ ...metadata, source: 'subagent',
          sessionHash: createHash('sha256').update(record.subagentId).digest('hex'),
          parentSessionHash: createHash('sha256').update(record.scope).digest('hex') }),
      });
      const worker: Worker = {
        recordId: record.subagentId,
        child,
        state: "starting",
        startedAt: Date.now(),
        lastActivity: Date.now(),
      };
      this.workers.set(record.subagentId, worker);
      child.exited.then(() => {
        const w = this.workers.get(record.subagentId);
        if (w === worker) {
          this.workers.delete(record.subagentId);
          const rec = this.get(record.subagentId);
          if (rec) {
            this.upsert({ ...rec, pid: undefined, workerStartedAt: undefined });
          }
        }
      });
      // 等待会话就绪（先请求 get_state，再等响应；同时探测启动即崩溃）
      child.send({ type: "get_state" });
      const stateEv = await Promise.race([
        child.waitFor((ev) => ev.type === "response" && (ev as any).command === "get_state", WORKER_START_TIMEOUT_MS),
        child.exited.then((r) => r as unknown as RpcEvent | null),
      ]);
      const failed = !stateEv || stateEv.type !== "response";
      if (failed) {
        const tail = child.stderrTail.trim();
        const exit = stateEv ? String((stateEv as any).code ?? (stateEv as any).signal) : "";
        const spawnMsg = child.spawnError ? `（${child.spawnError.message}）` : "";
        child.kill();
        this.workers.delete(record.subagentId);
        throw new Error(
          `子代理 worker 启动失败（${record.subagentId}）exit=${exit || "timeout"}${spawnMsg}${tail ? `：${tail.split("\n").slice(-3).join(" | ")}` : "（无 stderr）"}`,
        );
      }
      const data = (stateEv as any).data ?? {};
      if (opts.model && `${data.model?.provider}/${data.model?.id}` !== opts.model) {
        child.kill();
        this.workers.delete(record.subagentId);
        throw new Error(`子代理实际模型与已准入模型不一致：${opts.model}`);
      }
      worker.sessionId = data.sessionId;
      worker.sessionFile = data.sessionFile;
      worker.state = "idle";
      this.upsert({
        ...(this.get(record.subagentId) ?? record), // 用最新 record（保留 resolved/toolPolicy 等）
        pid: child.pid,
        workerStartedAt: Date.now(),
        sessionId: data.sessionId ?? record.sessionId,
        sessionFile: data.sessionFile ?? record.sessionFile,
        // 实证：子进程 get_state 报告的当前模型/思考级别（诊断/UI 用）
        actualModel: (data as any).model?.id ?? undefined,
        actualThinking: (data as any).thinkingLevel ?? undefined,
        updatedAt: Date.now(),
      });
      this.appendTranscript(record.subagentId, { type: "meta", kind: "worker_start", pid: child.pid });
      return {
        worker,
        reused: false,
        degraded,
        actualThinking: (data as any).thinkingLevel ?? undefined,
      };
    }
  }

  // ---------- 运行 ----------

  async runPrompt(recordId: string, opts: RunPromptOptions): Promise<RunOutcome> {
    // P2-3：per-record 互斥（可重入：内部 closeWorker/steer 再入直接执行）
    return this.withRecordLock(recordId, () => this.runPromptLocked(recordId, opts));
  }

  private async runPromptLocked(recordId: string, opts: RunPromptOptions): Promise<RunOutcome> {
    const generation = this.shutdownGeneration;
    const record = this.get(recordId);
    // disposable 语义：实例只在运行中存在；已结束/父 Task 清理后即不存在
    if (!record) return this.failedOutcome(recordId, `subagent 已结束或不存在（${recordId}）：临时实例在 RESULT/FAILED/CANCELLED 或父 Task 结束后即销毁，请创建新的 subagent`);
    let worker = this.workerFor(record);
    // P1-1 门禁：非 idle（starting/running）状态下第二个 prompt 不得进入同一 subagent
    // （覆盖主 Agent 快速重试 / chain 连续同 id / IPC steer 与 run 交错）
    if (worker && worker.state !== "idle") {
      return this.failedOutcome(
        recordId,
        worker.state === "starting"
          ? `subagent ${recordId} 正在启动（worker 未就绪），请稍后重试`
          : `subagent ${recordId} 正在运行中（可用 subagent_steer 注入指令或等待）`,
      );
    }
    const messages: MessageLike[] = [];
    const usage: SubagentUsage = { ...EMPTY_USAGE };
    const diagnostics: string[] = [];
    let model: string | undefined = record.model;

    // P1-2：宿主 mode 变严或工具策略本身收紧（含 denyTools 配置变更）时，
    // 已存活 worker 的 --tools/--exclude-tools 是旧值 → 必须重启 worker 让新策略生效；
    // 放宽（readonly→auto 等）→ 保持旧 worker 策略，绝不自动变宽。
    const prevPolicy = record.toolPolicy;
    const prevMode = record.toolPolicyMode;
    const curMode = opts.permissionMode ?? "default";
    const policyChanged =
      prevPolicy &&
      opts.toolArgs.tools !== undefined &&
      (JSON.stringify(prevPolicy.tools ?? null) !== JSON.stringify(opts.toolArgs.tools) ||
        JSON.stringify(prevPolicy.excludeTools ?? []) !== JSON.stringify(opts.toolArgs.excludeTools));
    if (policyChanged && permissionStrictness(curMode) >= permissionStrictness(prevMode ?? "default")) {
      await this.closeWorker(recordId);
    }

    // 模型/思考配置变更检测（三级优先级解析结果 vs record.resolved*）：
    // - model 变化 → 必须重启 worker（spawn 参数）；运行中不硬切（入口门禁保证此处 idle）。
    // - thinking 变化 → idle 时优先在线 set_thinking_level（安全边界）；失败/需清除则重启。
    // - role override 不被 default 改写：opts 已按 role > default > global 解析，直接对比。
    const modelChanged = (opts.model ?? null) !== (record.resolvedModel ?? null);
    const thinkingChanged = (opts.thinking ?? null) !== (record.resolvedThinking ?? null);
    if (modelChanged) {
      await this.closeWorker(recordId);
    } else if (thinkingChanged) {
      const w = this.workerFor(record);
      if (w && w.state === "idle") {
        if (opts.thinking) {
          const ok = await w.child.setThinkingLevel(opts.thinking);
          if (!ok) await this.closeWorker(recordId);
        } else {
          // 新值 null（回默认档位）：无 unset 命令 → 重启 worker 不带 --thinking
          await this.closeWorker(recordId);
        }
      }
    }
    this.upsert({
      ...record,
      resolvedModel: opts.model ?? undefined,
      resolvedThinking: opts.thinking ?? undefined,
      modelSource: opts.modelSource,
      thinkingSource: opts.thinkingSource,
      updatedAt: Date.now(),
    });

    const emit = (status: SubagentStatus) => {
      const finalText = lastText(messages);
      opts.onUpdate?.({ messages: [...messages], status, finalText });
    };

    const onEvent = (ev: RpcEvent): void => {
      if (ev.type === "message_end") {
        const msg = (ev as any).message as MessageLike | undefined;
        if (msg && typeof msg.role === "string") {
          messages.push(msg);
          this.appendTranscript(recordId, { type: "message_end", message: msg });
          if (msg.role === "assistant") {
            usage.turns += 1;
            const u = msg.usage;
            if (u) {
              usage.input += u.input ?? 0;
              usage.output += u.output ?? 0;
              usage.cacheRead += u.cacheRead ?? 0;
              usage.cacheWrite += u.cacheWrite ?? 0;
              usage.cost += u.cost?.total ?? 0;
              if (u.totalTokens) usage.contextTokens = u.totalTokens;
            }
            if (msg.model) model = msg.model;
          }
          emit("running");
        }
      }
      if (ev.type === "tool_execution_end") {
        // 工具调用结果也进 transcript（真实历史）
        this.appendTranscript(recordId, {
          type: "tool_end",
          toolName: (ev as any).toolName,
          isError: Boolean((ev as any).isError),
        });
      }
    };

    try {
      const admit = async () => {
        opts.signal?.throwIfAborted();
        await this.validateModel?.(opts.model ?? record.resolvedModel ?? record.model, record.sourceProject ?? record.project);
        if (generation !== this.shutdownGeneration || !this.get(recordId)) throw new Error("子代理模型准入已失效");
      };
      await admit();
      const { worker: w, reused, actualThinking } = await this.ensureWorker(record, {
        model: opts.model ?? record.model,
        thinking: opts.thinking,
        toolArgs: opts.toolArgs,
        systemPromptFile: opts.systemPromptFile,
      });
      worker = w;
      await admit();
      if (opts.thinkingSource === "invocation" && opts.thinking !== (actualThinking ?? this.get(recordId)?.actualThinking)) {
        throw new Error(`子代理实际思考档位与显式请求不一致：请求 ${opts.thinking}，实际 ${actualThinking ?? this.get(recordId)?.actualThinking ?? "unknown"}`);
      }
      // 思考强度归一化诊断：pi 按模型档位归一化（如 low→high）时明确提示
      if (opts.thinking && actualThinking && actualThinking !== opts.thinking) {
        diagnostics.push(
          `思考强度 ${opts.thinking} 被 pi 归一化为 ${actualThinking}（模型可用档位限制，见「子代理」面板实证值）`,
        );
      }
      // 持久化工具策略 + 来源 mode（P1-2 收敛基准）：steer 补拉起 / 重启恢复时必须
      // 按“只允许收紧”规则处理，绝不因宿主 mode 放宽而自动放宽
      if (opts.toolArgs.tools !== undefined) {
        const recNow = this.get(recordId);
        if (recNow) {
          this.upsert({
            ...recNow,
            toolPolicy: { tools: opts.toolArgs.tools, excludeTools: opts.toolArgs.excludeTools },
            toolPolicyMode: opts.permissionMode ?? "default",
            toolPolicyAt: Date.now(),
          });
        }
      }
      // 二次门禁（ensureWorker 的 await 窗口内若已有其他 run 抢占，双保险）
      if (w.state !== "idle") {
        return this.failedOutcome(recordId, `subagent ${recordId} 正在启动/运行中（并发冲突）`);
      }
      w.state = "running";
      const recRunning = this.get(recordId);
      if (recRunning) {
        this.upsert({ ...recRunning, status: "running", lastPromptAt: Date.now(), lastTask: opts.task.slice(0, 500), updatedAt: Date.now() });
      }

      // 订阅事件：message_end 进 messages/usage/transcript；工具结束记 transcript
      const unsubscribe = w.child.addListener(onEvent);

      // 补发积压 steer（worker 死亡期间入队的指令，按序先执行）
      const pending = this.get(recordId)?.pendingSteers ?? [];
      if (pending.length > 0) {
        for (const ps of pending) {
          await admit();
          w.child.send({ type: "prompt", message: `[补发的附加指令] ${ps.text}` });
          await w.child.waitFor((ev) => ev.type === "agent_settled", 300_000);
        }
        const recPending = this.get(recordId);
        if (recPending) this.upsert({ ...recPending, pendingSteers: [] });
      }

      const started = Date.now();
      await admit();
      w.child.send({ type: "prompt", message: opts.task });
      // P2-2：初始 task/prompt 必须进 transcript（UI 渲染真实 user 条目）
      this.appendTranscript(recordId, { type: "prompt", text: opts.task });

      const settlePromise = w.child.waitFor((ev) => ev.type === "agent_settled", opts.timeoutMs);
      const exitedPromise = w.child.exited.then((r) => ({ crashed: true as const, ...r }));
      let onAbort: (() => void) | null = null;
      const abortPromise = new Promise<null>((resolve) => {
        if (!opts.signal) return;
        if (opts.signal.aborted) return resolve(null);
        onAbort = () => resolve(null);
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });

      let timedOut = false;
      let cancelled = false;
      let crashed = false;
      let crashInfo: string | null = null;
      const race: any = await Promise.race([settlePromise, abortPromise, exitedPromise]);
      unsubscribe();
      w.child.cancelWaiters(); // P2-1：race 结束后清理全部挂起 waiter（幂等）
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      if (race?.crashed) {
        // 子代理进程意外退出（非超时/中止）
        crashed = true;
        const tail = w.child.stderrTail.trim();
        crashInfo = `子代理进程意外退出（code=${String(race.code ?? "")} signal=${String(race.signal ?? "")}）${tail ? `\n${tail}` : ""}`;
        this.workers.delete(recordId);
      } else if (race === null) {
        if (opts.signal?.aborted) cancelled = true;
        else timedOut = true;
        w.child.send({ type: "abort" });
        const grace = await w.child.waitFor(
          (ev) => ev.type === "agent_settled",
          ABORT_SETTLE_GRACE_MS,
        );
        if (!grace) {
          // 强杀 worker（子代理进程级终止；session 文件保留可恢复）
          w.child.kill();
          await w.child.exited;
          this.workers.delete(recordId);
        }
      }

      const elapsed = Date.now() - started;
      w.state = "idle";
      w.lastActivity = Date.now();
      const finalText = lastText(messages);
      const lastMsg = messages.filter((m) => m.role === "assistant").at(-1);
      const stopReason = lastMsg?.stopReason ?? (cancelled ? "aborted" : timedOut ? "length" : undefined);
      let status: RunOutcome["status"] = "completed";
      let errorMessage: string | undefined;
      if (crashed) {
        status = "failed";
        errorMessage = crashInfo ?? "子代理进程意外退出";
      } else if (cancelled) {
        status = "cancelled";
        errorMessage = "子代理已取消（host abort）";
      } else if (timedOut) {
        status = "timedout";
        errorMessage = `子代理超时（>${Math.round(opts.timeoutMs / 1000)}s），已终止`;
      } else if (stopReason === "error") {
        status = "failed";
        errorMessage = lastMsg && (lastMsg as any).errorMessage ? String((lastMsg as any).errorMessage) : "子代理报错（stopReason=error）";
      }
      const outcome: RunOutcome = {
        status,
        messages,
        finalText,
        errorMessage,
        stopReason,
        usage,
        model,
        subagentId: recordId,
        workerReused: reused,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      };
      const recFinal = this.get(recordId);
      if (recFinal) {
        this.upsert(
          applyOutcome(recFinal, {
            status,
            errorMessage,
            finalText,
            stopReason,
            usage: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              cost: usage.cost,
              contextTokens: usage.contextTokens,
              turns: usage.turns,
            },
          }),
        );
      }
      this.appendTranscript(recordId, { type: "meta", kind: "run_end", status, elapsedMs: elapsed });
      // terminal：立即清理实例（disposable 语义——结果已由 outcome 返回承载）
      this.cleanupInstance(recordId);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (worker) worker.state = "idle";
      const recErr = this.get(recordId);
      if (recErr) {
        this.upsert(applyOutcome(recErr, { status: "failed", errorMessage: message }));
      }
      this.cleanupInstance(recordId);
      return this.failedOutcome(recordId, message);
    }
  }

  // ---------- steer / cancel / close ----------

  async steer(
    recordId: string,
    instruction: string,
    opts: { permissionMode?: string; resolvedModel?: string; resolvedThinking?: string; modelSource?: SubagentRecord["modelSource"]; thinkingSource?: SubagentRecord["thinkingSource"] } = {},
  ): Promise<SteerResult> {
    return this.withRecordLock(recordId, () => this.steerLocked(recordId, instruction, opts));
  }

  private async steerLocked(
    recordId: string,
    instruction: string,
    opts: { permissionMode?: string; resolvedModel?: string; resolvedThinking?: string; modelSource?: SubagentRecord["modelSource"]; thinkingSource?: SubagentRecord["thinkingSource"] } = {},
  ): Promise<SteerResult> {
    const record = this.get(recordId);
    if (!record) {
      return { ok: false, delivered: "queued", message: `subagent 已结束（${recordId}），请创建新的 subagent` };
    }
    const worker = this.workerFor(record);
    const generation = this.shutdownGeneration;
    const runningModel = record.resolvedModel ?? record.model;
    await this.validateModel?.(worker?.state === "running" ? runningModel : opts.resolvedModel ?? runningModel, record.sourceProject ?? record.project);
    if (generation !== this.shutdownGeneration || !this.get(recordId)) throw new Error("子代理模型准入已失效");
    if (worker?.state === "running" && opts.resolvedModel && opts.resolvedModel !== runningModel) {
      throw new Error("子代理运行中不能切换模型，请结束当前执行后重试");
    }
    this.upsert({ ...record, steerCount: record.steerCount + 1, updatedAt: Date.now() });
    this.appendTranscript(recordId, { type: "steer", text: instruction });

    if (!worker || worker.state === "starting") {
      // worker 不存在或正在启动：积压到 pendingSteers（不丢），就绪后补发
      const recQueued = this.get(recordId);
      if (recQueued) {
        this.upsert({
          ...recQueued,
          pendingSteers: [...recQueued.pendingSteers, { text: instruction, queuedAt: Date.now() }],
        });
      }
      return {
        ok: true,
        delivered: "queued",
        message: worker ? "worker 正在启动，指令已入队（就绪后补发）" : "worker 已退出，指令已入队（下次运行 subagent 时补发）",
      };
    }
    if (worker.state === "running") {
      const sent = worker.child.send({ type: "steer", message: instruction });
      if (!sent) return { ok: false, delivered: "queued", message: "worker 不可写，指令已入队（下次补发）" };
      // P2-6：确认 pi 接受（response success），避免显示乐观
      const ack = await worker.child.waitFor(
        (ev) => ev.type === "response" && (ev as any).command === "steer",
        3_000,
      );
      const ok = Boolean(ack && (ack as any).success !== false);
      return {
        ok,
        delivered: ok ? "rpc-steer" : "queued",
        message: ok ? "已注入（当前工具执行完成后生效）" : "pi 拒绝 steer，指令未送达（可重试）",
      };
    }
    // idle：作为新 prompt 处理。P1-2：按“只允许收紧”规则计算策略——
    // 沿用 record.toolPolicy 并经 tightenPolicy 按当前宿主 mode 收敛（永不自动变宽）
    const base =
      record.toolPolicy ?? { tools: [...DEFAULT_SUBAGENT_TOOLS], excludeTools: [...RECURSION_TOOLS] };
    const policy = tightenPolicy(base, opts.permissionMode ?? "default");
    // 模型/思考：调用方可传入重解析值（default/global 配置变更后 steer 也必须感知；
    // 运行中不硬切，idle 安全边界由 runPrompt 的变更检测处理：model 变→重启、thinking 变→在线设置）
    const outcome = await this.runPrompt(recordId, {
      task: instruction,
      timeoutMs: 300_000,
      permissionMode: opts.permissionMode ?? "default",
      toolArgs: policy,
      systemPromptFile: undefined,
      model: opts.resolvedModel ?? record.resolvedModel,
      thinking: opts.resolvedThinking ?? record.resolvedThinking,
      modelSource: opts.modelSource ?? record.modelSource,
      thinkingSource: opts.thinkingSource ?? record.thinkingSource,
    });
    return { ok: outcome.status !== "failed", delivered: "prompt", message: outcome.finalText || outcome.errorMessage || "ok" };
  }

  async cancel(recordId: string): Promise<{ ok: boolean; message: string }> {
    const record = this.get(recordId);
    if (!record) return { ok: false, message: `subagent 已结束（${recordId}），请创建新的 subagent` };
    const worker = this.workerFor(record);
    if (!worker) return { ok: false, message: "worker 未运行" };
    const ok = worker.child.send({ type: "abort" });
    return { ok, message: ok ? "已发送中止" : "worker 不可写" };
  }

  /**
   * terminal 清理（disposable 语义）：kill worker、删 session 文件与 transcript、
   * 从 active 注册表移除。结果已由 RunOutcome 返回承载，这里不留任何持久痕迹。
   */
  private cleanupInstance(recordId: string): void {
    const rec = this.get(recordId);
    const worker = this.workers.get(recordId);
    if (worker) {
      try {
        worker.child.kill();
      } catch {
        /* ignore */
      }
      this.workers.delete(recordId);
    }
    if (rec?.sessionFile) {
      try {
        fs.rmSync(rec.sessionFile, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(path.join(this.baseDir, "transcripts", `${safeId(recordId)}.jsonl`), { force: true });
    } catch {
      /* ignore */
    }
    this.records = this.records.filter((r) => r.subagentId !== recordId);
    this.registry.saveActive(this.records);
    this.notifyRegistryChange();
    // 用量归档：实例结束即追加一行 usage-archive.jsonl（MyBuddy 用量统计回填源；
    // 幂等 sub:{id}:{finishedAt}；不改变 disposable 语义——本文件只留一行 usage 快照，无会话内容）
    if (rec) this.archiveUsage(rec);
  }

  /**
   * 用量归档（cleanupInstance / cleanupTask 共用）：追加一行 usage-archive.jsonl。
   * 可靠性：单行 write + fsync（低频操作；崩溃不残留半行 → 不永久丢失）。
   */
  private archiveUsage(rec: SubagentRecord): void {
    let fd: number | null = null;
    try {
      const archivePath = path.join(this.baseDir, "usage-archive.jsonl");
      const line =
        JSON.stringify({
          subagentId: rec.subagentId,
          role: rec.role,
          scope: rec.scope,
          finishedAt: Date.now(),
          status: rec.status,
          model: rec.actualModel ?? rec.resolvedModel ?? rec.model ?? null,
          // runCount 每轮递增：key 消歧（同 id 多轮 + finishedAt 同毫秒碰撞兜底）
          runCount: rec.runCount,
          usage: rec.usage,
        }) + "\n";
      fd = fs.openSync(archivePath, "a");
      fs.writeSync(fd, line, null, "utf-8");
      fs.fsyncSync(fd);
    } catch {
      /* ignore：归档失败不影响 disposable 清理语义 */
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * 父 Task 结束清理：该 scope 下所有 child 实例立即终止并移除（防止 orphan process/session）。
   * 正在 runPrompt 的实例由 worker kill + 文件删除兜底；其后续更新因 record 已移除而被丢弃
   * （upsert 空安全）。
   */
  cleanupTask(scope: string): void {
    const scopeRecords = this.records.filter((r) => r.scope === scope);
    if (scopeRecords.length === 0) {
      this.registry.saveActive(this.records);
      return;
    }
    for (const rec of scopeRecords) {
      const worker = this.workers.get(rec.subagentId);
      if (worker) {
        try {
          worker.child.kill();
        } catch {
          /* ignore */
        }
        this.workers.delete(rec.subagentId);
      }
      if (rec.sessionFile) {
        try {
          fs.rmSync(rec.sessionFile, { force: true });
        } catch {
          /* ignore */
        }
      }
      // 父 Task 结束清理前先归档 usage（否则 disposable 删除后永久丢失）
      this.archiveUsage(rec);
      try {
        fs.rmSync(path.join(this.baseDir, "transcripts", `${safeId(rec.subagentId)}.jsonl`), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.records = this.records.filter((r) => r.scope !== scope);
    this.registry.saveActive(this.records);
    this.notifyRegistryChange();
  }

  async closeWorker(recordId: string): Promise<void> {
    return this.withRecordLock(recordId, () => this.closeWorkerLocked(recordId));
  }

  private async closeWorkerLocked(recordId: string): Promise<void> {
    const worker = this.workers.get(recordId);
    if (!worker) return;
    worker.child.closeStdin();
    const timeout = setTimeout(() => null, 3_000);
    timeout.unref?.(); // P2-6：不残留保活 timer
    const exited = await Promise.race([worker.child.exited, timeout]);
    if (!exited) worker.child.kill();
    worker.child.cancelWaiters();
    this.workers.delete(recordId);
    const rec = this.get(recordId);
    if (rec) this.upsert({ ...rec, pid: undefined, workerStartedAt: undefined });
  }

  shutdownAll(): void {
    this.shutdownGeneration++;
    for (const [id, worker] of this.workers) {
      try {
        worker.child.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      try {
        worker.child.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.workers.delete(id);
    }
  }

  private failedOutcome(subagentId: string, errorMessage: string): RunOutcome {
    return {
      status: "failed",
      messages: [],
      finalText: "",
      errorMessage,
      usage: { ...EMPTY_USAGE },
      subagentId,
      workerReused: false,
    };
  }
}

function lastText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      for (const part of m.content) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

export { lastText };
